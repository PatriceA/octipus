/**
 * OctipusTuiApp.
 *
 * Composes the chat surface: status bar, scrolling messages pane,
 * pi Editor as composer, and pi-tui overlays for permission prompts
 * and the command palette (Ctrl+P). Submit handler routes the
 * TUI-local commands (`/exit`, `/quit`, `/cost`, `/project`) and
 * forwards everything else to the gateway adapter.
 *
 * State that belongs to multiple components (cumulative tokens,
 * pending permissions) lives in plain fields here for now. Phase 4
 * will hoist it into proper stores when the UI grows beyond chat.
 */
import { randomUUID } from 'node:crypto';
import { Container, getKeybindings, matchesKey, type OverlayHandle, Spacer, type TUI } from '@mariozechner/pi-tui';
import { ActivityLine } from './components/activity-line';
import { Composer } from './components/composer';
import { MessagesPane } from './components/messages-pane';
import { type CumulativeStats, StatusBar } from './components/status-bar';
import { GatewayAdapter, type AgentSessionEvent } from './gateway-adapter';
import { createOverlayController, type OverlayController } from './overlays/registry';

export interface OctipusTuiAppOptions {
  gatewayUrl?: string;
  projectPath?: string;
  /**
   * Optional shutdown hook. When set, /exit and /quit call this BEFORE
   * exiting the process so the runtime can tear down the alt-screen and
   * drain stdin. Without it, the PowerShell prompt redraws inside the
   * TUI's bottom border.
   */
  onShutdown?: () => Promise<void>;
}

function newSessionId(): string {
  return randomUUID();
}

function sanitize(text: string): string {
  return text.replace(/[︎️]/g, '');
}

export class OctipusTuiApp {
  readonly tui: TUI;
  readonly adapter: GatewayAdapter;
  private readonly status = new StatusBar();
  private readonly messages = new MessagesPane();
  private readonly activity: ActivityLine;
  private readonly composer: Composer;
  private readonly overlays: OverlayController;
  private readonly sessionId = newSessionId();
  /** Gateway WS URL — also used to derive the HTTP base for status lookups. */
  private readonly gatewayUrl?: string;
  private projectPath?: string;
  private cumulative: CumulativeStats = { tokens: 0, cost: 0, turns: 0 };
  private permissionHandle: OverlayHandle | null = null;
  private paletteHandle: OverlayHandle | null = null;
  /** Most-recent role seen on agent.start — used to label `iter N` ticks. */
  private activeAgentRole: string | null = null;
  /** Last pending tool line streamed to messages pane (for completion dedupe). */
  private lastStreamedTool: string | null = null;
  private exiting = false;
  private readonly onShutdown?: () => Promise<void>;

  constructor(tui: TUI, options: OctipusTuiAppOptions) {
    this.tui = tui;
    // Scope incoming gateway events to this TUI's own session so we don't
    // surface swarm/agent activity from concurrent web-chat or other-TUI
    // sessions that share the WS connection.
    this.adapter = new GatewayAdapter({
      url: options.gatewayUrl,
      getSessionId: () => this.sessionId,
    });
    this.gatewayUrl = options.gatewayUrl;
    this.projectPath = options.projectPath;
    this.onShutdown = options.onShutdown;
    this.composer = new Composer(tui, { basePath: options.projectPath ?? process.cwd() });
    this.activity = new ActivityLine(tui);
    this.overlays = createOverlayController(tui);

    this.status.setProject(this.projectPath?.split(/[/\\]/).pop());

    // Layout: status bar, blank line, messages, blank line, activity, composer
    const root = new Container();
    root.addChild(this.status);
    root.addChild(new Spacer(1));
    root.addChild(this.messages);
    root.addChild(new Spacer(1));
    root.addChild(this.activity);
    root.addChild(this.composer);
    tui.addChild(root);
    tui.setFocus(this.composer);

    this.composer.onSubmit = (text) => this.handleSubmit(text);

    // Global hotkeys — resolved through the shared KeybindingsManager
    // installed by `createRuntime`. Users override via ~/.octipus/keybindings.json.
    tui.addInputListener((data) => {
      const kb = getKeybindings();
      if (kb.matches(data, 'app.palette.open')) { this.openCommandPalette(); return { consume: true }; }
      if (matchesKey(data, 'pageUp')) {
        if (this.messages.scrollUp()) this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'pageDown')) {
        if (this.messages.scrollDown()) this.tui.requestRender();
        return { consume: true };
      }
      return undefined;
    });

    this.welcome();
    this.adapter.on((event) => this.handleEvent(event));
  }

  async start(): Promise<void> {
    this.tui.start();
    await this.adapter.connect();
    // Show the orchestrator run mode (Router/Light/Full) once connected, so the
    // user sees how Octipus is running from the first screen. Non-critical.
    void this.loadRunMode();
  }

  /** Derive the HTTP API base from the gateway WS URL (ws://host:port/gateway
   *  → http://host:port). Returns null if no gateway URL is known. */
  private httpBase(): string | null {
    if (!this.gatewayUrl) return null;
    try {
      const u = new URL(this.gatewayUrl);
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
      u.pathname = '';
      u.search = '';
      u.hash = '';
      return u.toString().replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  /** Fetch the orchestrator run mode and surface it in the status bar. */
  private async loadRunMode(): Promise<void> {
    const base = this.httpBase();
    if (!base) return;
    try {
      const res = await fetch(`${base}/health/orchestrator`);
      if (!res.ok) return;
      const data = (await res.json()) as { label?: string | null };
      if (data?.label) {
        this.status.setMode(data.label);
        this.tui.requestRender();
      }
    } catch {
      // Non-critical, and the TUI owns the alt-screen — writing to
      // stdout/console here would corrupt the rendered UI, so we intentionally
      // stay silent on a failed mode lookup rather than log.
    }
  }

  async stop(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    this.activity.dispose();
    try { this.adapter.disconnect(); } catch { /* already disconnected */ }
    // Hand off to the runtime so the alt-screen is properly torn down and
    // stdin is drained. Without this the shell's next prompt redraws on top
    // of the TUI border instead of starting on a fresh line.
    if (this.onShutdown) {
      try { await this.onShutdown(); } catch { /* shutdown failure is non-fatal */ }
    }
  }

  // ── UI plumbing ────────────────────────────────────────────────

  private welcome(): void {
    const projectName = this.projectPath?.split(/[/\\]/).pop();
    const greeting = projectName
      ? `Welcome to Octipus. Project: ${projectName}`
      : 'Welcome to Octipus.';
    this.pushMessage('system', `${greeting}  Type a message or /help for commands.`);
  }

  private pushMessage(role: 'user' | 'assistant' | 'system', content: string): void {
    // Live-tail rule: only auto-pin to the bottom when the user is
    // already there. Mid-scroll messages stay out of view until the
    // user explicitly returns to the latest.
    const wasAtBottom = this.messages.getScrollOffset() === 0;
    this.messages.push({ role, content: sanitize(content), timestamp: new Date() });
    if (wasAtBottom) this.messages.scrollToBottom();
    this.tui.requestRender();
  }

  /**
   * Stream tool calls into the messages pane so the user can follow the
   * agent live. The activity line stays the ephemeral spinner; this adds a
   * permanent transcript entry per call. Dedupes by tool name so a pending
   * + completed pair only writes one combined line.
   */
  private streamToolEvent(tool: { state: string; name: string; preview?: string; mcpServer?: string }): void {
    const mcp = tool.mcpServer ? `[mcp:${tool.mcpServer}] ` : '';
    const preview = tool.preview ? ` → ${tool.preview}` : '';
    if (tool.state === 'pending' || tool.state === 'executing') {
      this.lastStreamedTool = `${tool.name}${preview}`;
      this.pushMessage('system', `→ ${mcp}${this.lastStreamedTool}`);
    } else if (tool.state === 'error') {
      this.pushMessage('system', `✗ ${mcp}${tool.name}${preview}`);
      this.lastStreamedTool = null;
    } else if (tool.state === 'completed') {
      // Only echo a completion line when there's an output preview worth
      // showing; the pending line already named the call.
      if (tool.preview) this.pushMessage('system', `✓ ${mcp}${tool.name} ${tool.preview}`);
      this.lastStreamedTool = null;
    }
  }

  // ── Event handling ─────────────────────────────────────────────

  private handleEvent(event: AgentSessionEvent): void {
    switch (event.kind) {
      case 'status':
        this.status.setStatus(event.status);
        this.tui.requestRender();
        return;
      case 'message':
        this.pushMessage(event.role, event.content);
        return;
      case 'permission':
        this.openPermissionPrompt(event.requestId, event.toolName, event.detail);
        return;
      case 'agent.start':
        // Start with iteration 0 so a long-running agent isn't silent
        // between spawn and its first iteration tick (the worker emits
        // iteration_update at the TOP of each loop iteration).
        this.activeAgentRole = event.role;
        this.activity.setThinking({ role: event.role, iter: 0 });
        return;
      case 'agent.iteration':
        this.activity.setThinking({
          role: this.activeAgentRole ?? 'agent',
          iter: event.iteration,
        });
        return;
      case 'agent.end':
        this.cumulative = {
          tokens: this.cumulative.tokens + event.stats.tokens,
          cost: this.cumulative.cost + event.stats.cost,
          turns: this.cumulative.turns + 1,
        };
        this.status.setStats(this.cumulative);
        this.activity.setTool(null);
        this.activity.setThinking(null);
        this.activeAgentRole = null;
        this.tui.requestRender();
        return;
      case 'tool':
        this.activity.setTool(event.tool);
        this.streamToolEvent(event.tool);
        return;
      case 'command.result': {
        if (event.name === 'clear' && !event.error) {
          this.tui.terminal.clearScreen();
          this.messages.reset();
          this.cumulative = { tokens: 0, cost: 0, turns: 0 };
          this.status.setStats(this.cumulative);
          this.pushMessage('system', 'Chat cleared.');
          return;
        }
        const content = event.error || (typeof event.result === 'string' ? event.result : JSON.stringify(event.result));
        this.pushMessage('system', `/${event.name}: ${content}`);
        return;
      }
      case 'error':
        this.pushMessage('system', `Error: ${event.message}`);
        return;
      case 'expert':
        this.status.setExpert(event.expertId);
        this.tui.requestRender();
        return;
      case 'agent.write':
        return;
    }
  }

  // ── Submit / commands ──────────────────────────────────────────

  private handleSubmit(rawText: string): void {
    const text = rawText.trim();
    if (!text) return;

    this.pushMessage('user', text);

    if (text.startsWith('/')) {
      this.handleCommand(text.slice(1));
      return;
    }
    this.adapter.sendChat(this.sessionId, text, undefined, this.projectPath);
  }

  // ── Overlays ───────────────────────────────────────────────────

  private openPermissionPrompt(requestId: string, toolName: string, detail: string): void {
    if (this.permissionHandle) this.permissionHandle.hide();

    const respond = (approved: boolean): void => {
      this.adapter.respondPermission(requestId, approved);
      this.pushMessage('system', approved ? `Approved: ${toolName}` : `Denied: ${toolName}`);
      this.closePermissionPrompt();
    };

    this.permissionHandle = this.overlays.showPermissionPrompt({
      toolName,
      detail,
      onApprove: () => respond(true),
      onDeny:    () => respond(false),
      onCancel:  () => respond(false),
    });
  }

  private closePermissionPrompt(): void {
    if (!this.permissionHandle) return;
    this.permissionHandle.hide();
    this.permissionHandle = null;
    this.tui.setFocus(this.composer);
  }

  private openCommandPalette(): void {
    if (this.paletteHandle) return;
    this.paletteHandle = this.overlays.showCommandPalette({
      onCommand: (commandName) => {
        this.closeCommandPalette();
        this.pushMessage('user', `/${commandName}`);
        this.handleCommand(commandName);
      },
      onCancel: () => this.closeCommandPalette(),
    });
  }

  private closeCommandPalette(): void {
    if (!this.paletteHandle) return;
    this.paletteHandle.hide();
    this.paletteHandle = null;
    this.tui.setFocus(this.composer);
  }

  private handleCommand(commandText: string): void {
    const parts = commandText.split(/\s+/);
    const name = parts[0];
    const value = parts.slice(1).join(' ').trim();
    const args: Record<string, string> | undefined = value ? { value } : undefined;

    switch (name) {
      case 'exit':
      case 'quit':
        void this.stop().then(() => process.exit(0));
        return;
      case 'cost': {
        const content = `${this.cumulative.tokens.toLocaleString()} tokens · ${this.cumulative.turns} turns`
          + (this.cumulative.cost > 0 ? ` · $${this.cumulative.cost.toFixed(4)}` : '');
        this.pushMessage('system', `/cost: ${content}`);
        return;
      }
      case 'project': {
        if (!value) {
          this.pushMessage('system', `Current project: ${this.projectPath ?? '(none)'}`);
        } else {
          this.projectPath = value;
          this.status.setProject(value.split(/[/\\]/).pop());
          this.pushMessage('system', `Project set to: ${value}`);
        }
        return;
      }
      case 'workspace': {
        const current = this.adapter.getWorkspace();
        if (!value) {
          this.pushMessage('system', `Current workspace: ${current ?? '(default)'}`);
          return;
        }
        const next = value === '-' || value === 'default' ? null : value;
        this.pushMessage('system', `Switching workspace to ${next ?? '(default)'}…`);
        this.adapter.reconnectWithWorkspace(next).then(() => {
          this.pushMessage('system', `Workspace: ${next ?? '(default)'}`);
        }).catch((err: unknown) => {
          this.pushMessage('system', `Workspace switch failed: ${(err as Error).message}`);
        });
        return;
      }
      default:
        this.adapter.sendCommand(name, args);
    }
  }
}
