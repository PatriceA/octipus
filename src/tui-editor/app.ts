/**
 * OctipusEditorApp — pi-tui-based editor + chat surface.
 *
 * Wiring:
 *   - LayoutStore drives pane visibility + focus
 *   - BufferStore drives the open files / active buffer
 *   - WorkspaceStore tracks the active workspace slug for the gateway
 *   - AgentStore mirrors gateway events for tests / extensions (the
 *     chat pane consumes events directly via the GatewayAdapter
 *     subscription)
 *   - GatewayAdapter wraps the WebSocket protocol the chat shell
 *     also uses
 *
 * Phase 5 ships a working skeleton: open files via Ctrl+O picker
 * (deferred to Phase 5.x; for now use --project to seed the tree),
 * edit + save (Ctrl+S), toggle panes (Ctrl+B / Ctrl+J), cycle focus
 * (Ctrl+\), cycle buffers (Ctrl+Tab / Ctrl+Shift+Tab), close buffer
 * (Ctrl+W). Vim mode and the diff overlay come in Phase 5.x once
 * this scaffold proves out.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Container, getKeybindings, type OverlayHandle, Spacer, type TUI } from '@mariozechner/pi-tui';
import { installOctipusKeybindings } from '@/tui-pi/keybindings';
import { ApiClient } from './api-client';
import { ChatPane } from './components/chat-pane';
import { detectLanguage } from './editor/lang';
import { installTreeSitterHighlighter, setSource as treeSitterSetSource } from './editor/highlight-tree-sitter';
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
import { AgentStore } from './stores/agent-store';
import { BufferStore } from './stores/buffer-store';
import { LayoutStore } from './stores/layout-store';
import { bindStore } from './stores/use-store';
import { WorkspaceStore, type WorkspaceMeta } from './stores/workspace-store';
import { readFileForBuffer, writeFileForBuffer } from './workspace-fs-bridge';
import { type CumulativeStats, StatusBar } from '@/tui-pi/components/status-bar';
import { GatewayAdapter, type AgentSessionEvent } from '@/tui-pi/gateway-adapter';
import { createOverlayController, type OverlayController } from '@/tui-pi/overlays/registry';
import { chalk } from '@/tui-pi/theme/defaults';

export interface OctipusEditorAppOptions {
  gatewayUrl?: string;
  projectPath?: string;
  /**
   * Optional shutdown hook for /exit, /quit, and Ctrl+Q. Without it, the
   * editor calls process.exit() directly without tearing down the alt-screen,
   * leaving the shell prompt drawn on top of the editor's bottom border.
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
  readonly agent = new AgentStore();

  private readonly status = new StatusBar();
  private readonly tabs: TabStrip;
  private readonly modeBar: ModeBar;
  private readonly editor: TextEditor;
  private readonly tree: FileTree;
  private readonly chat: ChatPane;
  private readonly split: SplitPane;
  private readonly overlays: OverlayController;
  private readonly sessionId = newSessionId();
  private readonly projectPath: string;
  private cumulative: CumulativeStats = { tokens: 0, cost: 0, turns: 0 };
  private permissionHandle: OverlayHandle | null = null;
  private paletteHandle: OverlayHandle | null = null;
  private filePickerHandle: OverlayHandle | null = null;
  private findHandle: OverlayHandle | null = null;
  private replaceHandle: OverlayHandle | null = null;
  private diffHandle: OverlayHandle | null = null;
  private workspaceHandle: OverlayHandle | null = null;
  private mcpHandle: OverlayHandle | null = null;
  private hotkeysHandle: OverlayHandle | null = null;
  private apiClient: ApiClient;
  private readonly onShutdown?: () => Promise<void>;

  constructor(tui: TUI, options: OctipusEditorAppOptions) {
    this.tui = tui;
    this.adapter = new GatewayAdapter({
      url: options.gatewayUrl,
      getWorkspace: () => this.workspace.get().activeSlug,
    });
    this.projectPath = options.projectPath ? resolve(options.projectPath) : process.cwd();
    this.onShutdown = options.onShutdown;
    this.overlays = createOverlayController(tui);
    // The API base URL mirrors the gateway URL but on HTTP. Best-effort —
    // fetches return null on failure and the overlays cope.
    this.apiClient = new ApiClient({
      baseUrl: deriveApiBase(options.gatewayUrl),
      workspaceStore: this.workspace,
    });

    this.tabs = new TabStrip(this.buffers);
    this.editor = new TextEditor(this.buffers, {
      onSave: (record) => this.saveBuffer(record),
      layout: this.layout,
    });
    this.modeBar = new ModeBar(this.layout, this.buffers, {
      getVimMode: () => this.editor.getVimState().mode,
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
    this.chat.messages.push({
      role: 'system',
      content: `Welcome to Octipus. Project: ${basenameOf(this.projectPath)}  Type a message or /help for commands.`,
      timestamp: new Date(),
    });

    this.split = new SplitPane({
      layout: this.layout,
      tree: this.tree,
      editor: buildEditorPane(this.tabs, this.editor),
      chat: this.chat,
      onResize: (_sizes) => {
        // Use the terminal's true row count rather than the editor's previous
        // render height — the latter feeds back into setHeight every cycle and
        // collapses the panes down to the floor (5 rows).
        // Subtract the status bar (top) + mode bar (bottom) = 2 rows.
        const paneRows = Math.max(5, tui.terminal.rows - 2);
        const editorRows = Math.max(5, paneRows - 1); // tab strip eats 1 row
        this.editor.setHeight(editorRows);
        this.tree.setHeight(paneRows);
        this.chat.setHeight(paneRows);
      },
    });

    // Status bar is the single top line; mode bar is the single bottom line.
    this.status.setProject(basenameOf(this.projectPath));
    const root = new Container();
    root.addChild(this.status);
    root.addChild(this.split);
    root.addChild(this.modeBar);
    tui.addChild(root);
    tui.setFocus(this.editor);

    // Re-render whenever any store updates so dirty markers, tabs, mode bar etc. stay current.
    bindStore(this.buffers, this.tabs,    tui);
    bindStore(this.buffers, this.modeBar, tui);
    bindStore(this.layout,  this.modeBar, tui);
    bindStore(this.layout,  this.split,   tui);

    // Global hotkeys (Phase 6 will move these into keybindings.json).
    tui.addInputListener((data) => this.handleGlobalKey(data));

    // Keep terminal size in the layout store (for editor scroll math + future overlay sizing).
    this.layout.setSize(tui.terminal.columns, tui.terminal.rows);

    // Restore persisted state — failures are non-fatal (defaults applied).
    this.hydrate();

    this.adapter.on((event) => this.handleEvent(event));

    // Poll MCP bridge for status — the bridge emits events but the
    // surface area is small enough that a 10s poll keeps the wiring
    // trivial. Failures are silent (no MCP installed / not loaded yet).
    void this.refreshMcpStatus();
    setInterval(() => { void this.refreshMcpStatus(); }, 10_000).unref?.();
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
    await this.adapter.connect();
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

    // Persist on every state change (debounced).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => this.persist(), 500);
    };
    this.buffers.subscribe(schedule);
    this.layout.subscribe(schedule);
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
    savePersistedState({
      version: 1,
      openPaths: buffers.buffers.filter((b) => b.path).map((b) => b.path as string),
      activePath: buffers.buffers.find((b) => b.id === buffers.activeId)?.path ?? null,
      treeVisible: layout.treeVisible,
      chatVisible: layout.chatVisible,
      theme: 'dark',
      editorMode: layout.editorMode,
      cursorByPath,
    }, pathForProject(this.projectPath));
  }

  // ── Files ──────────────────────────────────────────────────────

  private openFile(absolutePath: string, options: { activate?: boolean } = {}): void {
    const text = readFileForBuffer(absolutePath);
    if (text === null) return; // bridge-level errors are silent (binary / >5MB / missing)
    const record = this.buffers.openFile(absolutePath, text);
    if (options.activate !== false) this.buffers.setActive(record.id);
    // Seed the tree-sitter parse for this language. Fire-and-forget;
    // the highlighter uses the regex fallback until the parse is
    // ready, and silently no-ops for languages without a grammar.
    void treeSitterSetSource(detectLanguage(absolutePath), text);
  }

  private saveBuffer(record: { id: string; path: string | null; buffer: { text(): string } }): void {
    if (!record.path) return; // scratch buffers can't save without a path; future "Save As" overlay
    const ok = writeFileForBuffer(record.path, record.buffer.text());
    if (ok) this.buffers.markDirty(record.id, false);
  }

  // ── Gateway events ─────────────────────────────────────────────

  private handleEvent(event: AgentSessionEvent): void {
    switch (event.kind) {
      case 'status':
        this.status.setStatus(event.status);
        this.tui.requestRender();
        return;
      case 'message':
        this.chat.messages.push({ role: event.role, content: event.content, timestamp: new Date() });
        this.tui.requestRender();
        return;
      case 'permission':
        this.openPermissionPrompt(event.requestId, event.toolName, event.detail);
        return;
      case 'agent.end':
        this.cumulative = {
          tokens: this.cumulative.tokens + event.stats.tokens,
          cost: this.cumulative.cost + event.stats.cost,
          turns: this.cumulative.turns + 1,
        };
        this.status.setStats(this.cumulative);
        this.chat.activity.setTool(null);
        this.tui.requestRender();
        return;
      case 'tool':
        this.chat.activity.setTool(event.tool);
        return;
      case 'command.result': {
        if (event.name === 'clear' && !event.error) {
          this.tui.terminal.clearScreen();
          this.chat.messages.reset();
          this.cumulative = { tokens: 0, cost: 0, turns: 0 };
          this.status.setStats(this.cumulative);
          this.chat.messages.push({ role: 'system', content: 'Chat cleared.', timestamp: new Date() });
          this.tui.requestRender();
          return;
        }
        const content = event.error || (typeof event.result === 'string' ? event.result : JSON.stringify(event.result));
        this.chat.messages.push({ role: 'system', content: `/${event.name}: ${content}`, timestamp: new Date() });
        this.tui.requestRender();
        return;
      }
      case 'error':
        this.chat.messages.push({ role: 'system', content: `Error: ${event.message}`, timestamp: new Date() });
        this.tui.requestRender();
        return;
      case 'expert':
        this.status.setExpert(event.expertId);
        this.tui.requestRender();
        return;
      case 'agent.start':
        return;
      case 'agent.write':
        this.handleAgentWrite(event.path, event.newText);
        return;
    }
  }

  private handleAgentWrite(path: string, newText: string): void {
    const record = this.buffers.findByPath(path);
    if (!record) {
      // Buffer isn't open — silently allow the write. Phase 7 may
      // open the file automatically and re-emit; for now skip.
      return;
    }
    if (record.lockMode === 'merge') {
      this.buffers.applyAgentEdit(record.id, newText);
      this.chat.messages.push({
        role: 'system',
        content: `Merged agent edit into ${record.label}.`,
        timestamp: new Date(),
      });
      this.tui.requestRender();
      return;
    }
    // Lock mode: take the lock, open the diff overlay.
    this.buffers.applyAgentEdit(record.id, newText);
    this.openDiffOverlay(record.id, record.label, record.buffer.text(), newText);
  }

  private openDiffOverlay(bufferId: string, label: string, before: string, after: string): void {
    if (this.diffHandle) this.diffHandle.hide();
    const overlay = new DiffOverlay({
      bufferLabel: label,
      before,
      after,
      onAccept: () => {
        const record = this.buffers.get().buffers.find((b) => b.id === bufferId);
        if (record) {
          record.buffer.setText(after);
          this.buffers.markDirty(bufferId, true);
        }
        this.buffers.setAgentLocked(bufferId, false);
        this.chat.messages.push({ role: 'system', content: `Accepted agent edit to ${label}.`, timestamp: new Date() });
        this.closeDiffOverlay();
        this.tui.requestRender();
      },
      onReject: () => {
        this.buffers.setAgentLocked(bufferId, false);
        this.chat.messages.push({ role: 'system', content: `Rejected agent edit to ${label}.`, timestamp: new Date() });
        this.closeDiffOverlay();
        this.tui.requestRender();
      },
    });
    this.diffHandle = this.overlays.showModal(overlay);
  }

  private closeDiffOverlay(): void {
    if (!this.diffHandle) return;
    this.diffHandle.hide();
    this.diffHandle = null;
    this.refocus();
  }

  // ── Submit / commands ──────────────────────────────────────────

  private handleChatSubmit(rawText: string): void {
    const text = rawText.trim();
    if (!text) return;
    this.chat.messages.push({ role: 'user', content: text, timestamp: new Date() });
    this.tui.requestRender();

    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const name = parts[0];
      const value = parts.slice(1).join(' ').trim();
      // TUI-local commands intercepted before going to the gateway.
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
        installOctipusKeybindings();
        this.chat.messages.push({ role: 'system', content: 'Reloaded keybindings from ~/.octipus/keybindings.json.', timestamp: new Date() });
        this.tui.requestRender();
        return;
      }
      this.adapter.sendCommand(name, value ? { value } : undefined);
      return;
    }
    this.adapter.sendChat(this.sessionId, text, undefined, this.projectPath);
  }

  // ── Hotkeys ────────────────────────────────────────────────────

  private handleGlobalKey(data: string): { consume: true } | undefined {
    const kb = getKeybindings();
    if (kb.matches(data, 'app.tree.toggle'))   { this.layout.toggleTree(); return { consume: true }; }
    if (kb.matches(data, 'app.chat.toggle'))   { this.layout.toggleChat(); return { consume: true }; }
    if (kb.matches(data, 'app.pane.cycle'))    { this.layout.cycleFocus(1); this.refocus(); return { consume: true }; }
    if (kb.matches(data, 'app.buffer.next'))   { this.buffers.cycle(1); return { consume: true }; }
    if (kb.matches(data, 'app.buffer.prev'))   { this.buffers.cycle(-1); return { consume: true }; }
    if (kb.matches(data, 'app.buffer.close'))  {
      const a = this.buffers.active(); if (a) this.buffers.close(a.id); return { consume: true };
    }
    if (kb.matches(data, 'app.file.open'))     { this.openFilePicker(); return { consume: true }; }
    if (kb.matches(data, 'app.find.open'))     { this.openFind(); return { consume: true }; }
    if (kb.matches(data, 'app.replace.open'))  { this.openReplace(); return { consume: true }; }
    if (kb.matches(data, 'app.workspace.switch')) { void this.openWorkspacePicker(); return { consume: true }; }
    if (kb.matches(data, 'app.mcp.list'))      { void this.openMCPServerList(); return { consume: true }; }
    if (kb.matches(data, 'app.palette.open'))  { this.openCommandPalette(); return { consume: true }; }
    if (kb.matches(data, 'app.help.open'))     { this.openHotkeys(); return { consume: true }; }
    if (kb.matches(data, 'app.quit'))          { void this.shutdownAndExit(); return { consume: true }; }
    return undefined;
  }

  private async shutdownAndExit(): Promise<void> {
    // Tear down alt-screen + drain stdin before the process dies so the
    // shell's next prompt starts on a clean line instead of overlapping
    // the editor's bottom border.
    try { if (this.onShutdown) await this.onShutdown(); } catch { /* non-fatal */ }
    process.exit(0);
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
      { handle: this.diffHandle,         clear: () => { this.diffHandle = null; } },
      { handle: this.permissionHandle,   clear: () => { this.permissionHandle = null; } },
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
    if (this.mcpHandle) return;
    // Lazy import keeps the bridge out of tui-editor module init for tests.
    const { getMCPBridge } = await import('@/mcp/bridge');
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
    if (this.workspaceHandle) return;
    // Refresh available workspaces in the background; picker re-reads the store on render.
    await this.refreshWorkspaces();
    const overlay = new WorkspacePicker({
      workspaces: this.workspace,
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

  private async refreshWorkspaces(): Promise<void> {
    const data = await this.apiClient.getJson<{ workspaces?: WorkspaceMeta[] } | WorkspaceMeta[]>('/me/workspaces');
    if (!data) return;
    const list = Array.isArray(data) ? data : data.workspaces ?? [];
    this.workspace.setAvailable(list);
  }

  private openFind(): void {
    if (this.findHandle) return;
    const overlay = new FindOverlay({
      buffers: this.buffers,
      onClose: () => this.closeFind(),
    });
    this.findHandle = this.overlays.showModal(overlay);
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
    this.replaceHandle = this.overlays.showModal(overlay);
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

  // ── Overlays (port of chat-shell logic) ────────────────────────

  private openPermissionPrompt(requestId: string, toolName: string, detail: string): void {
    if (this.permissionHandle) this.permissionHandle.hide();
    const respond = (approved: boolean): void => {
      this.adapter.respondPermission(requestId, approved);
      this.chat.messages.push({
        role: 'system',
        content: approved ? `Approved: ${toolName}` : `Denied: ${toolName}`,
        timestamp: new Date(),
      });
      if (this.permissionHandle) { this.permissionHandle.hide(); this.permissionHandle = null; }
      this.refocus();
      this.tui.requestRender();
    };
    this.permissionHandle = this.overlays.showPermissionPrompt({
      toolName, detail,
      onApprove: () => respond(true),
      onDeny:    () => respond(false),
      onCancel:  () => respond(false),
    });
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

// Quiet down lint about unused chalk import that pulls the theme defaults eagerly.
void chalk;
