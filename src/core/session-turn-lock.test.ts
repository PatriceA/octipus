import { expect, test } from 'vitest';
import { cancelQueuedTurns, isSessionTurnCancelled, isSessionTurnRunning, queuedTurnCount, SessionTurnCancelledError, withSessionTurn } from './session-turn-lock';

function gate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { open, wait };
}

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

test('waiters run in arrival order, and a front waiter goes ahead of the queued ones', async () => {
  const order: string[] = [];
  const running = gate();
  const first = withSessionTurn('f1', async () => { order.push('running'); await running.wait; });
  const a = withSessionTurn('f1', async () => { order.push('a'); });
  const b = withSessionTurn('f1', async () => { order.push('b'); });
  const restart = withSessionTurn('f1', async () => { order.push('restart'); }, { front: true });
  await Promise.resolve();
  expect(isSessionTurnRunning('f1')).toBe(true);
  expect(queuedTurnCount('f1')).toBe(3);
  running.open();
  await Promise.all([first, a, b, restart]);
  expect(order).toEqual(['running', 'restart', 'a', 'b']);
  expect(isSessionTurnRunning('f1')).toBe(false);
  expect(queuedTurnCount('f1')).toBe(0);
});

test('cancelQueuedTurns drops the waiters with a typed error and leaves the running turn alone', async () => {
  const order: string[] = [];
  const running = gate();
  const first = withSessionTurn('c1', async () => { order.push('running'); await running.wait; return 'done'; });
  const queued = [1, 2].map(n => withSessionTurn('c1', async () => { order.push(`queued-${n}`); }));
  const settled = Promise.allSettled(queued);
  await Promise.resolve();
  expect(cancelQueuedTurns('c1')).toBe(2);
  const results = await settled;
  for (const result of results) {
    expect(result.status).toBe('rejected');
    const reason = (result as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(SessionTurnCancelledError);
    expect(isSessionTurnCancelled(reason)).toBe(true);
    expect(reason.sessionId).toBe('c1');
  }
  expect(isSessionTurnRunning('c1')).toBe(true);
  expect(cancelQueuedTurns('c1')).toBe(0);
  running.open();
  expect(await first).toBe('done');
  expect(order).toEqual(['running']);
  // The lane is free again: the next turn starts at once.
  await withSessionTurn('c1', async () => { order.push('next'); });
  expect(order).toEqual(['running', 'next']);
});

test('a turn queued after a cancel waits for the running turn, not for the dropped ones', async () => {
  const order: string[] = [];
  const running = gate();
  const first = withSessionTurn('c2', async () => { order.push('running'); await running.wait; });
  const dropped = withSessionTurn('c2', async () => { order.push('dropped'); }).catch(err => { order.push(isSessionTurnCancelled(err) ? 'cancelled' : 'other'); });
  await Promise.resolve();
  cancelQueuedTurns('c2');
  const later = withSessionTurn('c2', async () => { order.push('later'); });
  await dropped;
  expect(order).toEqual(['running', 'cancelled']);
  running.open();
  await Promise.all([first, later]);
  expect(order).toEqual(['running', 'cancelled', 'later']);
});

test('isSessionTurnCancelled only matches the lock error', () => {
  expect(isSessionTurnCancelled(new Error('Dropped by /stop before it ran'))).toBe(false);
  expect(isSessionTurnCancelled({ code: 'SESSION_TURN_CANCELLED' })).toBe(true);
  expect(isSessionTurnCancelled(null)).toBe(false);
});
