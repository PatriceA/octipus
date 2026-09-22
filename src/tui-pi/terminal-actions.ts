/** Local terminal selection and explicit clipboard requests; no gateway calls. */
import type { Terminal, TUI } from '@mariozechner/pi-tui';
import type { MessagesPane } from './components/messages-pane';

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
