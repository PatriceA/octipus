/** Local terminal selection and explicit clipboard requests; no gateway calls. */
import { type ClipboardResult, copyToClipboard, type Terminal, type TUI } from '@/tui-kit';
import { defaultClipboardEnvironment } from '@/tui-kit/clipboard';
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
 * Input listener for the inline screen, installed ahead of the apps' own (the
 * alternate screen parses mouse reports itself): mouse reporting is on for
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

/** The clipboard chain bound to this terminal: OSC 52, its last resort, is written to it. */
export function terminalClipboard(tui: Pick<TUI, 'terminal'>): (text: string) => Promise<ClipboardResult> {
  return text => copyToClipboard(text, defaultClipboardEnvironment(data => tui.terminal.write(data)));
}

/**
 * `/copy [last|transcript]`. Returns false for any other command. The copy
 * itself is asynchronous (a clipboard tool may run); `notify` reports which
 * way the text went, or that it did not.
 */
export function handleTerminalCommand(
  command: string, tui: Pick<TUI, 'terminal'>, messages: MessagesPane, notify: (text: string) => void,
  copy: (text: string) => Promise<ClipboardResult> = terminalClipboard(tui),
): boolean {
  const [name, ...args] = command.trim().replace(/^\//, '').split(/\s+/);
  const value = args.join(' ');
  if (name !== 'copy') return false;
  if (!['', 'last', 'transcript'].includes(value)) { notify('Usage: /copy [last|transcript]'); return true; }
  const text = messages.getCopyText(value === 'transcript' ? 'transcript' : 'last');
  if (!text) { notify('No assistant response to copy yet.'); return true; }
  void copy(text).then(result => notify(result.message), (error: unknown) => notify(`Not copied: ${error instanceof Error ? error.message : String(error)}`));
  return true;
}
