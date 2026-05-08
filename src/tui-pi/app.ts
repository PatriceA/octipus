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
import { randomBytes } from 'node:crypto';
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
}

function newSessionId(): string {
  const hex = randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
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
  private projectPath?: string;
  private cumulative: CumulativeStats = { tokens: 0, cost: 0, turns: 0 };
  private permissionHandle: OverlayHandle | null = null;
  private paletteHandle: OverlayHandle | null = null;
  private exiting = false;

  constructor(tui: TUI, options: OctipusTuiAppOptions) {
    this.tui = tui;
    this.adapter = new GatewayAdapter({ url: options.gatewayUrl });
    this.projectPath = options.projectPath;
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
  }

  async stop(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    this.activity.dispose();
    try { this.adapter.disconnect(); } catch { /* already disconnected */ }
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
      case 'agent.end':
        this.cumulative = {
          tokens: this.cumulative.tokens + event.stats.tokens,
          cost: this.cumulative.cost + event.stats.cost,
          turns: this.cumulative.turns + 1,
        };
        this.status.setStats(this.cumulative);
        this.activity.setTool(null);
        this.tui.requestRender();
        return;
      case 'tool':
        this.activity.setTool(event.tool);
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
      // agent.start / agent.write are decoded but not yet surfaced in this phase.
      case 'agent.start':
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
