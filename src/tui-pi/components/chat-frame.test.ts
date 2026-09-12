import { expect, test } from 'vitest';
import { CURSOR_MARKER, visibleWidth } from '@mariozechner/pi-tui';
import { renderChatFrame } from './chat-frame';
import { MessagesPane } from './messages-pane';
const fixed = (lines: string[]) => ({ render: () => lines, invalidate() {} });
test('composer cursor remains visible with a large paste and expanded plan', () => {
  const messages = new MessagesPane();
  messages.push({ role: 'user', content: 'hello', timestamp: new Date() });
  for (const height of [4, 8, 24]) for (const cursor of [0, 15, 39]) {
    const composer = fixed(Array.from({ length: 40 }, (_, n) => `${n === cursor ? CURSOR_MARKER : ''}row${n}`));
    const lines = renderChatFrame(40, height, { messages, composer, activity: fixed(['working']), status: fixed(Array(8).fill('plan')) });
    expect(lines).toHaveLength(height);
    expect(lines.join('\n')).toContain(CURSOR_MARKER);
    expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true);
  }
});

test('one or two rows keep the status line first, then the composer', () => {
  const messages = new MessagesPane();
  const composer = fixed([`${CURSOR_MARKER}typing`]);
  const status = fixed(['plan', 'status line']);
  expect(renderChatFrame(40, 1, { messages, composer, activity: fixed([]), status })).toEqual(['status line']);
  const two = renderChatFrame(40, 2, { messages, composer, activity: fixed([]), status });
  expect(two).toHaveLength(2);
  expect(two[0]).toContain(CURSOR_MARKER);
  expect(two[1]).toBe('status line');
});
