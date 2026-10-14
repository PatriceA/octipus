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

test('server acknowledgement and later polls preserve the visible time anchor', () => {
  const first = reconcileChatMessages([msg('server-id', 'hello', 5000)], [msg('1000', 'hello', 1000)]);
  expect(+new Date(first[0].timestamp)).toBe(1000);
  const later = reconcileChatMessages([msg('server-id', 'hello', 5000)], first);
  expect(+new Date(later[0].timestamp)).toBe(1000);
});

test('a row that came over the gateway (another tab\'s steer, a reply) is replaced by its persisted copy', () => {
  const steered = msg('gw-evt-1', 'go left instead', 1000);
  expect(reconcileChatMessages([msg('stored-steer', 'go left instead', 1500)], [steered]).map(m => m.id)).toEqual(['stored-steer']);
  expect(reconcileChatMessages([msg('stored-before', 'hi', 500), msg('stored-steer', 'go left instead', 1500)], [msg('stored-before', 'hi', 500), steered])
    .map(m => m.id)).toEqual(['stored-before', 'stored-steer']);
});

test('an unchanged refetch hands back the rows, and the array, already shown', () => {
  const shown = reconcileChatMessages([msg('a', 'one', 1000), msg('b', 'two', 2000)], []);
  const again = reconcileChatMessages([msg('a', 'one', 1000), msg('b', 'two', 2000)], shown);
  expect(again).toBe(shown);
});

test('only the row that changed is a new object', () => {
  const shown = reconcileChatMessages([msg('a', 'one', 1000), msg('b', 'two', 2000)], []);
  const next = reconcileChatMessages([msg('a', 'one', 1000), msg('b', 'two, edited', 2000), msg('c', 'three', 3000)], shown);
  expect(next).not.toBe(shown);
  expect(next[0]).toBe(shown[0]);
  expect(next[1]).not.toBe(shown[1]);
  expect(next.map(m => m.content)).toEqual(['one', 'two, edited', 'three']);
});

test('a change in metadata alone is a new row; equal metadata keeps the shown one', () => {
  const limit = (used: number) => ({ ...msg('a', 'refused', 1000), metadata: { limit: { scope: 'user', used, cap: 10 } } });
  const shown = reconcileChatMessages([limit(10)], []);
  expect(reconcileChatMessages([limit(10)], shown)).toBe(shown);
  const next = reconcileChatMessages([limit(12)], shown);
  expect(next[0]).not.toBe(shown[0]);
  expect(next[0].metadata.limit.used).toBe(12);
});

test('a field the shown row lacks makes the refetched row new, an undefined one does not', () => {
  type Row = ReturnType<typeof msg> & { classification?: string };
  const shown = reconcileChatMessages<Row>([msg('a', 'one', 1000)], []);
  expect(reconcileChatMessages<Row>([{ ...msg('a', 'one', 1000), classification: undefined }], shown)).toBe(shown);
  expect(reconcileChatMessages<Row>([{ ...msg('a', 'one', 1000), classification: 'coding' }], shown)[0]).not.toBe(shown[0]);
});
