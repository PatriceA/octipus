/**
 * Getting the user's attention when the terminal is in the background, and
 * saying what the chat is doing in the window title.
 *
 * The terminal reports focus (`?1004`: `ESC [ I` in, `ESC [ O` out); while it
 * is out of focus, a turn ending or a decision waiting raises a notification:
 *
 *   - `bell`: BEL, which most terminals turn into an urgency hint or a sound;
 *   - `osc9`: `ESC ] 9 ; text BEL` — iTerm2, WezTerm, Windows Terminal, Ghostty, kitty;
 *   - `osc777`: `ESC ] 777 ; notify ; title ; body BEL` — VTE (GNOME Terminal, Tilix), Ghostty, foot;
 *   - `auto` (default): OSC 9 or 777 where the terminal is known to show it, the bell otherwise
 *     (and always inside tmux or screen, which do not pass desktop notifications on);
 *   - `off`.
 *
 * Set with `notify` in `~/.octipus/tui.json`. A terminal that never reports
 * focus is taken to be focused, so it is never notified.
 *
 * Text from outside never reaches the terminal as a sequence: it is reduced
 * to one printable line, `;` (the field separator) is replaced, and it is cut.
 */
import { displayLine } from '@/tui-kit';

export const NOTIFY_METHODS = ['auto', 'bell', 'osc9', 'osc777', 'off'] as const;
export type NotifyMethod = (typeof NOTIFY_METHODS)[number];
export type ChatState = 'idle' | 'working' | 'waiting';

export const FOCUS_IN = '\x1b[I';
export const FOCUS_OUT = '\x1b[O';
export const FOCUS_REPORTING_ON = '\x1b[?1004h';
export const FOCUS_REPORTING_OFF = '\x1b[?1004l';

const TEXT_MAX = 180;

/** Which notification `auto` means in this environment. */
export function resolveNotifyMethod(method: NotifyMethod, env: NodeJS.ProcessEnv = process.env): Exclude<NotifyMethod, 'auto'> {
  if (method !== 'auto') return method;
  if (env.TMUX || env.STY) return 'bell';
  const program = env.TERM_PROGRAM ?? '';
  if (/^(iTerm\.app|WezTerm|ghostty)$/i.test(program) || env.WT_SESSION || env.KITTY_WINDOW_ID || /kitty/.test(env.TERM ?? '')) return 'osc9';
  if (env.VTE_VERSION) return 'osc777';
  return 'bell';
}

/** One printable line, safe inside an OSC field. */
export function notificationText(text: string): string {
  const line = displayLine(text).replace(/;/g, ',').trim();
  return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX - 1)}…` : line;
}

/** The bytes that raise a notification, or '' for none. */
export function notificationSequence(method: Exclude<NotifyMethod, 'auto'>, title: string, body: string): string {
  const t = notificationText(title);
  const b = notificationText(body);
  switch (method) {
    case 'off': return '';
    case 'bell': return '\x07';
    case 'osc9': return `\x1b]9;${t}: ${b}\x07`;
    case 'osc777': return `\x1b]777;notify;${t};${b}\x07`;
  }
}

/** The window title for a state. */
export function titleFor(state: ChatState, project?: string): string {
  const name = project ? `Octipus — ${notificationText(project)}` : 'Octipus';
  return state === 'working' ? `${name} · working…` : state === 'waiting' ? `${name} · waiting for you` : name;
}

export interface AttentionTerminal {
  write(data: string): void;
  setTitle(title: string): void;
  /** OSC 7501 program status, for terminals that confirmed it (pi-tui writes nothing otherwise). */
  setProgramStatus?(status: { state: 'idle' | 'working' | 'blocked'; app?: string }): void;
}

export class Attention {
  private focused = true;
  private state: ChatState | null = null;
  private project: string | undefined;
  private readonly method: Exclude<NotifyMethod, 'auto'>;

  constructor(private readonly terminal: AttentionTerminal, method: NotifyMethod = 'auto', env: NodeJS.ProcessEnv = process.env) {
    this.method = resolveNotifyMethod(method, env);
  }

  /** Watch input for focus reports; true when `data` was one. */
  observe(data: string): boolean {
    if (data === FOCUS_IN) { this.focused = true; return true; }
    if (data === FOCUS_OUT) { this.focused = false; return true; }
    return false;
  }

  isFocused(): boolean { return this.focused; }
  getMethod(): Exclude<NotifyMethod, 'auto'> { return this.method; }

  /** Notify, unless the terminal has the focus (the user is looking) or notifications are off. */
  notify(body: string): void {
    if (this.focused) return;
    const sequence = notificationSequence(this.method, 'Octipus', body);
    if (sequence) this.terminal.write(sequence);
  }

  /** Put the state in the window title (written only when it changes). */
  setState(state: ChatState, project = this.project): void {
    if (state === this.state && project === this.project) return;
    this.state = state;
    this.project = project;
    this.terminal.setTitle(titleFor(state, project));
    this.terminal.setProgramStatus?.({ state: state === 'waiting' ? 'blocked' : state, app: 'octipus' });
  }
}
