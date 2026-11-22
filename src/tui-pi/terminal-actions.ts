/** Local terminal selection and explicit clipboard requests; no gateway calls. */
import type { Terminal, TUI } from '@mariozechner/pi-tui';
import type { MessagesPane } from './components/messages-pane';

/** An SGR mouse report: `ESC [ < button ; x ; y M` for a press, `… m` for a release. */
export interface MouseReport { button: number; column: number; row: number; release: boolean }

export function parseMouseReport(data: string): MouseReport | null {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (!match) return null;
  return { button: Number(match[1]), column: Number(match[2]), row: Number(match[3]), release: match[4] === 'm' };
}

/** Vertical wheel notches only; horizontal wheel (66/67) and releases are not scrolling. */
export function wheelDirection(data: string): 'up' | 'down' | null {
  const report = parseMouseReport(data);
  if (!report || report.release || !(report.button & 64)) return null;
  if ((report.button & 3) === 0) return 'up';
  if ((report.button & 3) === 1) return 'down';
  return null;
}

/**
 * Input listener, installed ahead of the apps' own: mouse reporting is on for
 * the wheel, so clicks, drags and releases arrive too. None of them means
 * anything to a component yet, and a report that reached a text field could
 * be taken for typing. A wheel notch goes on to the app's scroll handling
 * unless an overlay is open — overlays do not scroll.
 */
export function mouseReportFilter(tui: Pick<TUI, 'hasOverlay'>): (data: string) => { consume: true } | undefined {
  return data => {
    if (!parseMouseReport(data)) return undefined;
    return wheelDirection(data) && !tui.hasOverlay() ? undefined : { consume: true };
  };
}

export function setMouseCapture(terminal: Pick<Terminal, 'write'>, enabled: boolean): void {
  terminal.write(enabled ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
}

export function handleTerminalCommand(
  command: string, tui: TUI, messages: MessagesPane, notify: (text: string) => void,
): boolean {
  const [name, ...args] = command.trim().replace(/^\//, '').split(/\s+/);
  const value = args.join(' ');
  if (name !== 'copy') return false;
  if (!['', 'last', 'transcript'].includes(value)) { notify('Usage: /copy [last|transcript]'); return true; }
  const text = messages.getCopyText(value === 'transcript' ? 'transcript' : 'last');
  if (!text) { notify('No assistant response to copy yet.'); return true; }
  // OSC 52 is available in many local/SSH terminals without a clipboard helper.
  // Terminals can reject it, so do not claim clipboard success without an ack.
  if (Buffer.byteLength(text, 'utf8') > 75_000) {
    notify('Text exceeds the terminal clipboard request limit. Use /copy last for one response, or Shift+drag to select sections.');
    return true;
  }
  tui.terminal.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
  notify('Clipboard request sent to your terminal. If paste is empty, enable OSC 52 clipboard access or Shift+drag and use your terminal’s Copy command.');
  return true;
}
