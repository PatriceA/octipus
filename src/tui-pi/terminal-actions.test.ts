import { expect, test, vi } from 'vitest';
import type { TUI } from '@mariozechner/pi-tui';
import { handleTerminalCommand, setMouseCapture } from './terminal-actions';
import { MessagesPane } from './components/messages-pane';
import { StatusBar } from './components/status-bar';

function fixture() {
  const write = vi.fn(); const terminal = { write }; const tui = { terminal } as unknown as TUI;
  const messages = new MessagesPane({ maxVisible: 3 }); const status = new StatusBar(); const notify = vi.fn();
  return { write, terminal, messages, status, notify, run: (command: string) => handleTerminalCommand(command, tui, messages, notify) };
}

test('wheel tracking is enabled and disabled only by terminal lifecycle', () => {
  const f = fixture();
  setMouseCapture(f.terminal, true);
  expect(f.write).toHaveBeenLastCalledWith('\x1b[?1000h\x1b[?1006h');
  setMouseCapture(f.terminal, false);
  expect(f.write).toHaveBeenLastCalledWith('\x1b[?1000l\x1b[?1006l');
  expect(f.run('/mouse')).toBe(false);
  expect(f.status.render(100).join('')).not.toContain('wheel captured');
});

test('copy last preserves complete Unicode and Markdown, independent of viewport', () => {
  const f = fixture();
  const text = '**Hello 世界**\n' + 'long response '.repeat(100);
  f.messages.push({ role: 'assistant', content: text, timestamp: new Date() });
  f.messages.push({ role: 'system', content: 'tool finished', timestamp: new Date() });
  f.messages.render(30); f.messages.scrollUp();
  expect(f.run('/copy last')).toBe(true);
  expect(f.write).toHaveBeenLastCalledWith(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
  expect(f.notify).toHaveBeenCalledWith(expect.stringContaining('request sent'));
});

test('copy transcript includes loaded roles and current streamed text without reporting its own command', () => {
  const f = fixture();
  f.messages.push({ role: 'user', content: 'question', timestamp: new Date() });
  f.messages.push({ role: 'assistant', content: 'earlier response', timestamp: new Date() });
  f.messages.setLive('stream so far');
  f.run('/copy transcript');
  const text = Buffer.from(f.write.mock.calls[0][0].slice(7, -1), 'base64').toString();
  expect(text).toBe('user:\nquestion\n\nassistant:\nearlier response\n\nassistant:\nstream so far');
  f.run('/copy');
  expect(f.write).toHaveBeenLastCalledWith(`\x1b]52;c;${Buffer.from('stream so far').toString('base64')}\x07`);
});

test('empty, invalid, and oversized copies do not overwrite the clipboard or silently truncate', () => {
  const f = fixture(); f.run('/copy'); f.run('/copy nonsense');
  f.messages.setLive('🐙'.repeat(20_000)); f.run('/copy');
  expect(f.write).not.toHaveBeenCalled();
  expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining('exceeds'));
  expect(f.run('/unknown')).toBe(false);
});
