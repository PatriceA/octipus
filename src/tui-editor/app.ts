/**
 * OctipusEditorApp — the editor + chat surface, put together.
 *
 * This file is the composition root: it builds the stores, the panes and the
 * gateway connection, and wires them to the parts of the shell that do the
 * work (`shell/`):
 *
 *   - `overlay-slots.ts`   which overlays are open, and closing them
 *   - `overlay-actions.ts` opening the palette, pickers, find and replace
 *   - `file-ops.ts`        open, save, Save As, reload, the unsaved prompt
 *   - `agent-review.ts`    the agent's edits, reviewed as diffs
 *   - `commands.ts`        composer commands and global hotkeys
 *   - `persistence.ts`     the per-project checkpoint
 *   - `highlight-parses.ts` re-parsing highlighting after edits
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Container, getKeybindings, Spacer, type TUI, type TuiMouseEvent } from '@/tui-kit';
import { ChatSessionPresenter } from '@/tui-pi/chat-session-presenter';
import { StatusBar } from '@/tui-pi/components/status-bar';
import { DecisionQueue } from '@/tui-pi/decision-queue';
import { type AgentSessionEvent, GatewayAdapter } from '@/tui-pi/gateway-adapter';
import { loadOctipusKeybindings } from '@/tui-pi/keybindings';
import { createOverlayController } from '@/tui-pi/overlays/registry';
import { terminalClipboard } from '@/tui-pi/terminal-actions';
import { readClipboard } from '@/tui-kit/clipboard-read';
import { inlineUiFallbackText } from '@/shared/inline-ui/fence';
import { ApiClient } from './api-client';
import { ChatPane } from './components/chat-pane';
import { FileTree } from './components/file-tree';
import { ModeBar } from './components/mode-bar';
import { SplitPane } from './components/split-pane';
import { TabStrip } from './components/tab-strip';
import { TextEditor } from './components/text-editor';
import { installTreeSitterHighlighter } from './editor/highlight-tree-sitter';
import type { VimCommand } from './editor/vim';
import { installEditorKeybindings } from './keybindings';
import { AgentReview } from './shell/agent-review';
import { type CommandHost, handleChatSubmit, handleGlobalKey } from './shell/commands';
import type { EditorContext } from './shell/context';
import { FileOps } from './shell/file-ops';
import { HighlightParses } from './shell/highlight-parses';
import { EditorOverlays } from './shell/overlay-actions';
import { OverlaySlots } from './shell/overlay-slots';
import { EditorPersistence } from './shell/persistence';
import { BufferStore } from './stores/buffer-store';
import { LayoutStore } from './stores/layout-store';
import { bindStore } from './stores/use-store';
import { WorkspaceStore } from './stores/workspace-store';

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
  private readonly session: ChatSessionPresenter;
  private readonly decisions: DecisionQueue;
  private readonly sessionId = randomUUID();
  private readonly projectPath: string;
  private readonly ctx: EditorContext;
  private readonly slots: OverlaySlots;
  private readonly files: FileOps;
  private readonly review: AgentReview;
  private readonly overlays: EditorOverlays;
  private readonly persistence: EditorPersistence;
  private readonly parses: HighlightParses;
  private readonly commands: CommandHost;
  private exiting = false;
  private readonly exit: (code: number) => void;
  private mcpPoll: ReturnType<typeof setInterval> | null = null;
  private readonly onShutdown?: () => Promise<void>;
  /** Everything to release on shutdown: store subscriptions, input listeners, the adapter listener. */
  private readonly disposers: Array<() => void> = [];
  /** What the editor copied last: pasted when the system clipboard cannot be read. */
  private lastCopy: string | null = null;

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
    const controller = createOverlayController(tui);
    this.slots = new OverlaySlots(controller, tui, () => this.refocus());
    this.ctx = {
      tui,
      buffers: this.buffers,
      layout: this.layout,
      overlays: this.slots,
      projectPath: this.projectPath,
      notice: (text, tone) => this.modeBar.setNotice(text, tone),
      pushMessage: (role, content) => this.pushMessage(role, content),
      log: (content) => this.chat.messages.push({ role: 'system', content, timestamp: new Date() }),
      refocus: () => this.refocus(),
      exiting: () => this.exiting,
    };
    this.decisions = new DecisionQueue(controller, this.adapter, text => this.pushMessage('system', text), () => { if (!tui.hasOverlay?.()) this.refocus(); });
    // The API base URL mirrors the gateway URL but on HTTP. Best-effort —
    // fetches return null on failure and the overlays cope.
    const apiClient = new ApiClient({
      baseUrl: deriveApiBase(options.gatewayUrl),
      workspaceStore: this.workspace,
    });
    this.parses = new HighlightParses(this.buffers, () => this.tui.requestRender());
    this.files = new FileOps(this.ctx, (id) => this.parses.reparse(id));
    this.review = new AgentReview(this.ctx, this.files);
    this.persistence = new EditorPersistence(this.ctx, this.files, (failed) => this.modeBar.setRecoveryFailed(failed));

    const copy = terminalClipboard(tui);
    this.tabs = new TabStrip(this.buffers);
    this.editor = new TextEditor(this.buffers, {
      onSave: (record) => { this.files.saveBuffer(record.id); },
      onVimCommand: (command, record) => this.runVimCommand(command, record.id),
      onNotice: (text) => { this.modeBar.setNotice(text); this.tui.requestRender(); },
      layout: this.layout,
      clipboard: {
        copy: (text) => {
          this.lastCopy = text;
          void copy(text).then(
            (result) => { this.modeBar.setNotice(result.message, result.ok ? 'info' : 'error'); this.tui.requestRender(); },
            (error: unknown) => { this.modeBar.setNotice(`Not copied: ${error instanceof Error ? error.message : String(error)}`); this.tui.requestRender(); },
          );
        },
        paste: async () => (await readClipboard()).text ?? this.lastCopy,
      },
      onFocus: () => { if (this.layout.get().focused !== 'editor') this.layout.focus('editor'); },
      requestRender: () => this.tui.requestRender(),
    });
    this.modeBar = new ModeBar(this.layout, this.buffers, {
      getVimMode: () => this.editor.getVimState().mode,
      getVimCommandLine: () => this.editor.getVimState().commandLine,
    });
    this.tree = new FileTree({
      root: this.projectPath,
      onOpen: (path) => this.files.openFile(path),
    });
    this.chat = new ChatPane({
      tui,
      basePath: this.projectPath,
      onSubmit: (text) => this.handleChatSubmit(text),
    });
    this.overlays = new EditorOverlays(this.ctx, {
      editor: this.editor,
      workspace: this.workspace,
      adapter: this.adapter,
      apiClient,
      openFile: (path) => this.files.openFile(path),
      runCommand: (text) => this.handleChatSubmit(text),
    });
    this.commands = this.commandHost();
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
    // On the alternate screen the renderer parses mouse reports and hands a wheel notch to the
    // component under the pointer; route it through the same handling as a raw report.
    const wheel = (up: boolean) => this.handleGlobalKey(up ? '\x1b[<64;1;1M' : '\x1b[<65;1;1M');
    const root = new class extends Container {
      override render(width: number): string[] { status.setMaxRows(Math.max(1, Math.floor(tui.terminal.rows / 3))); return super.render(width).slice(0, tui.terminal.rows); }
      override handleMouse(event: TuiMouseEvent): ReturnType<Container['handleMouse']> {
        if (event.type !== 'wheel' || !event.wheelDelta) return super.handleMouse(event);
        wheel(event.wheelDelta < 0);
        return { handled: true, target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height } };
      }
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
      this.buffers.subscribe((state) => this.parses.schedule(state.buffers)),
    );

    // Keep terminal size in the layout store (for editor scroll math + future overlay sizing).
    this.layout.setSize(tui.terminal.columns, tui.terminal.rows);
    this.disposers.push(this.layout.subscribe((state) => { this.editor.setWrap(state.softWrap); if (!this.tui.hasOverlay()) this.refocus(); }));

    // Restore persisted state — failures are non-fatal (defaults applied).
    this.disposers.push(...this.persistence.hydrate());

    this.disposers.push(this.adapter.on((event) => this.handleEvent(event)));

    // Poll MCP bridge for status — the bridge emits events but the
    // surface area is small enough that a 10s poll keeps the wiring
    // trivial. Failures are silent (no MCP installed / not loaded yet).
    void this.refreshMcpStatus();
    this.mcpPoll = setInterval(() => { void this.refreshMcpStatus(); }, 10_000);
    this.mcpPoll.unref?.();
  }

  /** The actions `shell/commands.ts` routes composer lines and hotkeys to. */
  private commandHost(): CommandHost {
    return {
      ctx: this.ctx,
      chat: this.chat,
      overlays: this.overlays,
      clearInfoNotice: () => this.modeBar.clearInfo(),
      hidePlanDetails: () => { this.status.setPlanDetails(null); this.tui.requestRender(); },
      setVimMode: (on) => this.setVimMode(on),
      setSoftWrap: (on) => {
        this.layout.setSoftWrap(on);
        this.modeBar.setNotice(on ? 'Soft wrap on: long lines break into rows.' : 'Soft wrap off: long lines scroll sideways.', 'info');
        this.tui.requestRender();
      },
      copySelection: () => this.layout.get().focused === 'editor' && this.editor.copySelection(),
      newScratch: () => { this.buffers.openScratch(); this.layout.focus('editor'); this.refocus(); },
      saveAsCommand: (value) => {
        const active = this.buffers.active();
        if (!active) { this.pushMessage('system', 'Error: No buffer to save.'); return; }
        if (!value) { this.files.openSaveAs(active.id); return; }
        const result = this.files.saveAs(active.id, value, value);
        if (result !== 'saved') this.pushMessage('system', `Error: ${result.error}`);
      },
      reloadKeybindings: () => {
        installEditorKeybindings(loadOctipusKeybindings());
        this.ctx.log('Reloaded keybindings from ~/.octipus/keybindings.json.');
        this.tui.requestRender();
      },
      closeActiveBuffer: () => { const a = this.buffers.active(); if (a) this.files.confirmUnsaved([a.id], () => this.buffers.close(a.id)); },
      openSaveAsForActive: () => { const a = this.buffers.active(); if (a) this.files.openSaveAs(a.id); },
      requestQuit: () => this.requestQuit(),
      shutdownAndExit: () => this.requestQuit(),
      sendCommand: (name, value) => this.adapter.sendCommand(name, value ? { value } : undefined),
      sendChat: (text) => this.adapter.sendChat(this.sessionId, text, this.projectPath),
    };
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

  private runVimCommand(command: VimCommand, id: string): void {
    switch (command) {
      case 'write': this.files.saveBuffer(id); break;
      case 'quit': this.files.confirmUnsaved([id], () => this.buffers.close(id)); break;
      case 'quit!': this.buffers.revert(id); this.buffers.close(id); break;
      case 'write-quit': if (this.files.saveBuffer(id)) this.buffers.close(id); break;
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
      case 'agent.write': this.review.handleWrite(event.path, event.newText); return;
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

  // ── Submit / hotkeys ───────────────────────────────────────────

  private handleChatSubmit(rawText: string): void { handleChatSubmit(this.commands, rawText); }

  private handleGlobalKey(data: string): { consume: true } | undefined { return handleGlobalKey(this.commands, data); }

  requestQuit(): void {
    this.files.confirmUnsaved(this.buffers.get().buffers.map(b => b.id), () => { void this.stop().then(() => this.exit(0)); });
  }

  async stop(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    if (this.mcpPoll) clearInterval(this.mcpPoll);
    this.persistence.flush();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.parses.dispose();
    this.decisions.dispose(); this.session.dispose(); this.adapter.disconnect();
    try { if (this.onShutdown) await this.onShutdown(); } catch { /* terminal cleanup is best effort */ }
  }

  private refocus(): void {
    const focused = this.layout.get().focused;
    const target = focused === 'tree' ? this.tree
                 : focused === 'chat' ? this.chat.composer
                 :                       this.editor;
    this.tui.setFocus(target);
  }
}

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
