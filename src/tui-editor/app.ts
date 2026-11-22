import { handleTerminalCommand, wheelDirection } from '@/tui-pi/terminal-actions';
import { UnsavedPrompt } from './components/unsaved-prompt';
import { DecisionQueue } from '@/tui-pi/decision-queue';
import { ChatSessionPresenter } from '@/tui-pi/chat-session-presenter';
/**
 * OctipusEditorApp — pi-tui-based editor + chat surface.
 *
 * Wiring:
 *   - LayoutStore drives pane visibility + focus
 *   - BufferStore drives the open files / active buffer
 *   - WorkspaceStore tracks the active workspace slug for the gateway
 *   - GatewayAdapter wraps the WebSocket protocol the chat shell
 *     also uses; the chat pane consumes its events directly
 *
 * Phase 5 ships a working skeleton: open files via Ctrl+O picker
 * (deferred to Phase 5.x; for now use --project to seed the tree),
 * edit + save (Ctrl+S), toggle panes (Ctrl+B / Ctrl+J), cycle focus
 * (Ctrl+\), cycle buffers (Ctrl+Tab / Ctrl+Shift+Tab), close buffer
 * (Ctrl+W). Vim mode and the diff overlay come in Phase 5.x once
 * this scaffold proves out.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Container, getKeybindings, matchesKey, type OverlayHandle, type OverlayOptions, Spacer, type TUI } from '@/tui-kit';
import { loadOctipusKeybindings } from '@/tui-pi/keybindings';
import { installEditorKeybindings } from './keybindings';
import { ExternalChangePrompt } from './components/external-change-prompt';
import { SaveAsPrompt } from './components/save-as-prompt';
import type { VimCommand } from './editor/vim';
import { ApiClient } from './api-client';
import { ChatPane } from './components/chat-pane';
import { dropSource, installTreeSitterHighlighter, setSource as treeSitterSetSource } from './editor/highlight-tree-sitter';
import { DiffOverlay } from './components/diff-overlay';
import { FilePicker } from './components/file-picker';
import { FileTree } from './components/file-tree';
import { FindOverlay } from './components/find-overlay';
import { HotkeysOverlay } from './components/hotkeys-overlay';
import { MCPServerList, bridgeProvider } from './components/mcp-server-list';
import { ModeBar } from './components/mode-bar';
import { ReplaceOverlay } from './components/replace-overlay';
import { SplitPane } from './components/split-pane';
import { TabStrip } from './components/tab-strip';
import { TextEditor } from './components/text-editor';
import { WorkspacePicker } from './components/workspace-picker';
import { loadPersistedState, pathForProject, savePersistedState } from './persist';
import { type BufferRecord, BufferStore } from './stores/buffer-store';
import { LayoutStore } from './stores/layout-store';
import { bindStore } from './stores/use-store';
import { WorkspaceStore, type WorkspaceMeta } from './stores/workspace-store';
import { checkDisk, readFileForBuffer, writeFileForBuffer } from './workspace-fs-bridge';
import { StatusBar } from '@/tui-pi/components/status-bar';
import { GatewayAdapter, type AgentSessionEvent } from '@/tui-pi/gateway-adapter';
import { createOverlayController, type OverlayController } from '@/tui-pi/overlays/registry';
import { inlineUiFallbackText } from '@/shared/inline-ui/fence';

export interface OctipusEditorAppOptions {
  gatewayUrl?: string;
  exit?: (code: number) => void;
  projectPath?: string;
  /**
   * Optional shutdown hook for /exit, /quit, and Ctrl+Q: the runtime restores
   * the terminal and drains stdin. Without it the editor calls process.exit()
   * with the terminal still in raw mode.
   */
  onShutdown?: () => Promise<void>;
}

function newSessionId(): string {
  return randomUUID();
}

export class OctipusEditorApp {
  readonly tui: TUI;
  readonly adapter: GatewayAdapter;
  readonly layout = new LayoutStore();
  readonly buffers = new BufferStore();
  readonly workspace = new WorkspaceStore();

  private readonly status = new StatusBar();
  private readonly tabs: TabStrip;
  private readonly modeBar: ModeBar;
  private readonly editor: TextEditor;
  private readonly tree: FileTree;
  private readonly chat: ChatPane;
  private readonly split: SplitPane;
  private readonly overlays: OverlayController;
  private readonly session: ChatSessionPresenter;
  private readonly decisions: DecisionQueue;
  private readonly sessionId = newSessionId();
  private readonly projectPath: string;
  private paletteHandle: OverlayHandle | null = null;
  private filePickerHandle: OverlayHandle | null = null;
  private findHandle: OverlayHandle | null = null;
  private replaceHandle: OverlayHandle | null = null;
  private diffHandle: OverlayHandle | null = null;
  private diffQueue: Array<{ bufferId: string; label: string; before: string; after: string }> = [];
  private workspaceHandle: OverlayHandle | null = null;
  private mcpHandle: OverlayHandle | null = null;
  private hotkeysHandle: OverlayHandle | null = null;
  private apiClient: ApiClient;
  private unsavedHandle: OverlayHandle | null = null;
  private exiting = false;
  private readonly exit: (code: number) => void;
  private mcpPoll: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onShutdown?: () => Promise<void>;
  /** Overlays whose content is still being fetched: a second key press must not open a second one. */
  private loading = new Set<'workspace' | 'mcp'>();
  private externalHandle: OverlayHandle | null = null;
  private saveAsHandle: OverlayHandle | null = null;
  /** Debounced re-parse per buffer, and the text version each last parsed. */
  private parseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private parsedVersion = new Map<string, number>();
  /** Everything to release on shutdown: store subscriptions, input listeners, the adapter listener. */
  private readonly disposers: Array<() => void> = [];

  constructor(tui: TUI, options: OctipusEditorAppOptions) {
    this.tui = tui;
    this.exit = options.exit ?? (code => process.exit(code));
    installEditorKeybindings();
    this.adapter = new GatewayAdapter({
      url: options.gatewayUrl,
      getWorkspace: () => this.workspace.get().activeSlug,
      getSessionId: () => this.sessionId,
    });
    this.projectPath = options.projectPath ? resolve(options.projectPath) : process.cwd();
    this.onShutdown = options.onShutdown;
    this.overlays = createOverlayController(tui);
    this.decisions = new DecisionQueue(this.overlays, this.adapter, text => this.pushMessage('system', text), () => { if (!tui.hasOverlay?.()) this.refocus(); });
    // The API base URL mirrors the gateway URL but on HTTP. Best-effort —
    // fetches return null on failure and the overlays cope.
    this.apiClient = new ApiClient({
      baseUrl: deriveApiBase(options.gatewayUrl),
      workspaceStore: this.workspace,
    });

    this.tabs = new TabStrip(this.buffers);
    this.editor = new TextEditor(this.buffers, {
      onSave: (record) => { this.saveBuffer(record.id); },
      onVimCommand: (command, record) => this.runVimCommand(command, record.id),
      onNotice: (text) => { this.modeBar.setNotice(text); this.tui.requestRender(); },
      layout: this.layout,
    });
    this.modeBar = new ModeBar(this.layout, this.buffers, {
      getVimMode: () => this.editor.getVimState().mode,
      getVimCommandLine: () => this.editor.getVimState().commandLine,
    });
    this.tree = new FileTree({
      root: this.projectPath,
      onOpen: (path) => this.openFile(path),
    });
    this.chat = new ChatPane({
      tui,
      basePath: this.projectPath,
      onSubmit: (text) => this.handleChatSubmit(text),
    });
    this.session = new ChatSessionPresenter(tui, this.adapter, this.chat.messages, this.status, this.chat.activity, this.chat.subagents, (role, content) => this.pushMessage(role, content));
    this.chat.messages.push({
      role: 'system',
      content: `Welcome to Octipus. Project: ${basenameOf(this.projectPath)}  Type a message or /help. Wheel: scroll · Shift+drag: select · /copy last: copy reply.`,
      timestamp: new Date(),
    });

    this.split = new SplitPane({
      layout: this.layout,
      tree: this.tree,
      editor: buildEditorPane(this.tabs, this.editor),
      chat: this.chat,
      onResize: (_sizes) => {
        const paneRows = Math.max(0, tui.terminal.rows - this.status.render(tui.terminal.columns).length - 2);
        this.editor.setHeight(Math.max(1, paneRows - 1));
        this.tree.setHeight(paneRows);
        this.chat.setHeight(paneRows);
      },
    });

    // Status rows on top (up to a third of the screen); the mode bar is the single bottom row.
    this.status.setProject(basenameOf(this.projectPath));
    const status = this.status;
    const root = new class extends Container {
      override render(width: number): string[] { status.setMaxRows(Math.max(1, Math.floor(tui.terminal.rows / 3))); return super.render(width).slice(0, tui.terminal.rows); }
    }();
    root.addChild(this.status);
    root.addChild(this.split);
    root.addChild(this.modeBar);
    tui.addChild(root);
    tui.setFocus(this.editor);

    // Re-render whenever any store updates so dirty markers, tabs, mode bar etc. stay current.
    this.disposers.push(
      bindStore(this.buffers, this.tabs,    tui),
      bindStore(this.buffers, this.modeBar, tui),
      bindStore(this.layout,  this.modeBar, tui),
      bindStore(this.layout,  this.split,   tui),
      // Global hotkeys (Phase 6 will move these into keybindings.json).
      tui.addInputListener((data) => this.handleGlobalKey(data)),
      // Re-parse highlighting after edits; forget the parse of a closed buffer.
      this.buffers.subscribe((state) => this.scheduleParses(state.buffers)),
    );

    // Keep terminal size in the layout store (for editor scroll math + future overlay sizing).
    this.layout.setSize(tui.terminal.columns, tui.terminal.rows);
    this.disposers.push(this.layout.subscribe(() => { if (!this.tui.hasOverlay()) this.refocus(); }));

    // Restore persisted state — failures are non-fatal (defaults applied).
    this.hydrate();

    this.disposers.push(this.adapter.on((event) => this.handleEvent(event)));

    // Poll MCP bridge for status — the bridge emits events but the
    // surface area is small enough that a 10s poll keeps the wiring
    // trivial. Failures are silent (no MCP installed / not loaded yet).
    void this.refreshMcpStatus();
    this.mcpPoll = setInterval(() => { void this.refreshMcpStatus(); }, 10_000);
    this.mcpPoll.unref?.();
  }

  private async refreshMcpStatus(): Promise<void> {
    try {
      const { getMCPBridge } = await import('@/mcp/bridge');
      const bridge = getMCPBridge();
      const all = bridge.getAllConnections();
      this.status.setMcp({
        connected: all.filter((c) => c.status === 'connected').length,
        total: all.length,
      });
      this.tui.requestRender();
    } catch {
      this.status.setMcp(null);
    }
  }

  async start(): Promise<void> {
    // Install the tree-sitter highlighter eagerly. The setHighlighter
    // call is synchronous; grammar loads happen lazily on first
    // `setSource` and silently fall back to the regex highlighter on
    // failure, so this never blocks startup.
    installTreeSitterHighlighter();
    this.tui.start();
    try {
      await this.adapter.connect();
    } catch (error) {
      // Put the terminal back before the error is reported, not after.
      await this.stop();
      throw error;
    }
  }

  // ── Persistence ────────────────────────────────────────────────

  private hydrate(): void {
    const persisted = loadPersistedState(pathForProject(this.projectPath));
    if (persisted.treeVisible !== undefined && persisted.treeVisible !== this.layout.get().treeVisible) this.layout.toggleTree();
    if (persisted.chatVisible !== undefined && persisted.chatVisible !== this.layout.get().chatVisible) this.layout.toggleChat();
    if (persisted.editorMode) this.layout.setEditorMode(persisted.editorMode);
    for (const path of persisted.openPaths ?? []) {
      this.openFile(path, { activate: false });
      const cursor = persisted.cursorByPath?.[path];
      if (cursor) {
        const rec = this.buffers.findByPath(path);
        rec?.buffer.setCursor(cursor);
      }
    }
    if (persisted.activePath) {
      const rec = this.buffers.findByPath(persisted.activePath);
      if (rec) this.buffers.setActive(rec.id);
    }

    for (const draft of persisted.drafts ?? []) {
      // The draft goes over what is on disk now, so the buffer shows as unsaved against the file as it is.
      let rec = draft.path ? this.buffers.findByPath(draft.path) : null;
      if (draft.path && !rec) {
        const read = readFileForBuffer(draft.path);
        rec = this.buffers.openFile(draft.path, read.ok ? read.text : '', { disk: read.ok ? read.disk : null });
      }
      rec ??= this.buffers.openScratch();
      rec.buffer.setText(draft.text);
    }
    if (persisted.drafts?.length) this.pushMessage('system', `Recovered ${persisted.drafts.length} unsaved buffer(s). Review and save your edits.`);

    // Persist on every state change (debounced).
    const schedule = () => {
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => this.persist(), 500);
    };
    this.disposers.push(this.buffers.subscribe(schedule), this.layout.subscribe(schedule));
  }

  private persist(): void {
    const layout = this.layout.get();
    const buffers = this.buffers.get();
    const cursorByPath: Record<string, { line: number; col: number }> = {};
    for (const b of buffers.buffers) {
      if (!b.path) continue;
      const c = b.buffer.getCursor();
      cursorByPath[b.path] = { line: c.line, col: c.col };
    }
    const saved = savePersistedState({
      version: 1,
      openPaths: buffers.buffers.filter((b) => b.path).map((b) => b.path as string),
      activePath: buffers.buffers.find((b) => b.id === buffers.activeId)?.path ?? null,
      treeVisible: layout.treeVisible,
      chatVisible: layout.chatVisible,
      editorMode: layout.editorMode,
      cursorByPath,
      drafts: buffers.buffers.filter(b => b.dirty).map(b => ({ path: b.path, text: b.buffer.text(), label: b.label })),
    }, pathForProject(this.projectPath));
    if (this.modeBar.setRecoveryFailed(!saved)) this.tui.requestRender();
  }

  // ── Files ──────────────────────────────────────────────────────

  private openFile(absolutePath: string, options: { activate?: boolean } = {}): void {
    const open = this.buffers.findByPath(absolutePath);
    if (open) { if (options.activate !== false) this.buffers.setActive(open.id); return; }
    const read = readFileForBuffer(absolutePath);
    if (!read.ok) { this.modeBar.setNotice(read.error); this.pushMessage('system', `Error: ${read.error}`); return; }
    const record = this.buffers.openFile(absolutePath, read.text, { disk: read.disk });
    if (options.activate !== false) this.buffers.setActive(record.id);
    if (read.mixedEol) {
      this.pushMessage('system', `${record.label} mixes CRLF and LF line endings; saving writes ${read.disk.eol === '\r\n' ? 'CRLF' : 'LF'} throughout.`);
    }
  }

  /**
   * Debounced re-parse for highlighting: a buffer whose text changed is
   * parsed again 150 ms after the last edit; one that closed is forgotten.
   * Every buffer has its own parse, so two files of a language do not evict
   * each other.
   */
  private scheduleParses(buffers: readonly BufferRecord[]): void {
    const open = new Set(buffers.map((b) => b.id));
    for (const id of [...this.parsedVersion.keys()]) {
      if (open.has(id)) continue;
      this.parsedVersion.delete(id);
      const timer = this.parseTimers.get(id);
      if (timer) clearTimeout(timer);
      this.parseTimers.delete(id);
      dropSource(id);
    }
    for (const rec of buffers) {
      if (this.parsedVersion.get(rec.id) === rec.buffer.textVersion) continue;
      const first = !this.parsedVersion.has(rec.id);
      this.parsedVersion.set(rec.id, rec.buffer.textVersion);
      const existing = this.parseTimers.get(rec.id);
      if (existing) clearTimeout(existing);
      const parse = () => {
        this.parseTimers.delete(rec.id);
        const current = this.buffers.byId(rec.id);
        if (current) void treeSitterSetSource(current.id, current.language, current.buffer.text()).then(() => this.tui.requestRender());
      };
      // A newly opened buffer is parsed at once; edits wait for a pause.
      if (first) parse();
      else {
        const timer = setTimeout(parse, 150);
        timer.unref?.();
        this.parseTimers.set(rec.id, timer);
      }
    }
  }

  /**
   * Write a buffer to its file, unless the file changed on disk since it was
   * read or saved (`overwrite` skips that check). Never asks anything; the
   * outcome says what is needed.
   */
  private writeBuffer(id: string, overwrite = false): { ok: true } | { ok: false; needs: 'path' | 'confirm'; deleted?: boolean } | { ok: false; error: string } {
    const record = this.buffers.byId(id);
    if (!record) return { ok: false, error: 'The buffer is no longer open.' };
    if (!record.path) return { ok: false, needs: 'path' };
    if (!overwrite) {
      if (record.disk) {
        let check: ReturnType<typeof checkDisk>;
        try {
          check = checkDisk(record.path, record.disk, record.savedText);
        } catch (error) {
          return { ok: false, error: `Cannot check ${record.path} before saving: ${error instanceof Error ? error.message : String(error)}` };
        }
        if (check.changed) return { ok: false, needs: 'confirm', deleted: check.deleted };
        if (check.disk !== record.disk) this.buffers.markSaved(id, record.savedText, check.disk);
      } else if (existsSync(record.path)) {
        // Never read from this path (a recovered draft, a path chosen elsewhere): writing would replace a file the buffer never saw.
        return { ok: false, needs: 'confirm', deleted: false };
      }
    }
    const text = record.buffer.text();
    const result = writeFileForBuffer(record.path, text, record.disk);
    if (!result.ok) return { ok: false, error: result.error };
    this.buffers.markSaved(id, text, result.disk);
    return { ok: true };
  }

  /** Ctrl+S, `:w`: save, asking for a path (scratch) or a decision (changed on disk) when needed. */
  private saveBuffer(id: string, overwrite = false): boolean {
    const outcome = this.writeBuffer(id, overwrite);
    const record = this.buffers.byId(id);
    if (outcome.ok) {
      this.modeBar.setNotice(`Saved ${record?.label ?? ''}.`, 'info');
      this.pushMessage('system', `Saved ${record?.path ?? ''}.`);
      return true;
    }
    if ('error' in outcome) {
      this.modeBar.setNotice(`Save failed: ${outcome.error} Edits retained.`);
      this.pushMessage('system', `Error: ${outcome.error} Your edits are still in memory.`);
      return false;
    }
    if (outcome.needs === 'path') this.openSaveAs(id);
    else this.promptExternalChange(id, outcome.deleted === true);
    return false;
  }

  /** Saving would overwrite a file that changed on disk: reload, overwrite or cancel. */
  private promptExternalChange(id: string, deleted: boolean): void {
    const record = this.buffers.byId(id);
    if (!record?.path || this.externalHandle) return;
    const prompt = new ExternalChangePrompt(record.label, deleted, (choice) => {
      this.externalHandle?.hide(); this.externalHandle = null;
      if (choice === 'overwrite') this.saveBuffer(id, true);
      if (choice === 'reload') this.reloadFromDisk(id);
      if (!this.tui.hasOverlay()) this.refocus();
      this.tui.requestRender();
    });
    this.externalHandle = this.overlays.showModal(prompt, PROMPT_OVERLAY);
  }

  /** Replace the buffer with the file on disk, as one undoable step. */
  private reloadFromDisk(id: string): void {
    const record = this.buffers.byId(id);
    if (!record?.path) return;
    const read = readFileForBuffer(record.path);
    if (!read.ok) { this.modeBar.setNotice(read.error); this.pushMessage('system', `Error: ${read.error}`); return; }
    record.buffer.setText(read.text);
    this.buffers.markSaved(id, read.text, read.disk);
    this.modeBar.setNotice(`Reloaded ${record.label} from disk (Ctrl+Z brings your version back).`, 'info');
  }

  /** Save As, for scratch buffers and for saving a file under a new name. */
  private openSaveAs(id: string): void {
    const record = this.buffers.byId(id);
    if (!record || this.saveAsHandle) return;
    const initial = record.path ? relative(this.projectPath, record.path) : '';
    let confirmOverwrite: string | null = null;
    const prompt = new SaveAsPrompt({
      label: record.label,
      initial,
      onCancel: () => this.closeSaveAs(),
      onSubmit: (input) => {
        const result = this.saveAs(id, input, confirmOverwrite);
        if (result === 'saved') { this.closeSaveAs(); return; }
        if (result.confirm) confirmOverwrite = result.confirm;
        prompt.setError(result.error);
        this.tui.requestRender();
      },
    });
    this.saveAsHandle = this.overlays.showModal(prompt, PROMPT_OVERLAY);
  }

  private closeSaveAs(): void {
    if (!this.saveAsHandle) return;
    this.saveAsHandle.hide();
    this.saveAsHandle = null;
    this.refocus();
    this.tui.requestRender();
  }

  /**
   * Write buffer `id` to `input` (relative to the project, or absolute) and
   * make that its file. An existing file is only replaced when the same path
   * was already confirmed (`confirmed`).
   */
  private saveAs(id: string, input: string, confirmed: string | null): 'saved' | { error: string; confirm?: string } {
    const record = this.buffers.byId(id);
    if (!record) return { error: 'The buffer is no longer open.' };
    if (!input) return { error: 'Type a path for the file.' };
    const target = resolve(this.projectPath, input);
    const other = this.buffers.findByPath(target);
    if (other && other.id !== id) return { error: `${input} is open in another tab; close it first.` };
    if (!existsSync(dirname(target))) return { error: `The folder ${relative(this.projectPath, dirname(target)) || dirname(target)} does not exist.` };
    if (existsSync(target)) {
      if (statSync(target).isDirectory()) return { error: `${input} is a folder.` };
      if (target !== record.path && confirmed !== target) return { error: `${input} already exists. Press Enter again to replace it.`, confirm: target };
    }
    const existing = target === record.path ? record.disk : null;
    const text = record.buffer.text();
    const result = writeFileForBuffer(target, text, existing);
    if (!result.ok) return { error: result.error };
    this.buffers.rebind(id, target, text, result.disk);
    this.parsedVersion.delete(id);
    this.scheduleParses(this.buffers.get().buffers);
    this.modeBar.setNotice(`Saved as ${relative(this.projectPath, target) || target}.`, 'info');
    this.pushMessage('system', `Saved ${target}.`);
    return 'saved';
  }

  private runVimCommand(command: VimCommand, id: string): void {
    switch (command) {
      case 'write': this.saveBuffer(id); break;
      case 'quit': this.confirmUnsaved([id], () => this.buffers.close(id)); break;
      case 'quit!': this.buffers.revert(id); this.buffers.close(id); break;
      case 'write-quit': if (this.saveBuffer(id)) this.buffers.close(id); break;
      case 'quit-all': this.requestQuit(); break;
      case 'quit-all!':
        for (const b of this.buffers.get().buffers) this.buffers.revert(b.id);
        void this.stop().then(() => this.exit(0));
        break;
    }
    this.tui.requestRender();
  }

  /** Switch vim mode on or off (Alt+M, `/vim`). */
  private setVimMode(on: boolean): void {
    if (on === (this.layout.get().editorMode === 'vim')) return;
    this.editor.resetVim();
    this.layout.setEditorMode(on ? 'vim' : 'modeless');
    const key = getKeybindings().getKeys('app.vim.toggle')[0] ?? '/vim';
    this.modeBar.setNotice(on ? `Vim mode on: Esc NORMAL · i INSERT · :w save · :q close · ${key} off` : `Vim mode off · ${key} on`, 'info');
    this.tui.requestRender();
  }

  private confirmUnsaved(ids: string[], proceed: () => void): void {
    if (this.unsavedHandle) return;
    const dirty = this.buffers.get().buffers.filter(b => ids.includes(b.id) && b.dirty);
    if (!dirty.length) { proceed(); return; }
    const prompt = new UnsavedPrompt(dirty.map(b => b.label), choice => {
      if (choice === 'save') {
        for (const id of ids) {
          const current = this.buffers.byId(id);
          if (!current?.dirty) continue;
          const outcome = this.writeBuffer(id);
          if (outcome.ok) continue;
          const why = 'error' in outcome ? `Save failed: ${outcome.error}`
            : outcome.needs === 'path' ? `${current.label} has no file yet: cancel, then Save As (${getKeybindings().getKeys('app.file.saveAs')[0] ?? '/save-as'}).`
            : `${current.label} changed on disk since you opened it: cancel, then Ctrl+S to reload or overwrite.`;
          prompt.setError(`${why} Edits retained.`); this.tui.requestRender(); return;
        }
      }
      if (choice === 'discard') for (const id of ids) this.buffers.revert(id);
      this.unsavedHandle?.hide(); this.unsavedHandle = null;
      if (choice !== 'cancel') proceed();
      if (!this.tui.hasOverlay()) this.refocus();
    });
    this.unsavedHandle = this.overlays.showModal(prompt);
  }

  // ── Gateway events ─────────────────────────────────────────────

  private pushMessage(role: 'user' | 'assistant' | 'system', content: string): void {
    // Interactive answers render only in the web app: a plain line here.
    const text = role === 'assistant' ? inlineUiFallbackText(content) : content;
    this.chat.messages.push({ role, content: text.replace(/^Error: /, ''), tone: /^Error:|^✗/.test(content) ? 'error' : 'notice', timestamp: new Date() });
    this.tui.requestRender();
  }

  private handleEvent(event: AgentSessionEvent): void {
    if (this.session.handleEvent(event)) return;
    switch (event.kind) {
      case 'permission.resolved': this.decisions.resolve(event.requestId, event.status); return;
      case 'permission': this.decisions.push(event); return;
      case 'approval': this.decisions.push(event); return;
      case 'agent.write': this.handleAgentWrite(event.path, event.newText); return;
      case 'login_required':
        // The editor has no login prompt of its own; the chat TUI stores the
        // login both of them use.
        this.pushMessage('system', `Error: ${event.reason}. Sign in with /login in the chat TUI (\`octi tui\`), then reopen the editor.`);
        return;
      case 'command.result':
        if (event.name === 'clear' && !event.error) {
          this.chat.messages.reset();
          this.session.cumulative.turns = 0;
          this.status.setStats(this.session.cumulative);
          this.pushMessage('system', 'Chat cleared.');
          return;
        }
        this.pushMessage('system', `${event.error ? 'Error: ' : ''}/${event.name}: ${event.error || (typeof event.result === 'string' ? event.result : JSON.stringify(event.result))}`);
        return;
    }
  }

  private handleAgentWrite(path: string, newText: string): void {
    // The agent may name a file relative to the project it was given.
    const record = this.buffers.findByPath(isAbsolute(path) ? resolve(path) : resolve(this.projectPath, path));
    if (!record) {
      // Buffer isn't open — silently allow the write. Phase 7 may
      // open the file automatically and re-emit; for now skip.
      return;
    }
    // Lock the buffer until the user accepts or rejects; a queued diff holds its lock while it waits.
    this.buffers.setAgentLocked(record.id, true);
    this.openDiffOverlay(record.id, record.label, record.buffer.text(), newText);
  }

  private openDiffOverlay(bufferId: string, label: string, before: string, after: string): void {
    if (this.diffHandle) { this.diffQueue.push({ bufferId, label, before, after }); return; }
    this.buffers.setAgentLocked(bufferId, true);
    const overlay = new DiffOverlay({
      bufferLabel: label,
      before,
      after,
      onAccept: () => {
        const record = this.buffers.byId(bufferId);
        if (record) record.buffer.setText(after);
        this.buffers.setAgentLocked(bufferId, false);
        this.syncWithDisk(bufferId);
        this.chat.messages.push({ role: 'system', content: `Accepted agent edit to ${label}.`, timestamp: new Date() });
        this.closeDiffOverlay();
        this.tui.requestRender();
      },
      onReject: () => {
        this.buffers.setAgentLocked(bufferId, false);
        const diskHasEdit = this.syncWithDisk(bufferId);
        this.chat.messages.push({
          role: 'system',
          content: diskHasEdit
            ? `Rejected agent edit to ${label}. The agent already wrote it to disk: the buffer keeps your text, unsaved — Ctrl+S writes it back over the agent's version.`
            : `Rejected agent edit to ${label}.`,
          timestamp: new Date(),
        });
        this.closeDiffOverlay();
        this.tui.requestRender();
      },
    });
    this.diffHandle = this.overlays.showModal(overlay);
  }

  /**
   * After an agent edit is resolved, take the file's current content as the
   * buffer's saved text if the agent has already written it, so `dirty`
   * says whether the buffer matches the disk: clean after Accept, unsaved
   * after Reject. Returns whether the disk changed.
   */
  private syncWithDisk(bufferId: string): boolean {
    const record = this.buffers.byId(bufferId);
    if (!record?.path || !record.disk) return false;
    let check: ReturnType<typeof checkDisk>;
    try {
      check = checkDisk(record.path, record.disk, record.savedText);
    } catch (error) {
      this.pushMessage('system', `Error: Cannot check ${record.path}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!check.changed || check.deleted) return false;
    const read = readFileForBuffer(record.path);
    if (!read.ok) return false;
    this.buffers.markSaved(bufferId, read.text, read.disk);
    return true;
  }

  private closeDiffOverlay(): void {
    if (!this.diffHandle) return;
    this.diffHandle.hide();
    this.diffHandle = null;
    const next = this.diffQueue.shift();
    if (next) this.openDiffOverlay(next.bufferId, next.label, this.buffers.get().buffers.find(b => b.id === next.bufferId)?.buffer.text() ?? next.before, next.after);
    else if (!this.tui.hasOverlay()) this.refocus();
  }

  // ── Submit / commands ──────────────────────────────────────────

  private handleChatSubmit(rawText: string): void {
    if (rawText.trim().startsWith('/') && handleTerminalCommand(rawText, this.tui, this.chat.messages, text => this.pushMessage('system', text))) return;
    const text = rawText.trim();
    if (!text) return;
    this.chat.messages.push({ role: 'user', content: text, timestamp: new Date() });
    this.tui.requestRender();

    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const name = parts[0];
      const value = parts.slice(1).join(' ').trim();
      // TUI-local commands intercepted before going to the gateway.
      if (name === 'plan-hide') { this.status.setPlanDetails(null); this.tui.requestRender(); return; }
      if (name === 'vim') {
        this.setVimMode(value === 'on' ? true : value === 'off' ? false : this.layout.get().editorMode !== 'vim');
        return;
      }
      if (name === 'new') { this.buffers.openScratch(); this.layout.focus('editor'); this.refocus(); return; }
      if (name === 'save-as') {
        const active = this.buffers.active();
        if (!active) { this.pushMessage('system', 'Error: No buffer to save.'); return; }
        if (!value) { this.openSaveAs(active.id); return; }
        const result = this.saveAs(active.id, value, value);
        if (result !== 'saved') this.pushMessage('system', `Error: ${result.error}`);
        return;
      }
      if (name === 'quit' || name === 'exit' || name === 'q') {
        void this.shutdownAndExit();
        return;
      }
      if (name === 'keys' || name === 'hotkeys' || name === 'help-keys') {
        this.openHotkeys();
        return;
      }
      if (name === 'palette') {
        this.openCommandPalette();
        return;
      }
      if (name === 'reload' || name === 'reload-keybindings') {
        installEditorKeybindings(loadOctipusKeybindings());
        this.chat.messages.push({ role: 'system', content: 'Reloaded keybindings from ~/.octipus/keybindings.json.', timestamp: new Date() });
        this.tui.requestRender();
        return;
      }
      this.adapter.sendCommand(name, value ? { value } : undefined);
      return;
    }
    this.adapter.sendChat(this.sessionId, text, this.projectPath);
  }

  // ── Hotkeys ────────────────────────────────────────────────────

  private handleGlobalKey(data: string): { consume: true } | undefined {
    const kb = getKeybindings();
    if (this.modeBar.clearInfo()) this.tui.requestRender();
    if (this.tui.hasOverlay()) return undefined;
    if (kb.matches(data, 'app.subagents.scrollUp')) { if (this.chat.subagents.scroll(-1)) { this.tui.requestRender(); return { consume: true }; } }
    if (kb.matches(data, 'app.subagents.scrollDown')) { if (this.chat.subagents.scroll(1)) { this.tui.requestRender(); return { consume: true }; } }
    if (kb.matches(data, 'app.subagents.toggle')) { this.chat.subagents.toggle(); this.tui.requestRender(); return { consume: true }; }
    if (this.layout.get().focused === 'chat') {
      if (this.chat.messages.handleScrollInput(data)) { this.tui.requestRender(); return { consume: true }; }
    }
    // The tree and the editor do not scroll by wheel yet; a notch must not reach them as input.
    if (wheelDirection(data)) return { consume: true };
    if (kb.matches(data, 'app.tree.toggle'))   { this.layout.toggleTree(); return { consume: true }; }
    if (kb.matches(data, 'app.chat.toggle'))   { this.layout.toggleChat(); return { consume: true }; }
    if (kb.matches(data, 'app.pane.cycle'))    { this.layout.cycleFocus(1); this.refocus(); return { consume: true }; }
    if (kb.matches(data, 'app.buffer.next'))   { this.buffers.cycle(1); return { consume: true }; }
    if (kb.matches(data, 'app.buffer.prev'))   { this.buffers.cycle(-1); return { consume: true }; }
    if (kb.matches(data, 'app.buffer.close'))  {
      const a = this.buffers.active(); if (a) this.confirmUnsaved([a.id], () => this.buffers.close(a.id)); return { consume: true };
    }
    if (kb.matches(data, 'app.file.open'))     { this.openFilePicker(); return { consume: true }; }
    if (kb.matches(data, 'app.file.saveAs'))   { const a = this.buffers.active(); if (a) this.openSaveAs(a.id); return { consume: true }; }
    if (kb.matches(data, 'app.vim.toggle'))    { this.setVimMode(this.layout.get().editorMode !== 'vim'); return { consume: true }; }
    if (kb.matches(data, 'app.find.open'))     { this.openFind(); return { consume: true }; }
    if (kb.matches(data, 'app.replace.open'))  { this.openReplace(); return { consume: true }; }
    if (kb.matches(data, 'app.workspace.switch')) { void this.openWorkspacePicker(); return { consume: true }; }
    if (kb.matches(data, 'app.mcp.list'))      { void this.openMCPServerList(); return { consume: true }; }
    if (kb.matches(data, 'app.palette.open'))  { this.openCommandPalette(); return { consume: true }; }
    if (kb.matches(data, 'app.help.open'))     { this.openHotkeys(); return { consume: true }; }
    if (matchesKey(data, 'ctrl+c')) { this.requestQuit(); return { consume: true }; }
    if (kb.matches(data, 'app.quit'))          { void this.shutdownAndExit(); return { consume: true }; }
    return undefined;
  }

  requestQuit(): void {
    this.confirmUnsaved(this.buffers.get().buffers.map(b => b.id), () => { void this.stop().then(() => this.exit(0)); });
  }

  private async shutdownAndExit(): Promise<void> { this.requestQuit(); }

  async stop(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.mcpPoll) clearInterval(this.mcpPoll);
    this.persist();
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const timer of this.parseTimers.values()) clearTimeout(timer);
    this.parseTimers.clear();
    for (const id of this.parsedVersion.keys()) dropSource(id);
    this.parsedVersion.clear();
    this.decisions.dispose(); this.session.dispose(); this.adapter.disconnect();
    try { if (this.onShutdown) await this.onShutdown(); } catch { /* terminal cleanup is best effort */ }
  }

  private openCommandPalette(): void {
    if (this.paletteHandle) return;
    // Stack discipline: only one app-level overlay open at a time. pi-tui's
    // overlay stack restores focus to whatever's underneath when an overlay
    // hides, but our `refocus()` jumps straight back to the layout pane —
    // a stranded overlay underneath would lose its focus and never recover.
    this.closeAllOverlays();
    this.paletteHandle = this.overlays.showCommandPalette({
      onCommand: (commandName) => {
        this.closeCommandPalette();
        // Route through the chat-submit pipeline so /quit, /reload, etc.
        // behave the same way as if the user had typed them in the composer.
        this.handleChatSubmit(`/${commandName}`);
      },
      onCancel: () => this.closeCommandPalette(),
    });
  }

  private closeCommandPalette(): void {
    if (!this.paletteHandle) return;
    this.paletteHandle.hide();
    this.paletteHandle = null;
    this.refocus();
  }

  private openHotkeys(): void {
    if (this.hotkeysHandle) return;
    this.closeAllOverlays();
    const overlay = new HotkeysOverlay({ onClose: () => this.closeHotkeys() });
    this.hotkeysHandle = this.overlays.showModal(overlay);
  }

  private closeAllOverlays(): void {
    const handles: Array<{ handle: OverlayHandle | null; clear: () => void }> = [
      { handle: this.paletteHandle,      clear: () => { this.paletteHandle = null; } },
      { handle: this.hotkeysHandle,      clear: () => { this.hotkeysHandle = null; } },
      { handle: this.filePickerHandle,   clear: () => { this.filePickerHandle = null; } },
      { handle: this.findHandle,         clear: () => { this.findHandle = null; } },
      { handle: this.replaceHandle,      clear: () => { this.replaceHandle = null; } },
      { handle: this.workspaceHandle,    clear: () => { this.workspaceHandle = null; } },
      { handle: this.mcpHandle,          clear: () => { this.mcpHandle = null; } },
      { handle: this.saveAsHandle,       clear: () => { this.saveAsHandle = null; } },
    ];
    for (const { handle, clear } of handles) {
      if (handle) { handle.hide(); clear(); }
    }
  }

  private closeHotkeys(): void {
    if (!this.hotkeysHandle) return;
    this.hotkeysHandle.hide();
    this.hotkeysHandle = null;
    this.refocus();
  }

  private async openMCPServerList(): Promise<void> {
    // A second press while the bridge loads must not open a second list and lose the handle to the first.
    if (this.mcpHandle || this.loading.has('mcp')) return;
    this.loading.add('mcp');
    let bridge: typeof import('@/mcp/bridge');
    try {
      // Lazy import keeps the bridge out of tui-editor module init for tests.
      bridge = await import('@/mcp/bridge');
    } finally {
      this.loading.delete('mcp');
    }
    if (this.exiting || this.mcpHandle) return;
    const { getMCPBridge } = bridge;
    const provider = bridgeProvider(getMCPBridge() as unknown as Parameters<typeof bridgeProvider>[0]);
    const overlay = new MCPServerList({
      provider,
      onClose: () => this.closeMCPServerList(),
    });
    this.mcpHandle = this.overlays.showModal(overlay);
  }

  private closeMCPServerList(): void {
    if (!this.mcpHandle) return;
    this.mcpHandle.hide();
    this.mcpHandle = null;
    this.refocus();
  }

  private async openWorkspacePicker(): Promise<void> {
    // A second press while the list loads must not open a second picker and lose the handle to the first.
    if (this.workspaceHandle || this.loading.has('workspace')) return;
    this.loading.add('workspace');
    let error: string | undefined;
    try {
      error = await this.refreshWorkspaces();
    } finally {
      this.loading.delete('workspace');
    }
    if (this.exiting || this.workspaceHandle) return;
    const overlay = new WorkspacePicker({
      workspaces: this.workspace,
      error,
      onPick: (slug) => {
        this.workspace.setActive(slug);
        this.adapter.disconnect();
        void this.adapter.connect();
        this.chat.messages.push({
          role: 'system',
          content: slug ? `Switched workspace to ${slug}.` : 'Reset to default workspace.',
          timestamp: new Date(),
        });
        this.closeWorkspacePicker();
      },
      onCancel: () => this.closeWorkspacePicker(),
    });
    this.workspaceHandle = this.overlays.showModal(overlay);
  }

  private closeWorkspacePicker(): void {
    if (!this.workspaceHandle) return;
    this.workspaceHandle.hide();
    this.workspaceHandle = null;
    this.refocus();
  }

  /** Reload the workspace list; returns why it failed, if it did (the previous list stays). */
  private async refreshWorkspaces(): Promise<string | undefined> {
    const result = await this.apiClient.getJson<{ workspaces?: WorkspaceMeta[] } | WorkspaceMeta[]>('/me/workspaces');
    if (!result.ok) return result.error;
    const list = Array.isArray(result.data) ? result.data : result.data.workspaces ?? [];
    this.workspace.setAvailable(list);
    return undefined;
  }

  private openFind(): void {
    if (this.findHandle) return;
    const overlay = new FindOverlay({
      buffers: this.buffers,
      onClose: () => this.closeFind(),
      onMatches: (bufferId, matches, current) => { this.editor.setSearchHighlights(bufferId, matches, current); this.tui.requestRender(); },
    });
    this.findHandle = this.overlays.showModal(overlay, SEARCH_OVERLAY);
  }

  private closeFind(): void {
    if (!this.findHandle) return;
    this.findHandle.hide();
    this.findHandle = null;
    this.refocus();
  }

  private openReplace(): void {
    if (this.replaceHandle) return;
    const overlay = new ReplaceOverlay({
      buffers: this.buffers,
      onCommit: (count) => {
        this.chat.messages.push({
          role: 'system',
          content: `Replaced ${count} occurrence${count === 1 ? '' : 's'}.`,
          timestamp: new Date(),
        });
        this.closeReplace();
        this.tui.requestRender();
      },
      onClose: () => this.closeReplace(),
    });
    this.replaceHandle = this.overlays.showModal(overlay, SEARCH_OVERLAY);
  }

  private closeReplace(): void {
    if (!this.replaceHandle) return;
    this.replaceHandle.hide();
    this.replaceHandle = null;
    this.refocus();
  }

  private openFilePicker(): void {
    if (this.filePickerHandle) return;
    const picker = new FilePicker({
      root: this.projectPath,
      onPick: (path) => {
        this.closeFilePicker();
        this.openFile(path);
      },
      onCancel: () => this.closeFilePicker(),
      onUpdate: () => this.tui.requestRender(),
    });
    this.filePickerHandle = this.overlays.showModal(picker);
  }

  private closeFilePicker(): void {
    if (!this.filePickerHandle) return;
    this.filePickerHandle.hide();
    this.filePickerHandle = null;
    this.refocus();
  }

  private refocus(): void {
    const focused = this.layout.get().focused;
    const target = focused === 'tree' ? this.tree
                 : focused === 'chat' ? this.chat.composer
                 :                       this.editor;
    this.tui.setFocus(target);
  }
}

/** Find and replace sit in the top-right corner, so the matches they draw in the buffer stay visible. */
const SEARCH_OVERLAY: OverlayOptions = { anchor: 'top-right', width: 64, maxHeight: '85%', margin: { top: 2, right: 1 } };

/** Small questions (Save As, file changed on disk) sit low, like the other prompts. */
const PROMPT_OVERLAY: OverlayOptions = { anchor: 'bottom-center', width: '60%', minWidth: 40, margin: { bottom: 2, left: 2, right: 2 } };

function buildEditorPane(tabs: TabStrip, editor: TextEditor): Container {
  const c = new Container();
  c.addChild(tabs);
  c.addChild(new Spacer(0));
  c.addChild(editor);
  return c;
}

function basenameOf(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/**
 * Build the HTTP base URL from a gateway WebSocket URL. The
 * GatewayClient reads `ws://host:port/gateway` by default; the API
 * lives on the same port at `/api`, so we peel the protocol + path.
 */
function deriveApiBase(gatewayUrl: string | undefined): string {
  if (!gatewayUrl) return 'http://localhost:3005/api';
  try {
    const u = new URL(gatewayUrl);
    const protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${protocol}//${u.host}/api`;
  } catch {
    return 'http://localhost:3005/api';
  }
}
