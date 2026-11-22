import { expect, test } from 'vitest';
import { CURSOR_MARKER, visibleWidth } from '@/tui-kit';
import { ChatFooter, renderChatFooter, renderChatFrame } from './chat-frame';
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

test('the footer is sticky rows, activity and composer above the status line, and never taller than the screen', () => {
  const composer = fixed([`${CURSOR_MARKER}typing`]);
  const parts = { composer, activity: fixed(['working']), status: fixed(['status line']), sticky: fixed(['queued 1', 'queued 2']) };
  expect(renderChatFooter(40, 24, parts)).toEqual(['queued 1', 'queued 2', 'working', `${CURSOR_MARKER}typing`, 'status line']);
  // Short of rows: the sticky rows go first, the newest kept; the status line and the composer stay.
  expect(renderChatFooter(40, 4, parts, 1)).toEqual(['working', `${CURSOR_MARKER}typing`, 'status line']);
  expect(renderChatFooter(40, 2, parts)).toEqual([`${CURSOR_MARKER}typing`, 'status line']);
  for (const height of [1, 2, 3, 5, 12]) expect(new ChatFooter(parts, () => height).render(40).length).toBeLessThanOrEqual(height);
});
