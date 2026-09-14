/** Local terminal selection and explicit clipboard requests; no gateway calls. */
import type { Terminal, TUI } from '@mariozechner/pi-tui';
import type { MessagesPane } from './components/messages-pane';
import type { StatusBar } from './components/status-bar';

const capture = new WeakMap<object, boolean>();
export function setMouseCapture(terminal: Pick<Terminal, 'write'>, enabled: boolean): void {
  terminal.write(enabled ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
  capture.set(terminal, enabled);
}

export function handleTerminalCommand(
  command: string, tui: TUI, messages: MessagesPane, status: StatusBar, notify: (text: string) => void,
): boolean {
  const [name, ...args] = command.trim().replace(/^\//, '').split(/\s+/);
  const value = args.join(' ');
  if (name === 'mouse') {
    if (!['', 'on', 'off'].includes(value)) { notify('Usage: /mouse [on|off]'); return true; }
    const enabled = value ? value === 'on' : !(capture.get(tui.terminal) ?? false);
    setMouseCapture(tui.terminal, enabled);
    status.setMouseCaptured(enabled);
    messages.setMouseCaptured(enabled);
    notify(enabled ? 'Mouse wheel scrolls chat; text selection now needs Shift+drag. /mouse off or Alt+M returns the mouse to the terminal.'
      : 'Mouse returned to the terminal: drag to select, copy with your terminal’s Copy command (usually Ctrl+Shift+C). PageUp/PageDown scroll chat; /mouse on or Alt+M captures the wheel.');
    return true;
  }
  if (name !== 'copy') return false;
  if (!['', 'last', 'transcript'].includes(value)) { notify('Usage: /copy [last|transcript]'); return true; }
  const text = messages.getCopyText(value === 'transcript' ? 'transcript' : 'last');
  if (!text) { notify('No assistant response to copy yet.'); return true; }
  // OSC 52 is available in many local/SSH terminals without a clipboard helper.
  // Terminals can reject it, so do not claim clipboard success without an ack.
  if (Buffer.byteLength(text, 'utf8') > 75_000) {
    notify('Text exceeds the terminal clipboard request limit. Use /copy last for one response, or select sections with the mouse.');
    return true;
  }
  tui.terminal.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
  notify('Clipboard request sent to your terminal. If paste is empty, enable OSC 52 clipboard access or select and copy with the mouse.');
  return true;
}
