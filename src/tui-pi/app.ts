/**
 * OctipusTuiApp.
 *
 * Composes the chat surface: status bar, scrolling messages pane,
 * pi Editor as composer, and pi-tui overlays for permission prompts
 * and the command palette (Ctrl+P). Submit handler routes the
 * TUI-local commands (see `source: 'tui'` in slash-commands.ts) and
 * forwards everything else to the gateway adapter.
 *
 * State that belongs to multiple components (cumulative tokens,
 * session list, pending overlays) lives in plain fields here.
 */
import { randomUUID } from 'node:crypto';
import { Container, getKeybindings, matchesKey, type OverlayHandle, Spacer, type TUI } from '@mariozechner/pi-tui';
import { loginWithPassword } from '@/core/gateway/cli-login';
import { clearCliSession, readCliSession } from '@/core/gateway/cli-session';
import { formatChangesMessage } from './changes-render';
import { ActivityLine } from './components/activity-line';
import { Composer } from './components/composer';
import { SubagentPanel } from './components/subagent-panel';
import { MessagesPane } from './components/messages-pane';
import { type CumulativeStats, StatusBar } from './components/status-bar';
import { GatewayAdapter, type AgentSessionEvent } from './gateway-adapter';
import { createOverlayController, type OverlayController } from './overlays/registry';
import { OCTIPUS_APP_KEYBINDINGS } from './keybindings';
import { findSlashCommand, OCTIPUS_SLASH_COMMANDS } from './slash-commands';
import type { VoiceService } from '@/voice';

export interface OctipusTuiAppOptions {
  gatewayUrl?: string;
  projectPath?: string;
  /** Resume this session: its transcript is replayed once the gateway connects. */
  sessionId?: string;
  /** Process exit hook (tests swap it out). */
  exit?: (code: number) => void;
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

interface SessionRow { id: string; title: string; updatedAt: string; messages: number }
const isSessionRow = (v: unknown): v is SessionRow => {
  const r = v as SessionRow | null;
  return !!r && typeof r.id === 'string' && typeof r.title === 'string';
};
interface HistoryRow { role: 'user' | 'assistant'; content: string; at: string }
const isHistoryRow = (v: unknown): v is HistoryRow => {
  const r = v as HistoryRow | null;
  return !!r && (r.role === 'user' || r.role === 'assistant') && typeof r.content === 'string';
};
/** Keybindings the chat shell actually handles (the rest of `app.*` belongs to the editor). */
const CHAT_HOTKEYS = ['app.palette.open', 'app.help.open', 'app.subagents.toggle', 'app.voice.talk', 'app.quit'] as const;

export class OctipusTuiApp {
  readonly tui: TUI;
  readonly adapter: GatewayAdapter;
  private readonly status = new StatusBar();
  private readonly messages = new MessagesPane();
  private readonly activity: ActivityLine;
  private readonly composer: Composer;
  private readonly subagents = new SubagentPanel();
  private lastStatus: string | null = null;
  private readonly overlays: OverlayController;
  /** Mutable: `/resume` re-points every later command and chat at another session. */
  private sessionId: string;
  private sessionList: SessionRow[] = [];
  /** Session to fall back to if the gateway refuses the one `/resume` switched to. */
  private sessionBeforeResume: string | null = null;
  /** Replay the resumed session's transcript on the first connect. */
  private resumePending: boolean;
  private readonly exit: (code: number) => void;
  /** Gateway WS URL — also used to derive the HTTP base for status lookups. */
  private readonly gatewayUrl?: string;
  private projectPath?: string;
  private cumulative: CumulativeStats = { tokens: 0, cost: 0, turns: 0 };
  private approvalHandle: OverlayHandle | null = null;
  private permissionHandle: OverlayHandle | null = null;
  private paletteHandle: OverlayHandle | null = null;
  private loginHandle: OverlayHandle | null = null;
  /** Most-recent role/model seen on agent.start — used to label `iter N` ticks. */
  private activeAgentRole: string | null = null;
  private activeAgentModel: string | undefined;
  /** Reply text streamed so far in the current iteration (see `delta`). */
  private streamText = '';
  private streamIteration = -1;
  /** Last pending tool line streamed to messages pane (for completion dedupe). */
  private lastStreamedTool: string | null = null;
  private exiting = false;
  private lastPlanSummary: string | null = null;
  private planPoll: ReturnType<typeof setInterval> | null = null;
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
    this.sessionId = options.sessionId ?? newSessionId();
    this.resumePending = options.sessionId !== undefined;
    this.exit = options.exit ?? ((code) => process.exit(code));
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

    // Layout: messages, blank line, activity, composer, status bar LAST.
    // The bar carries counters that have to stay readable — at the top it
    // scrolled off with the first screenful of output, which is exactly when
    // the numbers start being interesting.
    const root = new Container();
    root.addChild(this.messages);
    root.addChild(new Spacer(1));
    root.addChild(this.activity);
    root.addChild(this.subagents);
    root.addChild(this.composer);
    root.addChild(this.status);
    tui.addChild(root);
    tui.setFocus(this.composer);

    this.composer.onSubmit = (text) => this.handleSubmit(text);

    // Global hotkeys — resolved through the shared KeybindingsManager
    // installed by `createRuntime`. Users override via ~/.octipus/keybindings.json.
    tui.addInputListener((data) => {
      const kb = getKeybindings();
      if (kb.matches(data, 'app.palette.open')) { this.openCommandPalette(); return { consume: true }; }
      if (kb.matches(data, 'app.help.open')) { this.pushMessage('system', this.hotkeysText()); return { consume: true }; }
      if (kb.matches(data, 'app.quit')) { this.quit(); return { consume: true }; }
      if (kb.matches(data, 'app.voice.talk')) { void this.toggleTalk(); return { consume: true }; }
      if (kb.matches(data, 'app.subagents.toggle')) {
        this.subagents.toggle();
        this.tui.requestRender();
        return { consume: true };
      }
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

    this.status.setUser(readCliSession()?.username ?? null);
    this.welcome();
    this.adapter.on((event) => this.handleEvent(event));
  }

  async start(): Promise<void> {
    this.tui.start();
    await this.adapter.connect();
  }

  private quit(): void {
    void this.stop().then(() => this.exit(0));
  }

  /** The reply (or the turn) is complete: the streamed text is superseded. */
  private clearStream(): void {
    this.streamText = '';
    this.streamIteration = -1;
    this.messages.setLive(null);
  }

  private hotkeysText(): string {
    const kb = getKeybindings();
    const rows: Array<[string, string]> = CHAT_HOTKEYS.map((id) => [kb.getKeys(id).map(String).join(' / '), OCTIPUS_APP_KEYBINDINGS[id].description]);
    rows.push(['PageUp / PageDown', 'Scroll the transcript'], ['Up / Down', 'Composer input history'], ['\\ then Enter', 'Newline in the composer']);
    const w = Math.max(...rows.map(([k]) => k.length));
    return `Hotkeys (override in ~/.octipus/keybindings.json):\n${rows.map(([k, d]) => `  ${k.padEnd(w)}  ${d}`).join('\n')}`;
  }

  /** Replace the transcript with a session's stored conversation (`/history`, `/resume`, `--session`). */
  private renderHistory(data: unknown): void {
    const rows = Array.isArray(data) ? data.filter(isHistoryRow) : [];
    this.messages.reset();
    this.subagents.reset();
    for (const m of rows) this.messages.push({ role: m.role, content: sanitize(m.content), timestamp: new Date(m.at) });
    this.messages.scrollToBottom();
    this.pushMessage('system', `Session ${this.sessionId.slice(0, 8)} · ${rows.length} message${rows.length === 1 ? '' : 's'} replayed.`);
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
    if (this.planPoll) clearInterval(this.planPoll);
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
        if (this.planPoll) { clearInterval(this.planPoll); this.planPoll = null; }
        if (event.status === 'connected') {
          this.planPoll = setInterval(() => this.adapter.sendCommand('work-plan-status'), 4000);
          if (this.resumePending) { this.resumePending = false; this.adapter.sendCommand('history'); }
        } else if (this.lastStatus === 'connected') {
          this.lastPlanSummary = 'Unavailable · connection lost';
          this.status.setPlan(this.lastPlanSummary);
        }

        // A reconnect means the backend went away and came back: whatever
        // subagents were running belonged to the old process and will never
        // report a completion.
        if (event.status === 'connected' && this.lastStatus !== 'connected') this.subagents.reset();
        this.lastStatus = event.status;
        this.status.setStatus(event.status);
        this.tui.requestRender();
        return;
      case 'delta':
        // A new iteration means the previous text was reasoning before a tool
        // call, not the reply: keep it as its own message so the trail stays
        // visible, then start the next live block.
        if (event.iteration !== this.streamIteration) {
          if (this.streamText.trim()) this.pushMessage('assistant', this.streamText);
          this.streamText = '';
          this.streamIteration = event.iteration;
        }
        this.streamText += event.delta;
        this.messages.setLive(this.streamText);
        this.tui.requestRender();
        return;
      case 'message':
        if (event.role === 'assistant') this.clearStream();
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
        // A subagent gets its own row in the panel; the activity line stays
        // the ROOT agent's, so a fan-out doesn't make the main indicator
        // flicker between children.
        if (event.subagent && event.nodeId) {
          this.subagents.start(event.nodeId, event.role, event.model);
          this.tui.requestRender();
          return;
        }
        // Start with iteration 0 so a long-running agent isn't silent
        // between spawn and its first iteration tick (the worker emits
        // iteration_update at the TOP of each loop iteration).
        this.activeAgentRole = event.role;
        this.activeAgentModel = event.model || undefined;
        this.clearStream(); // a new turn: whatever a failed one left half-streamed is not history
        this.activity.setThinking({ role: event.role, iter: 0, model: this.activeAgentModel });
        return;
      case 'agent.iteration':
        if (this.subagents.has(event.agentId)) {
          this.subagents.iteration(event.agentId, event.iteration);
          this.tui.requestRender();
          return;
        }
        this.activity.setThinking({
          role: this.activeAgentRole ?? 'agent',
          iter: event.iteration,
          model: this.activeAgentModel,
        });
        return;
      case 'identity':
        // Single source of truth for the badge: a login, a logout, and a
        // session the gateway rejected all arrive here.
        this.status.setUser(event.user);
        this.tui.requestRender();
        return;
      case 'session.stats':
        // Authoritative: the backend counted every agent in this session from
        // the cost log, so it REPLACES the live sum accumulated below (which
        // only sees the completions this client was sent).
        this.cumulative = {
          tokens: event.stats.tokens,
          cost: event.stats.cost,
          turns: this.cumulative.turns,
        };
        this.status.setStats(this.cumulative);
        this.status.setContext(
          event.stats.contextTokens
            ? { used: event.stats.contextTokens, window: event.stats.contextWindow }
            : null,
        );
        this.tui.requestRender();
        return;
      case 'agent.end':
        if (this.subagents.has(event.nodeId)) {
          this.subagents.end(event.nodeId as string);
          this.cumulative = {
            tokens: this.cumulative.tokens + event.stats.tokens,
            cost: this.cumulative.cost + event.stats.cost,
            turns: this.cumulative.turns,
          };
          this.status.setStats(this.cumulative);
          this.tui.requestRender();
          return;
        }
        this.cumulative = {
          tokens: this.cumulative.tokens + event.stats.tokens,
          cost: this.cumulative.cost + event.stats.cost,
          turns: this.cumulative.turns + 1,
        };
        this.status.setStats(this.cumulative);
        this.activity.setTool(null);
        this.activity.setThinking(null);
        this.activeAgentRole = null;
        this.activeAgentModel = undefined;
        this.clearStream();
        this.tui.requestRender();
        return;
      case 'tool':
        // A subagent's tool calls belong to its row, not to the transcript —
        // three children fanning out used to bury the conversation under
        // somebody else's `→ websearch`.
        if (this.subagents.has(event.agentId)) {
          this.subagents.tool(event.agentId as string, event.tool);
          this.tui.requestRender();
          return;
        }
        this.activity.setTool(event.tool);
        this.streamToolEvent(event.tool);
        return;
      case 'command.result': {
        if (event.name === 'work-plan-status') {
          // Contract with the gateway command: empty text = no plan; error = unavailable.
          const summary = typeof event.result === 'string' ? event.result : '';
          const plan = event.error ? 'Unavailable' : summary || null;
          if (plan !== this.lastPlanSummary) { this.lastPlanSummary = plan; this.status.setPlan(plan); this.tui.requestRender(); }
          return;
        }
        if (event.name === 'work-plan' && !event.error && typeof event.result === 'string') {
          this.pushMessage('assistant', event.result);
          return;
        }
        if (event.name === 'history') {
          if (!event.error && Array.isArray(event.data)) {
            this.sessionBeforeResume = null;
            this.renderHistory(event.data);
            return;
          }
          // Refused or unknown: nothing may be sent under that id.
          const fallback = this.sessionBeforeResume ?? newSessionId();
          this.sessionBeforeResume = null;
          this.pushMessage('system', `Could not open session ${this.sessionId.slice(0, 8)}: ${event.error ?? String(event.result)} — continuing in ${fallback.slice(0, 8)}.`);
          this.sessionId = fallback;
          return;
        }
        if (event.name === 'sessions' && Array.isArray(event.data)) {
          this.sessionList = event.data.filter(isSessionRow);
          if (this.sessionList.length) {
            this.pushMessage('system', `/sessions:\n${String(event.result)}\n  /resume <n> reopens one.`);
            return;
          }
        }
        // The gateway's roster only knows its own commands; add the ones handled here.
        if (findSlashCommand(event.name)?.name === 'help' && !event.error && typeof event.result === 'string') {
          const local = OCTIPUS_SLASH_COMMANDS.filter((c) => c.source === 'tui')
            .map((c) => `  /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''} — ${c.description}`).join('\n');
          this.pushMessage('system', `/help: ${event.result}\n\nTUI commands:\n${local}`);
          return;
        }

        if (event.name === 'clear' && !event.error) {
          this.tui.terminal.clearScreen();
          this.messages.reset();
          // Turns counted in THIS client reset; tokens and cost do not. They
          // come from the session's cost log, which /clear does not touch, so
          // zeroing them here just made the next turn's `session.stats` snap
          // the number back up — a counter that lies until you blink.
          this.cumulative = { ...this.cumulative, turns: 0 };
          this.status.setStats(this.cumulative);
          this.status.setContext(null);
          this.subagents.reset();
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
        this.clearStream();
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

  /**
   * Sign in and reconnect as that user. The gateway connection carries the
   * principal, so the new identity only takes effect on a fresh connect.
   */
  private openLoginPrompt(): void {
    if (this.loginHandle) return;
    if (!this.gatewayUrl) {
      this.pushMessage('system', 'No gateway URL — cannot reach the login endpoint.');
      return;
    }
    const gatewayUrl = this.gatewayUrl;

    const close = () => {
      if (!this.loginHandle) return;
      this.loginHandle.hide();
      this.loginHandle = null;
      this.tui.setFocus(this.composer);
    };

    const { handle, prompt } = this.overlays.showLoginPrompt({
      username: readCliSession()?.username,
      onCancel: close,
      onSubmit: (credentials) => {
        loginWithPassword(gatewayUrl, credentials).then((result) => {
          if (!result.ok) {
            prompt.setError(result.error, { totpRequired: result.requiresTOTP });
            this.tui.requestRender();
            return;
          }
          close();
          this.pushMessage('system', `Signed in as ${result.session.username}. Reconnecting…`);
          // Past `close()` the overlay is gone, so a failure here has to reach
          // the transcript — reported into a hidden box it would leave the user
          // staring at "Reconnecting…" forever.
          this.adapter.reauthenticate()
            .then(() => this.pushMessage('system', 'Connected — this session now uses your account.'))
            .catch((err: unknown) => this.pushMessage(
              'system', `Signed in, but reconnecting failed: ${(err as Error).message}`));
        }).catch((err: unknown) => {
          prompt.setError((err as Error).message);
          this.tui.requestRender();
        });
      },
    });
    this.loginHandle = handle;
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

    // `/cost` is deliberately absent: it goes to the gateway, which reads the
    // cost log — the same totals the status bar shows, plus the input/output/
    // request split the old TUI-local counter never had.
    switch (name) {
      case 'exit':
      case 'quit':
        this.quit();
        return;
      case 'hotkeys':
        this.pushMessage('system', this.hotkeysText());
        return;
      case 'resume': {
        const n = Number(value);
        const row = Number.isInteger(n) && n >= 1
          ? this.sessionList[n - 1]
          : value ? this.sessionList.find((s) => s.id.startsWith(value)) : undefined;
        const id = row?.id ?? (/^[0-9a-f-]{36}$/i.test(value) ? value : undefined);
        if (!id) {
          this.pushMessage('system', value ? `No session matches "${value}" — run /sessions first.` : 'Usage: /resume <n|id> (see /sessions).');
          return;
        }
        this.sessionBeforeResume = this.sessionId;
        this.sessionId = id;
        this.lastPlanSummary = null;
        this.status.setPlan(null);
        this.cumulative = { tokens: 0, cost: 0, turns: 0 };
        this.status.setStats(this.cumulative);
        this.status.setContext(null);
        this.adapter.sendCommand('history');
        return;
      }
      case 'login':
        this.openLoginPrompt();
        return;
      case 'logout': {
        const session = readCliSession();
        clearCliSession();
        if (!session) {
          this.pushMessage('system', 'Not signed in — already running as the local machine account.');
          return;
        }
        this.pushMessage('system', `Signed out ${session.username}. Reconnecting as the local machine account…`);
        void this.adapter.reauthenticate().catch((err: unknown) => {
          this.pushMessage('system', `Reconnect failed: ${(err as Error).message}`);
        });
        return;
      }
      case 'whoami': {
        const session = readCliSession();
        this.pushMessage('system', session
          ? `${session.username}${session.isAdmin ? ' (admin)' : ''} · ${session.userId}`
            + (session.expiresAt ? ` · session expires ${new Date(session.expiresAt).toLocaleString()}` : '')
          : 'Signed in as the local machine account — no user account, so no personal memories, '
            + 'user-scoped vault secrets, or account settings. Use /login to sign in.');
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
