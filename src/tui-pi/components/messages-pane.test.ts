import { expect, test, vi } from 'vitest';
import { Markdown, visibleWidth } from '@mariozechner/pi-tui';
import { MessagesPane } from './messages-pane';
const strip = (lines: string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
const push = (pane: MessagesPane, content: string, role: 'user' | 'assistant' | 'system' = 'system') => pane.push({ role, content, timestamp: new Date() });

test('roles remain identifiable without colour and user rails survive wrapping', () => {
  const pane = new MessagesPane();
  push(pane, 'a long user message that wraps', 'user');
  push(pane, 'The reply.', 'assistant'); push(pane, 'Tool finished');
  const lines = strip(pane.render(20));
  expect(lines[0]).toBe('You');
  expect(lines.filter(line => line.startsWith('│ '))).toHaveLength(2);
  expect(lines).toContain('Octipus'); expect(lines).toContain('· Tool finished');
});

test('row scrolling can read the beginning of one long answer', () => {
  const pane = new MessagesPane({ maxVisible: 6 });
  push(pane, Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n'), 'assistant');
  expect(strip(pane.render(80)).join('\n')).toContain('row 29');
  expect(pane.scrollUp(100)).toBe(true);
  expect(strip(pane.render(80)).join('\n')).toContain('row 0');
  expect(pane.scrollUp()).toBe(false);
  pane.scrollToBottom(); expect(strip(pane.render(80)).join('\n')).toContain('row 29');
});

test('reading position stays fixed while messages and deltas arrive', () => {
  const pane = new MessagesPane({ maxVisible: 6 });
  for (let n = 0; n < 20; n++) push(pane, `message ${n}`);
  pane.render(80); pane.scrollUp(6);
  const before = strip(pane.render(80)).slice(0, -1);
  push(pane, 'new message'); pane.setLive('new streaming text');
  expect(strip(pane.render(80)).slice(0, -1)).toEqual(before);
  expect(strip(pane.render(80)).at(-1)).toContain('1 new');
  pane.scrollToBottom(); expect(strip(pane.render(80)).join('\n')).toContain('new streaming text');
});

test('all viewport sizes stay within their row and column bounds', () => {
  const pane = new MessagesPane();
  push(pane, 'Hello 世界 🐙\n```ts\nconst answer = 42;\n```', 'assistant');
  for (const width of [1, 4, 20, 80]) for (const height of [0, 1, 4, 20]) {
    pane.setHeight(height); const lines = pane.render(width);
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
  }
});

test('streaming does not reparse historical Markdown', () => {
  const pane = new MessagesPane();
  const render = vi.spyOn(Markdown.prototype, 'render');
  try {
    for (let n = 0; n < 100; n++) push(pane, `**Answer ${n}**`, 'assistant');
    pane.render(80); const count = render.mock.calls.length;
    for (let n = 0; n < 20; n++) { pane.setLive(`stream ${n}`); pane.render(80); }
    expect(render.mock.calls.length).toBe(count);
  } finally { render.mockRestore(); }
});

test('errors have a text marker, and reset removes history and live text', () => {
  const pane = new MessagesPane();
  pane.push({ role: 'system', content: 'Save failed', tone: 'error', timestamp: new Date() });
  expect(strip(pane.render(40)).join('\n')).toContain('! Error · Save failed');
  pane.setLive('partial'); pane.reset(); expect(pane.render(40)).toEqual([]);
});
