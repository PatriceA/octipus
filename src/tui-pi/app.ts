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
import { formatChangesMessage } from './changes-render';
import { ActivityLine } from './components/activity-line';
import { Composer } from './components/composer';
import { MessagesPane } from './components/messages-pane';
import { type CumulativeStats, StatusBar } from './components/status-bar';
import { GatewayAdapter, type AgentSessionEvent } from './gateway-adapter';
import { createOverlayController, type OverlayController } from './overlays/registry';
import type { VoiceService } from '@/voice';

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
  private approvalHandle: OverlayHandle | null = null;
  private permissionHandle: OverlayHandle | null = null;
  private paletteHandle: OverlayHandle | null = null;
  /** Most-recent role seen on agent.start — used to label `iter N` ticks. */
  private activeAgentRole: string | null = null;
  /** Last pending tool line streamed to messages pane (for completion dedupe). */
  private lastStreamedTool: string | null = null;
  private exiting = false;
  private readonly onShutdown?: () => Promise<void>;
  /** Lazily-built local voice (push-to-talk). Null until first talk-key press. */
  private voice: VoiceService | null = null;
  private voiceInit: Promise<VoiceService | null> | null = null;
  /** Speak the next assistant reply — armed by a voice turn so typed turns stay silent. */
  private speakNextReply = false;
  /** Guards the async windows of toggleTalk (init / transcription) against re-entrant key presses. */
  private talkBusy = false;

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
      if (kb.matches(data, 'app.voice.talk')) { void this.toggleTalk(); return { consume: true }; }
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
    // Show the root agent run mode (Router/Light/Full) once connected, so the
    // user sees how Octipus is running from the first screen. Non-critical.
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

  async stop(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    this.activity.dispose();
    if (this.voice) { void this.voice.dispose().catch(() => { /* best-effort */ }); }
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
        // Speak the reply to a voice turn (one-shot; no-op if TTS isn't configured).
        if (event.role === 'assistant' && this.speakNextReply) {
          this.speakNextReply = false;
          void this.voice?.say(event.content).catch(() => { /* playback best-effort */ });
        }
        return;
      case 'permission':
        this.openPermissionPrompt(event.requestId, event.toolName, event.detail);
        return;
      case 'approval':
        this.openApprovalPrompt(event.requestId, event.summary, event.question, event.options);
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
        // Render the workspace changes list / file diff as a monospace code
        // fence rather than a wrapped `/changes: …` system line.
        if (event.name === 'changes' && !event.error && typeof event.result === 'string') {
          const { role, content } = formatChangesMessage(event.result);
          this.pushMessage(role, content);
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

    // A new submission disarms any stale voice-reply flag, so a voice turn that
    // errored (no assistant message) can't cause a later TYPED turn to be spoken.
    // The voice path re-arms it right after calling this.
    this.speakNextReply = false;

    this.pushMessage('user', text);

    if (text.startsWith('/')) {
      this.handleCommand(text.slice(1));
      return;
    }
    this.adapter.sendChat(this.sessionId, text, undefined, this.projectPath);
  }

  // ── Voice (push-to-talk) ───────────────────────────────────────

  /**
   * Talk-key handler. First press starts capture; second press stops, transcribes,
   * and submits the transcript through the SAME path as typed text (`handleSubmit`
   * → sendChat), so voice reuses the normal root agent turn. The reply to that
   * turn is spoken back when TTS is configured.
   * ponytail: half-duplex, one turn per press; barge-in/streaming is Phase 4.
   */
  private async toggleTalk(): Promise<void> {
    // Ignore presses during an async window (engine build or transcription) so a
    // double-tap can't start-then-instantly-stop a capture. The idle wait BETWEEN
    // the start press and the stop press is not busy, so the stop press still lands.
    if (this.talkBusy) return;

    // START: not yet recording (voice may be null before first build).
    if (!this.voice?.recording) {
      this.talkBusy = true;
      try {
        const voice = await this.ensureVoice();
        if (!voice) return;
        voice.startRecording();
        this.pushMessage('system', '🎤 Listening… press the talk key again to send.');
      } catch (err) {
        this.pushMessage('system', `Voice capture failed: ${(err as Error).message} (needs arecord / Linux ALSA).`);
      } finally {
        this.talkBusy = false;
      }
      return;
    }

    // STOP: second press → transcribe + submit through the normal typed path.
    this.talkBusy = true;
    try {
      this.pushMessage('system', 'Transcribing…');
      const transcript = await this.voice.stopRecordingAndTranscribe();
      if (!transcript) {
        this.pushMessage('system', "Didn't catch anything — try again.");
        return;
      }
      this.handleSubmit(transcript);
      this.speakNextReply = true; // after handleSubmit (which clears it) — speak THIS turn's reply
    } catch (err) {
      this.pushMessage('system', `Transcription failed: ${(err as Error).message}`);
    } finally {
      this.talkBusy = false;
    }
  }

  /**
   * Build the local voice engine on first use (keeps voice deps off the TUI
   * startup path). Local whisper STT + configured TTS. Returns null — with a
   * one-line reason — when local whisper isn't installed.
   */
  private async ensureVoice(): Promise<VoiceService | null> {
    if (this.voice) return this.voice;
    if (this.voiceInit) return this.voiceInit;
    this.voiceInit = (async () => {
      try {
        const { getConfig } = await import('@/config');
        const { whisperModelPath, probeWhisper } = await import('@/voice/whisper');
        const cfg = getConfig();
        // Gate on the binary actually RUNNING, not just the model file existing —
        // whisper.ts exists to catch "model present but binary dead (exit 127)",
        // which would otherwise fail silently deep in transcribe.
        const probe = await probeWhisper();
        if (!probe.binaryOk || !probe.modelOk) {
          this.pushMessage('system', `Voice unavailable: ${probe.binaryReason ?? 'local whisper model missing'}. Run \`octi setup\`.`);
          return null;
        }
        const modelPath = cfg.voice.whisperModelPath || whisperModelPath();
        const { VoiceService } = await import('@/voice');
        this.voice = await VoiceService.create({
          stt: { type: 'whisper-cpp', model: modelPath, language: cfg.voice.language || 'en' },
          tts: cfg.voice.ttsEnabled ? { type: cfg.voice.ttsProvider } : undefined,
        });
        return this.voice;
      } catch (err) {
        this.pushMessage('system', `Voice init failed: ${(err as Error).message}`);
        return null;
      } finally {
        // Clear the in-flight promise so a FAILED init can be retried on the next
        // press (e.g. after the user runs `octi setup`). On success this.voice is
        // set, so the cache-hit at the top short-circuits before this matters.
        this.voiceInit = null;
      }
    })();
    return this.voiceInit;
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

  /**
   * The agent has asked the user a question and is BLOCKED on the answer.
   *
   * Different from a permission prompt in the one way that matters: nothing
   * happens until this is answered. So there is no silent dismissal — Esc
   * sends a decline, because closing the box without replying leaves the agent
   * waiting exactly as it was before the overlay appeared.
   */
  private openApprovalPrompt(
    requestId: string,
    summary: string,
    question: string,
    options: string[],
  ): void {
    if (this.approvalHandle) this.approvalHandle.hide();

    this.approvalHandle = this.overlays.showApprovalPrompt({
      summary,
      question,
      options,
      onRespond: (approved, response) => {
        this.adapter.respondApproval(requestId, approved, response);
        this.pushMessage('system', approved ? `Answered: ${response}` : `Declined: ${response}`);
        if (this.approvalHandle) {
          this.approvalHandle.hide();
          this.approvalHandle = null;
          this.tui.setFocus(this.composer);
        }
      },
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
