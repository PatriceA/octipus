import { afterEach, describe, expect, test, vi } from 'vitest';

const notify = vi.fn(async () => {});
vi.mock('@/core/notification-service', () => ({ getNotificationService: () => ({ notify }) }));

import type { Task } from '@/db/schema/tasks';
import {
  decodeWakeups,
  encodeWakeups,
  MAX_PAYLOAD_BYTES,
  receiveWakeups,
  startTaskWakeupBridge,
  stopTaskWakeupBridge,
  TASK_WAKEUP_CHANNEL,
  type TaskRef,
  titleKey,
  type WakeupTransport,
} from './wakeup-bridge';
import { dispatchWakeups, flushWakeups, onTaskWakeup, type TaskWakeupEvent } from './wakeups';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = uuid(1);
const OTHER_USER = uuid(9);

const event = (n: number, over: Partial<TaskWakeupEvent> = {}): TaskWakeupEvent => ({
  type: 'task.unblocked', userId: USER, workspaceId: uuid(2), taskId: uuid(100 + n), title: `Task ${n}`,
  triggeredBy: uuid(3), cause: 'closed', ...over,
});

const row = (id: string, status: string, extra: Partial<Task> = {}): Task =>
  ({ id, userId: USER, workspaceId: null, title: `T ${id.slice(-3)}`, status, blockedBy: [], parentId: null, updatedAt: new Date(1), ...extra }) as unknown as Task;

/** Titles for tasks owned by USER only, like the per-owner query. */
const ownedByUser = vi.fn(async (refs: TaskRef[]) =>
  new Map(refs.filter((r) => r.userId === USER).map((r) => [titleKey(r), `fresh ${r.taskId.slice(-3)}`])));

/** A NOTIFY bus in memory: like Postgres, it delivers to every listener, the sender's own too. */
function fakeTransport() {
  const listeners = new Set<(payload: string) => void>();
  const sent: string[] = [];
  const unlistened = vi.fn();
  const transport: WakeupTransport = {
    notify: async (channel, payload) => {
      expect(channel).toBe(TASK_WAKEUP_CHANNEL);
      sent.push(payload);
      for (const l of listeners) l(payload);
    },
    listen: async (channel, onPayload) => {
      expect(channel).toBe(TASK_WAKEUP_CHANNEL);
      listeners.add(onPayload);
      return async () => {
        listeners.delete(onPayload);
        unlistened();
      };
    },
  };
  const deliver = (payload: string) => { for (const l of listeners) l(payload); };
  return { transport, sent, deliver, unlistened, listenerCount: () => listeners.size };
}

const collect = () => {
  const got: TaskWakeupEvent[] = [];
  const off = onTaskWakeup((e) => { got.push(e); });
  return { got, off };
};

afterEach(async () => {
  await stopTaskWakeupBridge();
  notify.mockClear();
  ownedByUser.mockClear();
  vi.useRealTimers();
});

describe('encode / decode', () => {
  test('round-trips ids only, never titles', () => {
    const [payload] = encodeWakeups('proc-a', [event(1), event(2, { type: 'task.children_completed', workspaceId: null, cause: 'deleted' })]);
    expect(payload).not.toContain('Task 1');
    expect(JSON.parse(payload)).toMatchObject({ v: 1, o: 'proc-a' });
    const decoded = decodeWakeups(payload);
    expect(decoded?.origin).toBe('proc-a');
    expect(decoded?.events).toEqual([
      { type: 'task.unblocked', userId: USER, workspaceId: uuid(2), taskId: uuid(101), triggeredBy: uuid(3), cause: 'closed' },
      { type: 'task.children_completed', userId: USER, workspaceId: null, taskId: uuid(102), triggeredBy: uuid(3), cause: 'deleted' },
    ]);
  });

  test('many events are split into payloads under the byte cap, packed full, in order, none lost', () => {
    const events = Array.from({ length: 500 }, (_, i) => event(i));
    const payloads = encodeWakeups('proc-a', events);
    expect(payloads.length).toBeGreaterThan(1);
    expect(MAX_PAYLOAD_BYTES).toBeLessThan(8000);
    const oneEvent = Buffer.byteLength(encodeWakeups('proc-a', [event(0)])[0]);
    for (const [i, p] of payloads.entries()) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      JSON.parse(p);
      // Every payload but the last is full: one more event would not have fit.
      if (i < payloads.length - 1) expect(Buffer.byteLength(p) + oneEvent).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    }
    const taskIds = payloads.flatMap((p) => decodeWakeups(p)!.events.map((e) => e.taskId));
    expect(taskIds).toEqual(events.map((e) => e.taskId));
  });

  test('a tight cap still yields valid payloads within it', () => {
    const one = Buffer.byteLength(encodeWakeups('o', [event(0)])[0]);
    const payloads = encodeWakeups('o', [event(1), event(2), event(3)], one + 5);
    expect(payloads).toHaveLength(3);
    for (const p of payloads) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(one + 5);
    expect(encodeWakeups('o', [event(1)], 10)).toEqual([]);
  });

  test('malformed payloads and bad events (kind, cause, non-uuid ids) are dropped', () => {
    expect(decodeWakeups('not json')).toBeNull();
    expect(decodeWakeups(JSON.stringify({ v: 2, o: 'x', e: [] }))).toBeNull();
    expect(decodeWakeups(JSON.stringify({ v: 1, e: [] }))).toBeNull();
    const ok = { k: 'u', u: USER, w: null, t: uuid(1), b: uuid(2), c: 'closed' };
    const mixed = JSON.stringify({ v: 1, o: 'x', e: [
      { ...ok, k: 'z' },
      { ...ok, c: 'exploded' },
      { ...ok, u: 5 },
      { ...ok, u: 'not-a-uuid' },
      { ...ok, t: "1' OR 1=1" },
      { ...ok, b: '' },
      { ...ok, w: 'nope' },
      ok,
      { ...ok, t: uuid(4), w: uuid(5) },
    ] });
    expect(decodeWakeups(mixed)?.events.map((e) => e.taskId)).toEqual([uuid(1), uuid(4)]);
  });
});

describe('receiveWakeups', () => {
  test('skips its own origin; re-emits another process\'s events as remote, with titles re-read under their owner', async () => {
    const { got, off } = collect();
    try {
      const [payload] = encodeWakeups('proc-b', [event(1), event(2)]);
      expect(await receiveWakeups(payload, 'proc-b', ownedByUser)).toEqual([]);
      expect(ownedByUser).not.toHaveBeenCalled();
      expect(got).toEqual([]);

      const emitted = await receiveWakeups(payload, 'proc-a', ownedByUser);
      expect(ownedByUser).toHaveBeenCalledWith([{ taskId: uuid(101), userId: USER }, { taskId: uuid(102), userId: USER }]);
      expect(emitted).toHaveLength(2);
      expect(got).toEqual([
        { ...event(1), title: 'fresh 101', remote: true },
        { ...event(2), title: 'fresh 102', remote: true },
      ]);
    } finally {
      off();
    }
  });

  test('an event naming a task that is not its owner\'s (or is gone) is dropped', async () => {
    const { got, off } = collect();
    try {
      const [payload] = encodeWakeups('proc-b', [event(1, { userId: OTHER_USER }), event(2)]);
      await receiveWakeups(payload, 'proc-a', ownedByUser);
      expect(got.map((e) => e.taskId)).toEqual([uuid(102)]);
    } finally {
      off();
    }
  });

  test('a failed title lookup emits nothing (ownership unchecked)', async () => {
    const { got, off } = collect();
    try {
      const [payload] = encodeWakeups('proc-b', [event(1)]);
      expect(await receiveWakeups(payload, 'proc-a', async () => { throw new Error('db down'); })).toEqual([]);
      expect(got).toEqual([]);
    } finally {
      off();
    }
  });
});

describe('the bridge around dispatchWakeups', () => {
  const blocker = row(uuid(10), 'done');
  const dependent = row(uuid(11), 'open', { blockedBy: [uuid(10)] });
  const close = () => dispatchWakeups({ closed: blocker, previousStatus: 'open', cause: 'closed', rows: [blocker, dependent], unknownIds: [] });

  test('without the bridge nothing is published (PGlite: behaviour as before)', async () => {
    const { got, off } = collect();
    try {
      const bus = fakeTransport();
      await close();
      await flushWakeups();
      expect(bus.sent).toEqual([]);
      expect(got.map((e) => [e.taskId, e.remote])).toEqual([[uuid(11), undefined]]);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  test('a local close is emitted once here and notified, then published detached; the echo is skipped', async () => {
    const bus = fakeTransport();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowNotify = bus.transport.notify;
    bus.transport.notify = async (c, p) => { await gate; return slowNotify(c, p); };
    expect(await startTaskWakeupBridge({ transport: bus.transport, origin: 'proc-a', resolveTitles: ownedByUser })).toBe(true);
    const { got, off } = collect();
    try {
      // dispatch returns without waiting for the NOTIFY.
      await close();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(bus.sent).toEqual([]);
      release();
      await flushWakeups();
      expect(bus.sent).toHaveLength(1);
      expect(decodeWakeups(bus.sent[0])).toMatchObject({ origin: 'proc-a', events: [{ taskId: uuid(11) }] });
      expect(got).toHaveLength(1);
      expect(got[0].remote).toBeUndefined();
      expect(ownedByUser).not.toHaveBeenCalled();

      // Another process's close arrives: emitted here as remote, no notification filed here.
      bus.deliver(encodeWakeups('proc-b', [event(7)])[0]);
      await vi.waitFor(() => expect(got).toHaveLength(2));
      expect(got[1]).toMatchObject({ taskId: uuid(107), remote: true });
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  test('a failing NOTIFY never fails the local dispatch', async () => {
    const bus = fakeTransport();
    bus.transport.notify = async () => { throw new Error('connection lost'); };
    await startTaskWakeupBridge({ transport: bus.transport, origin: 'proc-a', resolveTitles: ownedByUser });
    const { got, off } = collect();
    try {
      await expect(close()).resolves.toHaveLength(1);
      await flushWakeups();
      expect(got).toHaveLength(1);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  test('LISTEN failing at start is retried with backoff; publishing works meanwhile', async () => {
    vi.useFakeTimers();
    const bus = fakeTransport();
    const listen = bus.transport.listen;
    let failures = 2;
    const attempts: number[] = [];
    bus.transport.listen = async (c, h) => {
      attempts.push(Date.now());
      if (failures-- > 0) throw new Error('connection refused');
      return listen(c, h);
    };
    expect(await startTaskWakeupBridge({ transport: bus.transport, origin: 'proc-a', resolveTitles: ownedByUser, retryInitialMs: 5_000, retryMaxMs: 8_000 })).toBe(true);
    expect(attempts).toHaveLength(1);
    expect(bus.listenerCount()).toBe(0);

    // Publishing does not wait for LISTEN.
    await close();
    await flushWakeups();
    expect(bus.sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(attempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); // 5 s, then min(10 s, 8 s)
    expect(attempts).toHaveLength(3);
    expect(bus.listenerCount()).toBe(1);
  });

  test('stop cancels a pending LISTEN retry', async () => {
    vi.useFakeTimers();
    const bus = fakeTransport();
    let calls = 0;
    bus.transport.listen = async () => { calls++; throw new Error('down'); };
    await startTaskWakeupBridge({ transport: bus.transport, origin: 'proc-a', resolveTitles: ownedByUser, retryInitialMs: 1_000 });
    await stopTaskWakeupBridge();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
  });

  test('start is idempotent; stop unlistens and stops publishing', async () => {
    const bus = fakeTransport();
    const opts = { transport: bus.transport, origin: 'proc-a', resolveTitles: ownedByUser };
    await startTaskWakeupBridge(opts);
    await startTaskWakeupBridge(opts);
    expect(bus.listenerCount()).toBe(1);
    await stopTaskWakeupBridge();
    expect(bus.unlistened).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount()).toBe(0);
    await close();
    await flushWakeups();
    expect(bus.sent).toEqual([]);
  });
});
