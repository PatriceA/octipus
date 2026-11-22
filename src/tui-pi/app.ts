import { readClipboardImage, readImageFile } from './image-attachments';
import type { ChatAttachment } from '@/shared/chat-attachments';
import { handleTerminalCommand } from '@/tui-pi/terminal-actions';
import { ChatFooter, renderChatFrame } from './components/chat-frame';
import { createTranscriptView, type TranscriptScroll } from './components/transcript-view';
import { defaultExportName, exitSummary, transcriptMarkdown, transcriptPlainText } from './transcript-export';
import type { ClipboardResult } from '@/tui-kit';
import type { MouseMode } from './settings';
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { DecisionQueue } from '@/tui-pi/decision-queue';
import { QueuedMessages } from './components/queued-messages';
import { FuzzyList } from '@/tui-kit/fuzzy-list';
import type { TranscriptSearch } from '@/tui-kit/transcript-search';
import type { Attention } from './attention';
import { getFuzzyListTheme, getPalette, paletteForBackground, type PaletteName, setPalette, THEME_SETTINGS, type ThemeSetting } from './theme/defaults';
import { DEFAULT_SETTINGS_PATH, writeSetting } from './settings';
import { configureLinks } from './links';
import { hyperlinksEnabled } from '@/tui-kit/hyperlinks';
import { isSessionRow, parseSkillList, SKILL_MODES, type SessionRow, sessionItems, sessionPreview, skillCommand, skillItems, type SkillRow } from './pickers';
/**
 * OctipusTuiApp.
 *
 * Composes the chat surface: a scrolling transcript, and below it the
 * activity row, subagents, pi Editor as composer and the status rows, pinned
 * (docs/plans/tui-modernization.md §6). On the alternate screen the
 * transcript is a scroll view and the rest a sticky footer; inline, one
 * full-height frame. Overlays for permission prompts and the command palette
 * (Ctrl+P). Submit handler routes the TUI-local commands (see
 * `source: 'tui'` in slash-commands.ts) and forwards everything else to the
 * gateway adapter.
 *
 * State that belongs to multiple components (cumulative tokens,
 * session list, pending overlays) lives in plain fields here.
 */
import { ChatSessionPresenter, type TurnContext } from './chat-session-presenter';
import { randomUUID } from 'node:crypto';
import { Container, getKeybindings, isViewportTUI, matchesKey, type OverlayHandle, Spacer, type TUI, VStack } from '@/tui-kit';
import { loginWithPassword } from '@/core/gateway/cli-login';
import { clearCliSession, readCliSession } from '@/core/gateway/cli-session';
import { formatChangesMessage } from './changes-render';
import { ActivityLine } from './components/activity-line';
import { Composer } from './components/composer';
import { SubagentPanel } from './components/subagent-panel';
import { MessagesPane } from './components/messages-pane';
import { StatusBar } from './components/status-bar';
import { GatewayAdapter, type AgentSessionEvent } from './gateway-adapter';
import { createOverlayController, type OverlayController } from './overlays/registry';
import { OCTIPUS_APP_KEYBINDINGS } from './keybindings';
import { findSlashCommand, OCTIPUS_SLASH_COMMANDS } from './slash-commands';
import type { VoiceService } from '@/voice';
import { inlineUiFallbackText } from '@/shared/inline-ui/fence';

export interface OctipusTuiAppOptions {
  gatewayUrl?: string;
  projectPath?: string;
  /** Resume this session: its transcript is replayed once the gateway connects. */
  sessionId?: string;
  /** Process exit hook (tests swap it out). */
  exit?: (code: number) => void;
  /**
   * Optional shutdown hook. When set, /exit and /quit call this BEFORE
   * exiting the process so the runtime can restore the terminal, print
   * `farewell` (the last exchange and the resume command) to the normal
   * buffer, and drain stdin.
   */
  onShutdown?: (farewell?: string) => Promise<void>;
  /** The clipboard chain (`runtime.copy`); `/copy` falls back to the same chain bound to `tui.terminal`. */
  copy?: (text: string) => Promise<ClipboardResult>;
  /** Show the transcript in the terminal's own scrollback (`runtime.dumpToScrollback`). */
  dumpToScrollback?: (text: string) => Promise<void>;
  /** The mouse mode the runtime set up; it decides the welcome hint and whether Up/Down scroll. */
  mouse?: MouseMode;
  /** The alternate screen's transcript search (`runtime.search`), for `/search`. */
  search?: TranscriptSearch;
  /** Focus, notifications and the window title (`runtime.attention`). */
  attention?: Attention;
  /** `theme` from `~/.octipus/tui.json`; `auto` asks the terminal for its background. */
  theme?: ThemeSetting;
  /** Where `/theme` saves the choice (tests point it elsewhere). */
  settingsPath?: string;
}

const THEME_DESCRIPTIONS: Record<ThemeSetting, string> = {
  auto: 'Dark or light, from the terminal\'s background',
  dark: 'Light text on a dark background',
  light: 'Dark text on a light background',
  'high-contrast': 'White on black, the strongest colours',
};

/** Input history kept for Ctrl+R: the newest first, no repeats. */
const HISTORY_MAX = 500;

function newSessionId(): string {
  return randomUUID();
}

interface HistoryRow { role: 'user' | 'assistant'; content: string; at: string }
const isHistoryRow = (v: unknown): v is HistoryRow => {
  const r = v as HistoryRow | null;
  return !!r && (r.role === 'user' || r.role === 'assistant') && typeof r.content === 'string';
};
/** Keybindings the chat shell actually handles (the rest of `app.*` belongs to the editor). */
const CHAT_HOTKEYS = ['app.palette.open', 'app.help.open', 'app.subagents.toggle', 'app.subagents.scrollUp', 'app.subagents.scrollDown', 'app.voice.talk', 'app.transcript.dump', 'app.queue.edit', 'app.tools.toggle', 'app.history.search', 'app.copy.code', 'app.quit'] as const;

type PendingImage = { marker: string; attachment: ChatAttachment };
/** How long after the root agent finished the turn waits for its answer before it ends anyway. */
const ANSWER_GRACE_MS = 5000;

/** What `trackTurn` decided: the presenter's part, and how the turn ended if it did. */
interface TurnVerdict extends TurnContext { end?: 'reply' | 'error' | 'stopped' }

/** Turn ids of turns this client gave up on, kept to recognise their late answers. */
const ENDED_TURNS_KEPT = 32;

/** Two Escapes within this long, with no turn running, clear the draft. */
const DOUBLE_ESCAPE_MS = 1500;

/**
 * The turn this client is waiting on: from the message it sent (or the root
 * agent starting, for a turn another tab began) to its reply, an error or
 * the root agent stopping. `rootAgentId` is what Esc stops.
 */
interface RunningTurn {
  rootAgentId: string | null;
  stopping: boolean;
  /**
   * The id this client's `chat.send` carried, echoed on what ends it; null
   * for a turn another tab or the server started (any reply of the session
   * ends that one).
   */
  turnId: string | null;
  /** Esc came before anything of the turn had started on the server: stop the root as soon as it does. */
  stopWhenRootStarts?: boolean;
}

export class OctipusTuiApp {
  readonly tui: TUI;
  private readonly session: ChatSessionPresenter;
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
  private readonly decisions: DecisionQueue;
  private paletteHandle: OverlayHandle | null = null;
  private loginHandle: OverlayHandle | null = null;
  /** The login prompt opens by itself once per run; after that, /login. */
  private loginPrompted = false;
  private exiting = false;
  private readonly onShutdown?: (farewell?: string) => Promise<void>;
  private readonly copy?: (text: string) => Promise<ClipboardResult>;
  private readonly dumpToScrollback?: (text: string) => Promise<void>;
  private readonly mouse: MouseMode;
  /** The transcript's scroll view on the alternate screen; null inline, where the pane scrolls itself. */
  private readonly transcript: TranscriptScroll | null = null;
  /** A message was sent or a session resumed: the session exists on the server and can be resumed. */
  private sessionUsed = false;
  /** Lazily-built local voice (push-to-talk). Null until first talk-key press. */
  private voice: VoiceService | null = null;
  private voiceInit: Promise<VoiceService | null> | null = null;
  /** Speak the next assistant reply — armed by a voice turn so typed turns stay silent. */
  private speakNextReply = false;
  /** Guards the async windows of toggleTalk (init / transcription) against re-entrant key presses. */
  private talkBusy = false;
  private pendingImages: PendingImage[] = [];
  /** Messages typed while a turn runs; the first goes out when it ends. */
  private readonly queue = new QueuedMessages<PendingImage[]>(() => getKeybindings().getKeys('app.queue.edit').map(String).join(' / ') || 'Alt+E');
  private turn: RunningTurn | null = null;
  /** Turns of this client that ended before their answer came (stopped, disconnected): that answer is stale. */
  private readonly endedTurnIds: string[] = [];
  /** Ends the turn when its root finished but no answer came (`awaitAnswer`). */
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the last Escape was pressed, for the double Escape that clears the draft. */
  private lastEscape = 0;
  /** What was submitted from the composer, newest first (Ctrl+R). */
  private inputHistory: string[] = [];
  /** The picker open now (history, sessions, models, skills), if any. */
  private pickerHandle: OverlayHandle | null = null;
  /** The picker waiting for the gateway's list, if one is. */
  private loading: { command: 'sessions'; list: FuzzyList<SessionRow> } | { command: 'skills'; list: FuzzyList<SkillRow> } | null = null;
  private readonly search?: TranscriptSearch;
  private readonly attention?: Attention;
  private themeSetting: ThemeSetting;
  private readonly settingsPath: string;
  private imageBusy = false;
  private imageCounter = 0;

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
    this.copy = options.copy;
    this.dumpToScrollback = options.dumpToScrollback;
    this.mouse = options.mouse ?? 'app';
    this.search = options.search;
    this.attention = options.attention;
    this.themeSetting = options.theme ?? 'auto';
    this.settingsPath = options.settingsPath ?? DEFAULT_SETTINGS_PATH;
    if (this.themeSetting !== 'auto') setPalette(this.themeSetting);
    this.sessionUsed = options.sessionId !== undefined;
    this.composer = new Composer(tui, { basePath: options.projectPath ?? process.cwd() });
    this.activity = new ActivityLine(tui);
    this.overlays = createOverlayController(tui);
    this.decisions = new DecisionQueue(this.overlays, this.adapter, text => this.pushMessage('system', text), () => { if (!tui.hasOverlay?.()) tui.setFocus(this.composer); });
    this.decisions.onChange = () => {
      this.showState();
      if (this.decisions.size) this.attention?.notify('A decision is waiting for you');
    };
    this.session = new ChatSessionPresenter(tui, this.adapter, this.messages, this.status, this.activity, this.subagents, (role, text) => this.pushMessage(role, text));

    this.status.setProject(this.projectPath?.split(/[/\\]/).pop());
    configureLinks({ enabled: hyperlinksEnabled(), cwd: this.projectPath ?? process.cwd() });

    // Layout: transcript, then activity, subagents, composer, status bar LAST.
    // The bar carries counters that have to stay readable — at the top it
    // scrolled off with the first screenful of output, which is exactly when
    // the numbers start being interesting.
    const parts = { messages: this.messages, composer: this.composer, status: this.status, activity: this.activity, subagents: this.subagents, sticky: this.queue };
    this.queue.onEdit = index => this.editQueued(index);
    this.queue.onExpire = () => this.tui.requestRender();
    const rows = () => tui.terminal?.rows ?? 30;
    if (isViewportTUI(tui)) {
      // Alternate screen: every row is positioned absolutely, so a bad row damages only itself.
      this.transcript = createTranscriptView(this.messages);
      // The search reads the rendered rows: while it is open, render every message in memory.
      this.transcript.document.showAll = () => this.search?.isOpen() ?? false;
      tui.setLayoutRoot(new VStack([
        { component: this.transcript, basis: 0, grow: 1, minSize: 0 },
        { component: new ChatFooter(parts, rows), basis: 'auto', shrink: 0 },
      ]));
    } else {
      const root = new class extends Container {
        override render(width: number): string[] {
          return renderChatFrame(width, rows(), parts);
        }
      }();
      root.addChild(this.messages);
      root.addChild(new Spacer(1));
      root.addChild(this.activity);
      root.addChild(this.subagents);
      root.addChild(this.composer);
      root.addChild(this.status);
      tui.addChild(root);
    }
    tui.setFocus(this.composer);

    this.composer.onSubmit = (text) => this.handleSubmit(text);

    // Global hotkeys — resolved through the shared KeybindingsManager
    // installed by `createRuntime`. Users override via ~/.octipus/keybindings.json.
    tui.addInputListener((data) => {
      const kb = getKeybindings();
      if (this.tui.hasOverlay?.()) return undefined;
      if (kb.matches(data, 'app.palette.open')) { this.openCommandPalette(); return { consume: true }; }
      if (kb.matches(data, 'app.help.open')) { this.pushMessage('system', this.hotkeysText()); return { consume: true }; }
      if (kb.matches(data, 'app.quit')) { this.quit(); return { consume: true }; }
      if (kb.matches(data, 'app.image.attach')) { void this.attachImage(); return { consume: true }; }
      if (kb.matches(data, 'app.voice.talk')) { void this.toggleTalk(); return { consume: true }; }
      if (kb.matches(data, 'app.subagents.scrollUp')) { if (this.subagents.scroll(-1)) { this.tui.requestRender(); return { consume: true }; } }
      if (kb.matches(data, 'app.subagents.scrollDown')) { if (this.subagents.scroll(1)) { this.tui.requestRender(); return { consume: true }; } }
      if (kb.matches(data, 'app.subagents.toggle')) {
        this.subagents.toggle();
        this.tui.requestRender();
        return { consume: true };
      }
      if (kb.matches(data, 'app.transcript.dump')) { void this.dumpTranscript(); return { consume: true }; }
      if (kb.matches(data, 'app.queue.edit') && this.queue.size) { this.editQueued(); return { consume: true }; }
      if (kb.matches(data, 'app.history.search')) { this.openHistoryPicker(); return { consume: true }; }
      if (kb.matches(data, 'app.copy.code')) { handleTerminalCommand('/copy code', this.tui, this.messages, text => this.pushMessage('system', text), this.copy); return { consume: true }; }
      if (kb.matches(data, 'app.tools.toggle')) {
        this.messages.setDetail(!this.messages.getDetail());
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'escape') && !this.composer.isShowingAutocomplete()) return this.escape();
      if (this.transcript) return this.transcriptKey(this.transcript, data);
      if (this.messages.handleScrollInput(data)) {
        this.tui.requestRender();
        return { consume: true };
      }
      return undefined;
    });

    this.status.setUser(readCliSession()?.username ?? null);
    this.welcome();
    this.showState();
    this.adapter.on((event) => this.handleEvent(event));
  }

  async start(): Promise<void> {
    this.tui.start();
    if (this.themeSetting === 'auto') this.detectTheme();
    await this.adapter.connect();
  }

  /**
   * `auto`: ask the terminal for its background (OSC 11) and take the light
   * palette on a light one. A terminal that does not answer keeps dark; one
   * that answers late (over SSH) still switches.
   */
  private detectTheme(): void {
    const apply = (colors: { background?: { r: number; g: number; b: number } }) => {
      if (this.themeSetting === 'auto' && colors.background) this.applyPalette(paletteForBackground(colors.background));
    };
    this.tui.queryTerminalColors({ timeoutMs: 400, onLateReply: apply }).then(apply, (error: unknown) => {
      this.pushMessage('system', `Could not ask the terminal for its colours: ${error instanceof Error ? error.message : String(error)}. Keeping the ${getPalette().name} theme; /theme sets one.`);
    });
  }

  private applyPalette(name: PaletteName): void {
    if (getPalette().name === name) return;
    setPalette(name);
    this.tui.invalidate();
    this.tui.requestRender(true);
  }

  /** `/theme [auto|dark|light|high-contrast]`: switch now and save it in tui.json; alone, a picker. */
  private setTheme(value: string): void {
    if (!value) {
      this.openPicker<ThemeSetting>('Theme', THEME_SETTINGS.map(theme => ({ value: theme, label: theme === this.themeSetting ? `${theme}  (current)` : theme, description: THEME_DESCRIPTIONS[theme] })), theme => this.setTheme(theme));
      return;
    }
    if (!(THEME_SETTINGS as readonly string[]).includes(value)) {
      this.pushMessage('system', `Error: unknown theme "${value}": one of ${THEME_SETTINGS.join(', ')}.`);
      return;
    }
    const theme = value as ThemeSetting;
    this.themeSetting = theme;
    if (theme === 'auto') this.detectTheme();
    else this.applyPalette(theme);
    try {
      writeSetting('theme', theme, this.settingsPath);
    } catch (error) {
      this.pushMessage('system', `Error: theme ${theme} is on for now but was not saved: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.pushMessage('system', `Theme: ${theme}${theme === 'auto' ? ` (${getPalette().name} for now)` : ''}. Saved in ${this.settingsPath}.`);
  }

  /**
   * Escape with no overlay open: stop the running turn; with no turn running,
   * a second Escape within `DOUBLE_ESCAPE_MS` clears the draft (the first one
   * says so), so one stray key never loses what was typed.
   */
  private escape(): { consume: true } | undefined {
    const now = Date.now();
    const again = now - this.lastEscape < DOUBLE_ESCAPE_MS;
    this.lastEscape = now;
    if (this.turn) { this.interrupt(); return { consume: true }; }
    if (!this.composer.getText()) return undefined;
    if (again) {
      this.composer.setText('');
      this.pendingImages = [];
      this.lastEscape = 0;
      this.queue.setHint(null);
    } else {
      this.queue.setHint('Esc again to clear the draft', DOUBLE_ESCAPE_MS);
    }
    this.tui.requestRender();
    return { consume: true };
  }

  /**
   * Stop the running turn: `agent.stop` for its root agent, which also drops
   * the turns the server queued behind it; `session.stop` for this session
   * when the root is not known yet — never `/abort`, which stops the user's
   * agents in every session. Messages queued here come back to the composer
   * instead of starting a new turn.
   */
  private interrupt(): void {
    const turn = this.turn;
    if (!turn) return;
    if (turn.stopping) { this.queue.setHint('Already stopping the turn…'); this.tui.requestRender(); return; }
    const sent = turn.rootAgentId ? this.adapter.stopAgent(turn.rootAgentId) : this.adapter.stopSession(this.sessionId);
    if (!sent) {
      this.pushMessage('system', 'Error: Not connected: the turn could not be stopped. The server may still be running it; press Esc again once connected.');
      return;
    }
    turn.stopping = true;
    this.pushMessage('system', 'Stopping the turn (Esc)…');
    const queued = this.queue.drain();
    if (queued.length) {
      const draft = this.composer.getText();
      this.composer.setText([...queued.map(item => item.text), ...(draft ? [draft] : [])].join('\n'));
      for (const item of queued) this.pendingImages.push(...item.extra);
      this.queue.setHint(`${queued.length} queued message${queued.length === 1 ? ' is' : 's are'} back in the composer`, 3000);
    }
    this.tui.requestRender();
  }

  /** Take a queued message (the newest by default) back into the composer, ahead of what is typed there. */
  private editQueued(index?: number): void {
    const item = this.queue.take(index);
    if (!item) return;
    const draft = this.composer.getText();
    this.composer.setText(draft ? `${item.text}\n${draft}` : item.text);
    this.pendingImages.push(...item.extra);
    this.queue.setHint('Edit and send it again, or clear it with Esc Esc', 3000);
    this.tui.setFocus(this.composer);
    this.tui.requestRender();
  }

  /** The turn is over (reply, error, stop): say so if nobody is looking, then send the first queued message as the next one. */
  private endTurn(outcome: 'reply' | 'error' | 'stopped' = 'reply'): void {
    if (!this.turn) return;
    this.forgetTurn();
    this.showState();
    if (!this.queue.size) this.attention?.notify(outcome === 'reply' ? 'The reply is ready' : outcome === 'error' ? 'The turn failed' : 'The turn was stopped');
    if (this.lastStatus === 'connected') this.sendNextQueued();
  }

  /** The window title (and OSC 7501 status) says whether the chat waits for the user, works, or is idle. */
  private showState(): void {
    this.attention?.setState(this.decisions.size ? 'waiting' : this.turn ? 'working' : 'idle', this.projectPath?.split(/[/\\]/).pop());
  }

  /** Drop the running turn, remembering its id so a late answer to it is recognised as stale. */
  private forgetTurn(): void {
    const id = this.turn?.turnId;
    this.turn = null;
    if (this.answerTimer) { clearTimeout(this.answerTimer); this.answerTimer = null; }
    if (!id) return;
    this.endedTurnIds.push(id);
    if (this.endedTurnIds.length > ENDED_TURNS_KEPT) this.endedTurnIds.shift();
  }

  /**
   * Whose answer a reply or failure of this session (`turnId` as echoed) is:
   * the running turn's (`current`), one of an earlier turn this client already
   * ended (`stale`), or neither — a background reply, another tab's turn.
   */
  private answerOf(turnId: string | undefined): 'current' | 'stale' | 'other' {
    if (turnId && this.endedTurnIds.includes(turnId)) return 'stale';
    if (!this.turn) return 'other';
    if (this.turn.turnId === null) return 'current';
    return turnId === this.turn.turnId ? 'current' : 'other';
  }

  private sendNextQueued(): void {
    this.queue.waitingFor = this.adapter.isConnected() ? 'turn' : 'connection';
    const next = this.queue.shift();
    if (!next) return;
    this.sendNow(next.text, next.extra, 'queue');
    this.tui.requestRender();
  }

  /**
   * Send a gateway command; when it cannot go out (not connected), say so
   * instead of waiting for an answer that never comes.
   */
  private command(name: string, args?: Record<string, string>): boolean {
    if (this.adapter.sendCommand(name, args)) return true;
    this.pushMessage('system', `Error: Not connected: /${name} was not sent. Run it again once the status bar says connected.`);
    return false;
  }

  /** A message that could not go out: back to the front of the queue, sent when the connection is back. */
  private holdForConnection(text: string, images: PendingImage[]): void {
    this.queue.unshift({ text, extra: images });
    this.queue.waitingFor = 'connection';
    this.queue.setHint('Not connected: the message waits in the queue and goes out when the connection is back', 4000);
    this.tui.requestRender();
  }

  /**
   * Track the running turn from the gateway's events. Only what is tied to
   * this turn ends it: its reply or failure (by `turnId`), its root agent
   * stopped, this session's stop. Returns what the presenter must know (a
   * stale answer must not wipe the live reply of the next turn) and how the
   * turn ended, if it did: `handleEvent` ends it only AFTER the event is in
   * the transcript, so the next queued message goes below the reply it
   * waited for.
   */
  private trackTurn(event: AgentSessionEvent): TurnVerdict {
    switch (event.kind) {
      case 'agent.start':
        // Only the root agent is the turn; a worker it spawned never takes its place as what Esc stops.
        if (!event.root) return {};
        if (this.turn) this.turn.rootAgentId = event.nodeId ?? this.turn.rootAgentId;
        else this.turn = { rootAgentId: event.nodeId ?? null, stopping: false, turnId: null };
        if (this.turn.stopWhenRootStarts && this.turn.rootAgentId) {
          this.turn.stopWhenRootStarts = false;
          this.adapter.stopAgent(this.turn.rootAgentId);
        }
        this.showState();
        return {};
      case 'session.stopped':
        if (!this.turn) return {};
        if (event.stopped || event.droppedQueued) return { end: 'stopped' };
        // The message is still on its way into the session's queue: nothing
        // of it runs yet, so stop its root the moment it starts.
        if (this.turn.stopping && !this.turn.rootAgentId) {
          this.turn.stopWhenRootStarts = true;
          this.pushMessage('system', 'Nothing of the turn was running yet; it is stopped as soon as it starts.');
        }
        return {};
      case 'message': {
        if (event.role !== 'assistant' || event.progress || event.messageId) return {};
        const whose = this.answerOf(event.turnId);
        return { stale: whose === 'stale', ...(whose === 'current' ? { end: 'reply' as const } : {}) };
      }
      case 'chat.error': {
        const whose = this.answerOf(event.turnId);
        if (whose !== 'current' || !this.turn) return { stale: whose === 'stale' };
        // This client's own send reported it with an `error` frame already;
        // a turn another tab started is told here.
        if (this.turn.turnId === null && !event.cancelled) this.pushMessage('system', `Error: The turn failed: ${event.message}`);
        return { end: this.turn.stopping || event.cancelled ? 'stopped' : 'error' };
      }
      case 'agent.end':
        // A positive match only: an agent the server does not mark as the
        // root (every worker) never ends the turn, whatever its id. Even the
        // root finishing does not end it: its answer (`chat.response`,
        // `chat.error`) follows, and the turn ends on that — ending here sent
        // the next queued message above the reply it waited for. If no
        // answer comes, the turn ends after a grace period.
        if (this.turn && event.root && (this.turn.rootAgentId === null || event.nodeId === this.turn.rootAgentId)) this.awaitAnswer(this.turn);
        return {};
      case 'agent.stopped':
        // The root by id, or — before its id is known — an agent the server
        // marks as a root (the adapter already dropped other sessions').
        if (this.turn && (event.agentId === this.turn.rootAgentId || (event.root === true && this.turn.rootAgentId === null))) return { end: 'stopped' };
        return {};
      case 'error':
        // Only an error frame answering this turn's send ends it; a rate
        // limit, an expired approval, dropped events or a late CHAT_ERROR of a
        // stopped turn are shown and nothing more.
        if (this.turn?.turnId && event.turnId === this.turn.turnId) return { endsTurn: true, end: this.turn.stopping ? 'stopped' : 'error' };
        return {};
      case 'delivery':
        if (!this.turn?.turnId || event.turnId !== this.turn.turnId) return {};
        // Folded into a turn already running (another tab's): no answer of
        // its own comes; the running turn's answer ends this one.
        if (event.outcome === 'steered') this.turn.turnId = null;
        if (event.outcome === 'refused') {
          this.pushMessage('system', `Error: Message not delivered: ${event.reason ?? 'the gateway refused it'}.`);
          return { end: 'error' };
        }
        return {};
      case 'status':
        if (event.status === 'connected') { this.queue.waitingFor = 'turn'; if (!this.turn) this.sendNextQueued(); }
        else {
          this.forgetTurn();
          this.queue.waitingFor = 'connection';
        }
        return {};
      default:
        return {};
    }
  }

  /** The root finished; its answer is on the way. End the turn anyway if it never comes (events dropped). */
  private awaitAnswer(turn: RunningTurn): void {
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = setTimeout(() => {
      this.answerTimer = null;
      if (this.turn === turn) this.endTurn();
    }, ANSWER_GRACE_MS);
    this.answerTimer.unref?.();
  }

  private quit(): void {
    void this.stop(exitSummary(this.messages.entries(), this.sessionUsed ? this.sessionId : null)).then(() => this.exit(0));
  }

  /**
   * Keys for the alternate-screen transcript that the scroll view does not
   * take itself (it has PageUp/PageDown and Ctrl+Home/End): End returns to
   * the latest while reading history; with `tui.mouse: native` the wheel
   * arrives as Up/Down, which scroll while the composer is empty.
   */
  private transcriptKey(transcript: TranscriptScroll, data: string): { consume: true } | undefined {
    if (matchesKey(data, 'end') && !transcript.isFollowingEnd) { transcript.scrollToEnd(); return { consume: true }; }
    if (this.mouse === 'native' && this.composer.getText() === '' && !this.composer.isShowingAutocomplete()) {
      if (matchesKey(data, 'up')) { transcript.scrollBy(-3); return { consume: true }; }
      if (matchesKey(data, 'down')) { transcript.scrollBy(3); return { consume: true }; }
    }
    return undefined;
  }

  /** The transcript in the terminal's own scrollback, for its search and selection; any key comes back. */
  private async dumpTranscript(): Promise<void> {
    if (!this.dumpToScrollback) { this.pushMessage('system', 'This terminal session cannot show the transcript in scrollback.'); return; }
    await this.dumpToScrollback(transcriptPlainText(this.messages.entries()));
  }

  /** `/export [path]`: the transcript as Markdown, never over an existing file. */
  private exportTranscript(path: string): void {
    const target = resolvePath(this.projectPath ?? process.cwd(), path || defaultExportName(this.sessionId, new Date()));
    const entries = this.messages.entries();
    try {
      writeFileSync(target, transcriptMarkdown(entries, this.sessionId, new Date()), { flag: 'wx' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.pushMessage('system', `Error: transcript not exported: ${code === 'EEXIST' ? `${target} already exists; give another path` : error instanceof Error ? error.message : String(error)}.`);
      return;
    }
    const { dropped } = this.messages.size();
    this.pushMessage('system', `Exported ${entries.length} message${entries.length === 1 ? '' : 's'} to ${target}${dropped ? ` (${dropped} older ones were no longer in memory)` : ''}.`);
  }

  private hotkeysText(): string {
    const kb = getKeybindings();
    const rows: Array<[string, string]> = CHAT_HOTKEYS.map((id) => [kb.getKeys(id).map(String).join(' / '), OCTIPUS_APP_KEYBINDINGS[id].description]);
    rows.push(['Esc', 'Stop the running turn; with none running, twice clears the draft'], ['PageUp / PageDown', 'Scroll the transcript'], ['Up / Down', 'Composer input history'], ['\\ then Enter', 'Newline in the composer']);
    if (this.transcript) rows.push(['Ctrl+F / Ctrl+Shift+F', 'Search the transcript: Enter / Shift+Enter next / previous, Esc returns to where you were'], ['Drag', 'Select and copy transcript text (Shift+drag: the terminal selects)']);
    const w = Math.max(...rows.map(([k]) => k.length));
    return `Hotkeys (override in ~/.octipus/keybindings.json):\n${rows.map(([k, d]) => `  ${k.padEnd(w)}  ${d}`).join('\n')}`;
  }

  /** Replace the transcript with a session's stored conversation (`/history`, `/resume`, `--session`). */
  private renderHistory(data: unknown): void {
    const rows = Array.isArray(data) ? data.filter(isHistoryRow) : [];
    this.messages.reset();
    this.subagents.reset();
    for (const m of rows) this.messages.push({ role: m.role, content: m.content, timestamp: new Date(m.at) });
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

  async stop(farewell?: string): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    this.activity.dispose();
    this.forgetTurn();
    this.decisions.dispose();
    this.queue.dispose();
    this.session.dispose();
    if (this.voice) { void this.voice.dispose().catch(() => { /* best-effort */ }); }
    try { this.adapter.disconnect(); } catch { /* already disconnected */ }
    // Hand off to the runtime so the terminal is restored and stdin is
    // drained. Without this the shell's next prompt redraws on top of the
    // TUI border instead of starting on a fresh line.
    if (this.onShutdown) {
      try { await this.onShutdown(farewell); } catch (error) {
        process.stderr.write(`Shutdown did not finish: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  // ── UI plumbing ────────────────────────────────────────────────

  private welcome(): void {
    const projectName = this.projectPath?.split(/[/\\]/).pop();
    const greeting = projectName
      ? `Welcome to Octipus. Project: ${projectName}`
      : 'Welcome to Octipus.';
    const mouse = this.mouse === 'off' ? '' : !this.transcript ? 'Wheel: scroll · Shift+drag: select · '
      : this.mouse === 'app' ? 'Wheel: scroll · drag: select and copy · ' : 'Wheel: scroll · select as usual · ';
    this.pushMessage('system', `${greeting}  Type a message or /help. ${mouse}/copy last: copy reply.`);
  }

  private pushMessage(role: 'user' | 'assistant' | 'system', content: string): void {
    // Live-tail rule: only auto-pin to the bottom when the user is
    // already there. Mid-scroll messages stay out of view until the
    // user explicitly returns to the latest.
    const wasAtBottom = this.messages.getScrollOffset() === 0;
    // Interactive answers render only in the web app: a plain line here.
    const text = role === 'assistant' ? inlineUiFallbackText(content) : content;
    this.messages.push({ role, content: text.replace(/^Error: /, ''), tone: /^Error:|^✗/.test(content) ? 'error' : 'notice', timestamp: new Date() });
    if (wasAtBottom) this.messages.scrollToBottom();
    this.tui.requestRender();
  }

  // ── Event handling ─────────────────────────────────────────────

  private handleEvent(event: AgentSessionEvent): void {
    if (event.kind === 'message' && !event.progress && event.role === 'assistant' && this.speakNextReply) {
      this.speakNextReply = false;
      void this.voice?.say(event.content).catch(() => {});
    }
    const turn = this.trackTurn(event);
    this.present(event, turn);
    // After the event is shown: the next queued message goes below the reply.
    if (turn.end) this.endTurn(turn.end);
  }

  private present(event: AgentSessionEvent, turn: TurnContext): void {
    if (this.session.handleEvent(event, turn)) return;
    switch (event.kind) {
      case 'status':
        // Reconnect bookkeeping (subagent reset, plan poll) lives in the presenter.
        if (event.status === 'connected' && this.resumePending) this.resumePending = !this.adapter.sendCommand('history');
        this.lastStatus = event.status;
        return;
      case 'permission.resolved': this.decisions.resolve(event.requestId, event.status); return;
      case 'login_required':
        // No stored login, or the gateway rejected it. Ask once; if the user
        // dismisses the prompt, /login brings it back.
        if (this.loginPrompted) {
          this.pushMessage('system', `${event.reason}. Use /login to sign in.`);
          return;
        }
        this.loginPrompted = true;
        this.pushMessage('system', `${event.reason}. Sign in with your Octipus account to continue.`);
        this.openLoginPrompt();
        return;
      case 'permission':
        this.decisions.push(event);
        return;
      case 'approval':
        this.decisions.push(event);
        return;
      case 'command.result': {
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
        if (this.loading && event.name === this.loading.command) {
          this.fillPicker(event);
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
          // Inline, the terminal's screen holds the old frame: erase it. On
          // the alternate screen the renderer owns every row and redraws only
          // the changed ones — an ESC[2J under it left the composer and the
          // status rows blank — so redraw the whole screen instead.
          if (this.transcript) this.tui.requestRender(true);
          else this.tui.terminal.clearScreen();
          this.messages.reset();
          // Turns counted in THIS client reset; tokens and cost do not. They
          // come from the session's cost log, which /clear does not touch, so
          // zeroing them here just made the next turn's `session.stats` snap
          // the number back up — a counter that lies until you blink.
          this.session.cumulative = { ...this.session.cumulative, turns: 0 };
          this.status.setStats(this.session.cumulative);
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
        this.pushMessage('system', `${event.error ? 'Error: ' : ''}/${event.name}: ${content}`);
        return;
      }
      case 'agent.write':
      case 'agent.edit':
      case 'agent.stopped':
      case 'session.stopped':
      case 'delivery':
        return;
    }
  }

  // ── Submit / commands ──────────────────────────────────────────

  private handleSubmit(rawText: string): void {
    this.remember(rawText);
    if (rawText.trim().startsWith('/') && handleTerminalCommand(rawText, this.tui, this.messages, text => this.pushMessage('system', text), this.copy)) return;
    const text = rawText.trim();
    if (!text) return;

    // A new submission disarms any stale voice-reply flag, so a voice turn that
    // errored (no assistant message) can't cause a later TYPED turn to be spoken.
    // The voice path re-arms it right after calling this.
    this.speakNextReply = false;

    if (text.startsWith('/')) {
      this.pushMessage('user', text);
      this.handleCommand(text.slice(1));
      return;
    }
    const images = this.pendingImages.filter(image => text.includes(image.marker));
    this.pendingImages = [];
    // A turn is running: hold the message, visibly, until it ends.
    if (this.turn) {
      this.queue.push({ text, extra: images });
      this.tui.requestRender();
      return;
    }
    // Not connected: a frame sent now is dropped by the socket. Hold it,
    // visibly, and send it when the connection is back.
    if (!this.adapter.isConnected()) {
      this.queue.push({ text, extra: images });
      this.queue.waitingFor = 'connection';
      this.queue.setHint('Not connected: the message goes out when the connection is back', 4000);
      this.tui.requestRender();
      return;
    }
    this.sendNow(text, images);
  }

  /** Send a chat message now; it starts the turn this client waits on. `queue` never steers a turn another tab started. */
  private sendNow(text: string, images: PendingImage[], mode?: 'queue'): void {
    const turnId = randomUUID();
    if (images.length) {
      this.startTurn(text, turnId);
      void this.sendWithImages(text, images, turnId, mode);
      return;
    }
    if (!this.adapter.sendChat(this.sessionId, text, this.projectPath, undefined, mode, turnId)) { this.notSent(text, images); return; }
    this.startTurn(text, turnId);
  }

  private startTurn(text: string, turnId: string): void {
    this.pushMessage('user', text);
    this.sessionUsed = true;
    this.turn = { rootAgentId: null, stopping: false, turnId };
    this.showState();
  }

  /**
   * `sendChat` did not put the message on the wire. Disconnected: it waits in
   * the queue for the connection. Connected: the client refused it (over the
   * frame cap, and said so) — it goes back to the composer to shorten.
   */
  private notSent(text: string, images: PendingImage[]): void {
    if (!this.adapter.isConnected()) { this.holdForConnection(text, images); return; }
    const draft = this.composer.getText();
    this.composer.setText(draft ? `${text}\n${draft}` : text);
    this.pendingImages.push(...images);
    this.tui.requestRender();
  }

  /**
   * Upload the message's images over REST, then send the turn naming them
   * (`fileRefs`), as the web does: the gateway frame carries no file bytes,
   * so its size cap does not limit the image. A session the server has not
   * seen yet is created by the upload, and the TUI continues in it.
   */
  private async sendWithImages(text: string, images: PendingImage[], turnId: string, mode?: 'queue'): Promise<void> {
    const from = this.sessionId;
    let prepared: Awaited<ReturnType<GatewayAdapter['uploadAttachments']>>;
    try {
      prepared = await this.adapter.uploadAttachments(from, images.map(image => image.attachment), text);
    } catch (error) {
      this.pushMessage('system', `Message not sent: the image upload failed (${error instanceof Error ? error.message : String(error)}). Attach it again.`);
      this.endTurn('error');
      return;
    }
    if (this.sessionId !== from) return; // switched sessions while uploading
    this.sessionId = prepared.sessionId;
    const content = [text, ...prepared.uploaded.map(file => `Attached file: ${file.path}`)].join('\n\n');
    const refs = prepared.uploaded.map(file => ({ path: file.path }));
    if (this.adapter.sendChat(prepared.sessionId, content, this.projectPath, refs, mode, turnId)) return;
    // The connection went while uploading: the turn never started here.
    if (this.turn?.turnId === turnId) { this.turn = null; this.showState(); }
    this.pushMessage('system', 'Not sent yet: the connection went while the image uploaded.');
    this.notSent(text, images);
  }

  private async attachImage(path?: string): Promise<void> {
    if (this.imageBusy) return;
    if (this.pendingImages.length >= 10) { this.pushMessage('system', 'Attach at most 10 images per message.'); return; }
    this.imageBusy = true;
    const sessionId = this.sessionId;
    try {
      const attachment = path ? await readImageFile(path, this.projectPath ?? process.cwd()) : await readClipboardImage();
      if (this.sessionId !== sessionId) return;
      const marker = `[image${++this.imageCounter}]`;
      this.pendingImages.push({ marker, attachment });
      this.composer.insertTextAtCursor(marker + ' ');
      this.pushMessage('system', `${marker} received: ${attachment.name}. Send your message to pass it to the agent.`);
      // Drawn where the terminal draws images; a line naming it elsewhere.
      this.messages.pushItem({ kind: 'image', name: attachment.name, mimeType: attachment.mimeType, data: attachment.data });
      if (this.messages.getScrollOffset() === 0) this.messages.scrollToBottom();
      this.tui.requestRender();
    } catch (error) {
      this.pushMessage('system', `Image not attached: ${error instanceof Error ? error.message : String(error)}`);
    } finally { this.imageBusy = false; }
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
   * Build the voice service on first use (keeps voice deps off the TUI
   * startup path): local recording and playback, the server's speech lanes.
   * Returns null — with a one-line reason — when the server has no
   * speech-to-text configured.
   */
  private async ensureVoice(): Promise<VoiceService | null> {
    if (this.voice) return this.voice;
    if (this.voiceInit) return this.voiceInit;
    this.voiceInit = (async () => {
      try {
        // Recorded and played here; transcribed and spoken by the engines the
        // install binds to the Transcription and Speech lanes (/api/voice).
        const base = this.httpBase();
        const token = readCliSession()?.token;
        if (!base || !token) {
          this.pushMessage('system', 'Voice needs a signed-in connection to the server.');
          return null;
        }
        const target = { baseUrl: base, token };
        const status = await fetch(`${base}/api/voice/status`, { headers: { Authorization: `Bearer ${token}` } })
          .then((r) => r.json() as Promise<{ sttAvailable?: boolean; sttReason?: string | null; ttsAvailable?: boolean }>)
          .catch(() => null);
        if (!status?.sttAvailable) {
          this.pushMessage('system', `Voice unavailable: ${status?.sttReason ?? 'the server could not be asked'}`);
          return null;
        }
        const { VoiceService } = await import('@/voice');
        const { SpeechToText } = await import('@/voice/stt');
        const { TextToSpeech } = await import('@/voice/tts');
        const { RemoteSTTEngine, RemoteTTSEngine } = await import('@/voice/remote-engines');
        this.voice = new VoiceService(
          new SpeechToText(new RemoteSTTEngine(target)),
          status.ttsAvailable ? new TextToSpeech(new RemoteTTSEngine(target)) : undefined,
        );
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

  private remember(text: string): void {
    const entry = text.trim();
    if (!entry) return;
    this.inputHistory = [entry, ...this.inputHistory.filter(item => item !== entry)].slice(0, HISTORY_MAX);
  }

  /** Open a picker; one at a time. `onChoose` runs after it closed. */
  private openPicker<T>(title: string, items: Array<{ value: T; label: string; description?: string }>, onChoose: (value: T) => void, preview?: (value: T) => string, emptyText?: string): FuzzyList<T> | null {
    if (this.pickerHandle) return null;
    const close = () => {
      this.pickerHandle?.hide();
      this.pickerHandle = null;
      this.loading = null;
      this.tui.setFocus(this.composer);
      this.tui.requestRender();
    };
    const list = new FuzzyList<T>({
      title, items, emptyText, theme: getFuzzyListTheme(),
      preview: preview ? item => preview(item.value) : undefined,
      onSelect: item => { close(); onChoose(item.value); },
      onCancel: close,
    });
    this.pickerHandle = this.overlays.showPicker(list);
    return list;
  }

  /** Re-point every later command and chat at another session and replay its transcript. */
  private resumeSession(id: string): void {
    this.sessionBeforeResume = this.sessionId;
    this.pendingImages = [];
    this.forgetTurn();
    if (this.queue.size) this.pushMessage('system', `${this.queue.drain().length} queued message(s) dropped: they were for the previous session.`);
    this.sessionId = id;
    this.sessionUsed = true;
    this.session.reset();
    // Not connected: replayed on connect instead.
    this.resumePending = !this.adapter.sendCommand('history');
  }

  /** `/sessions` or `/resume` alone: pick a session to resume; it opens at once and fills when the list arrives. */
  private openSessionPicker(): void {
    const list = this.openPicker<SessionRow>('Sessions', [], row => {
      if (row.id === this.sessionId) { this.pushMessage('system', 'That is this session.'); return; }
      this.resumeSession(row.id);
    }, sessionPreview, 'Loading sessions…');
    if (!list) return;
    if (!this.adapter.sendCommand('sessions')) { list.setItems([], 'Not connected: the sessions cannot be listed now.'); return; }
    this.loading = { command: 'sessions', list };
  }

  /** `/skills` alone: pick a skill, then how it is used. */
  private openSkillPicker(): void {
    const list = this.openPicker<SkillRow>('Skills', [], skill => {
      this.openPicker('How to use: ' + skill.name, SKILL_MODES.map(entry => ({ value: entry.mode, label: entry.label, description: entry.description })), mode => {
        this.pushMessage('user', `/skills ${skillCommand(skill, mode)}`);
        this.command('skills', { value: skillCommand(skill, mode) });
      });
    }, skill => `${skill.name}\nId: ${skill.id}\nNow: ${skill.mode}${skill.available ? '' : '\nNot available to you any more.'}\nEnter chooses Automatic, Always or This session.`, 'Loading skills…');
    if (!list) return;
    if (!this.adapter.sendCommand('skills')) { list.setItems([], 'Not connected: the skills cannot be listed now.'); return; }
    this.loading = { command: 'skills', list };
  }

  /** The list a picker was waiting for arrived (or failed). */
  private fillPicker(event: Extract<AgentSessionEvent, { kind: 'command.result' }>): void {
    const loading = this.loading;
    this.loading = null;
    if (!loading) return;
    if (event.error) { loading.list.setItems([], `Could not load: ${event.error}`); this.tui.requestRender(); return; }
    if (loading.command === 'sessions') {
      this.sessionList = Array.isArray(event.data) ? event.data.filter(isSessionRow) : [];
      loading.list.setItems(sessionItems(this.sessionList, this.sessionId), 'No sessions yet.');
    } else {
      const parsed = parseSkillList(typeof event.result === 'string' ? event.result : '');
      if ('unreadable' in parsed) loading.list.setItems([], parsed.unreadable || 'The server sent no skill list.');
      else loading.list.setItems(skillItems(parsed.rows), 'No skills available.');
    }
    this.tui.requestRender();
  }

  /** Ctrl+R: find something sent before and put it back in the composer. */
  private openHistoryPicker(): void {
    const items = this.inputHistory.map(text => ({ value: text, label: text.split('\n')[0] ?? text, description: text.includes('\n') ? `+${text.split('\n').length - 1} lines` : undefined }));
    this.openPicker('Input history', items, text => { this.composer.setText(text); }, text => text, 'Nothing sent yet in this run');
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

    // Gateway commands that open a picker when given nothing; with an
    // argument they go to the gateway as text (`/sessions list` lists).
    if (name === 'sessions' && !value) { this.openSessionPicker(); return; }
    if (name === 'skills' && !value) { this.openSkillPicker(); return; }

    // `/cost` is deliberately absent: it goes to the gateway, which reads the
    // cost log — the same totals the status bar shows, plus the input/output/
    // request split the old TUI-local counter never had.
    switch (name) {
      case 'attach':
        void this.attachImage(value || undefined); return;
      case 'plan-hide':
        this.status.setPlanDetails(null); this.tui.requestRender(); return;
      case 'exit':
      case 'quit':
        this.quit();
        return;
      case 'hotkeys':
        this.pushMessage('system', this.hotkeysText());
        return;
      case 'export':
        this.exportTranscript(value);
        return;
      case 'scrollback':
        void this.dumpTranscript();
        return;
      case 'theme':
        this.setTheme(value);
        return;
      case 'search':
        if (!this.search) { this.pushMessage('system', 'Transcript search needs the alternate screen; it is not available with --inline.'); return; }
        if (!this.search.isOpen()) this.search.toggle();
        return;
      case 'resume': {
        if (!value) { this.openSessionPicker(); return; }
        const n = Number(value);
        const row = Number.isInteger(n) && n >= 1
          ? this.sessionList[n - 1]
          : value ? this.sessionList.find((s) => s.id.startsWith(value)) : undefined;
        const id = row?.id ?? (/^[0-9a-f-]{36}$/i.test(value) ? value : undefined);
        if (!id) {
          this.pushMessage('system', `No session matches "${value}" — run /sessions first.`);
          return;
        }
        this.resumeSession(id);
        return;
      }
      case 'login':
        this.openLoginPrompt();
        return;
      case 'logout': {
        const session = readCliSession();
        clearCliSession();
        if (!session) {
          this.pushMessage('system', 'Not signed in. Use /login to sign in.');
          return;
        }
        this.pushMessage('system', `Signed out ${session.username}. Use /login to sign in again.`);
        // Drop the connection: it still carries the old principal.
        this.adapter.disconnect();
        return;
      }
      case 'whoami': {
        const session = readCliSession();
        this.pushMessage('system', session
          ? `${session.username}${session.isAdmin ? ' (admin)' : ''} · ${session.userId}`
            + (session.expiresAt ? ` · session expires ${new Date(session.expiresAt).toLocaleString()}` : '')
          : 'Not signed in. Use /login to sign in.');
        return;
      }
      case 'project': {
        if (!value) {
          this.pushMessage('system', `Current project: ${this.projectPath ?? '(none)'}`);
        } else {
          this.projectPath = value;
          this.status.setProject(value.split(/[/\\]/).pop());
          configureLinks({ enabled: hyperlinksEnabled(), cwd: value });
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
        this.command(name, args);
    }
  }
}
