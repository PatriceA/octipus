import { expect, test, vi } from 'vitest';
import { mapLimit, serialPerKey } from './concurrency';

test('mapLimit keeps order and never runs more than the limit at once', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, n));
    running--;
    return n * 10;
  });
  expect(out).toEqual([50, 10, 40, 20, 30]);
  expect(peak).toBe(2);
});

test('serialPerKey runs one key in queue order, survives a failure, and keys stay independent', async () => {
  const onError = vi.fn();
  const q = serialPerKey(onError);
  const seen: string[] = [];
  const step = (s: string, ms: number) => () => new Promise<void>((r) => setTimeout(() => { seen.push(s); r(); }, ms));
  void q.run('a', step('a1', 20));
  void q.run('a', async () => { throw new Error('boom'); });
  void q.run('a', step('a2', 1));
  void q.run('b', step('b1', 5));
  await Promise.all([q.idle('a'), q.idle('b')]);
  expect(seen.filter((s) => s.startsWith('a'))).toEqual(['a1', 'a2']);
  expect(seen.indexOf('b1')).toBeLessThan(seen.indexOf('a1'));
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }), 'a');
});
