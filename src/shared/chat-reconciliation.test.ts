import { expect, test } from 'vitest';
import { reconcileChatMessages } from './chat-reconciliation';
const msg = (id: string, content = 'hello', time = 1000) => ({ id, content, role: 'user', timestamp: new Date(time) });
test('a stale poll cannot erase a live message', () => {
  expect(reconcileChatMessages([msg('stored')], [msg('stored'), msg('2000', 'new', 2000)]).map(m => m.id)).toEqual(['stored', '2000']);
});
test('persistence replaces optimistic messages without duplicating repeated text', () => {
  expect(reconcileChatMessages([msg('stored')], [msg('1000'), msg('2000', 'hello', 2000)]).map(m => m.id)).toEqual(['stored', '2000']);
});
test('older repeated text does not acknowledge a new optimistic message', () => {
  expect(reconcileChatMessages([msg('stored')], [msg('70000', 'hello', 70000)])).toHaveLength(2);
});
test('an empty poll preserves real messages and removes the welcome placeholder', () => {
  expect(reconcileChatMessages([msg('0')], [msg('stored')]).map(m => m.id)).toEqual(['stored']);
});
