import { expect, test } from 'vitest';
import { withSessionTurn } from './session-turn-lock';

test('same-session turns serialize, other sessions proceed, and failure releases the queue', async () => {
  const order: string[] = [];
  let release!: () => void;
  const first = withSessionTurn('s1', async () => { order.push('first'); await new Promise<void>(resolve => { release = resolve; }); throw new Error('failed'); });
  const caught = first.catch(() => { order.push('failed'); });
  const second = withSessionTurn('s1', async () => { order.push('second'); });
  await withSessionTurn('s2', async () => { order.push('other'); });
  expect(order).toEqual(['first', 'other']);
  release(); await Promise.all([caught, second]);
  expect(order).toContain('second');
  await withSessionTurn('s1', async () => { order.push('third'); });
  expect(order.at(-1)).toBe('third');
});
