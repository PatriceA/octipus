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
  type WakeupTransport,
} from './wakeup-bridge';
import { dispatchWakeups, onTaskWakeup, type TaskWakeupEvent } from './wakeups';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = uuid(1);

const event = (n: number, over: Partial<TaskWakeupEvent> = {}): TaskWakeupEvent => ({
  type: 'task.unblocked', userId: USER, workspaceId: uuid(2), taskId: uuid(100 + n), title: `Task ${n}`,
  triggeredBy: uuid(3), cause: 'closed', ...over,
});

const row = (id: string, status: string, extra: Partial<Task> = {}): Task =>
  ({ id, userId: USER, workspaceId: null, title: `T ${id.slice(-3)}`, status, blockedBy: [], parentId: null, updatedAt: new Date(1), ...extra }) as unknown as Task;

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
});

describe('encode / decode', () => {
  test('round-trips ids only, never titles', () => {
    const [payload] = encodeWakeups('proc-a', [event(1), event(2, { type: 'task.children_completed', workspaceId: null, cause: 'deleted' })]);
    expect(payload).not.toContain('Task 1');
    const decoded = decodeWakeups(payload);
    expect(decoded?.origin).toBe('proc-a');
    expect(decoded?.events).toEqual([
      { type: 'task.unblocked', userId: USER, workspaceId: uuid(2), taskId: uuid(101), triggeredBy: uuid(3), cause: 'closed' },
      { type: 'task.children_completed', userId: USER, workspaceId: null, taskId: uuid(102), triggeredBy: uuid(3), cause: 'deleted' },
    ]);
  });

  test('many events are split into payloads under the byte cap, in order, none lost', () => {
    const events = Array.from({ length: 200 }, (_, i) => event(i));
    const payloads = encodeWakeups('proc-a', events);
    expect(payloads.length).toBeGreaterThan(1);
    for (const p of payloads) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(MAX_PAYLOAD_BYTES).toBeLessThan(8000);
    const taskIds = payloads.flatMap((p) => decodeWakeups(p)!.events.map((e) => e.taskId));
    expect(taskIds).toEqual(events.map((e) => e.taskId));
  });

  test('malformed payloads and bad events are dropped', () => {
    expect(decodeWakeups('not json')).toBeNull();
    expect(decodeWakeups(JSON.stringify({ v: 2, o: 'x', e: [] }))).toBeNull();
    expect(decodeWakeups(JSON.stringify({ v: 1, e: [] }))).toBeNull();
    const mixed = JSON.stringify({ v: 1, o: 'x', e: [
      { k: 'z', u: USER, w: null, t: uuid(1), b: uuid(2), c: 'closed' },
      { k: 'u', u: USER, w: null, t: uuid(1), b: uuid(2), c: 'exploded' },
      { k: 'u', u: 5, w: null, t: uuid(1), b: uuid(2), c: 'closed' },
      { k: 'u', u: USER, w: null, t: uuid(1), b: uuid(2), c: 'closed' },
    ] });
    expect(decodeWakeups(mixed)?.events.map((e) => e.taskId)).toEqual([uuid(1)]);
  });
});

describe('receiveWakeups', () => {
  test('skips its own origin; re-emits another process\'s events as remote, with re-read titles', async () => {
    const { got, off } = collect();
    try {
      const resolveTitles = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, `fresh ${id.slice(-3)}`])));
      const [payload] = encodeWakeups('proc-b', [event(1), event(2)]);
      expect(await receiveWakeups(payload, 'proc-b', resolveTitles)).toEqual([]);
      expect(resolveTitles).not.toHaveBeenCalled();
      expect(got).toEqual([]);

      const emitted = await receiveWakeups(payload, 'proc-a', resolveTitles);
      expect(resolveTitles).toHaveBeenCalledWith([uuid(101), uuid(102)]);
      expect(emitted).toHaveLength(2);
      expect(got).toEqual([
        { ...event(1), title: 'fresh 101', remote: true },
        { ...event(2), title: 'fresh 102', remote: true },
      ]);
    } finally {
      off();
    }
  });

  test('a failed title lookup still emits, with empty titles', async () => {
    const { got, off } = collect();
    try {
      const [payload] = encodeWakeups('proc-b', [event(1)]);
      await receiveWakeups(payload, 'proc-a', async () => { throw new Error('db down'); });
      expect(got).toEqual([{ ...event(1), title: '', remote: true }]);
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
      expect(bus.sent).toEqual([]);
      expect(got.map((e) => [e.taskId, e.remote])).toEqual([[uuid(11), undefined]]);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  test('a local close is emitted once here, published once, and the echo is skipped', async () => {
    const bus = fakeTransport();
    const resolveTitles = vi.fn(async () => new Map<string, string>());
    expect(await startTaskWakeupBridge({ transport: bus.transport, origin: 'proc-a', resolveTitles })).toBe(true);
    const { got, off } = collect();
    try {
      await close();
      await new Promise((r) => setTimeout(r, 0));
      expect(bus.sent).toHaveLength(1);
      expect(decodeWakeups(bus.sent[0])).toMatchObject({ origin: 'proc-a', events: [{ taskId: uuid(11) }] });
      expect(got).toHaveLength(1);
      expect(got[0].remote).toBeUndefined();
      expect(resolveTitles).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledTimes(1);

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
    await startTaskWakeupBridge({ transport: bus.transport, origin: 'proc-a', resolveTitles: async () => new Map() });
    const { got, off } = collect();
    try {
      await expect(close()).resolves.toHaveLength(1);
      expect(got).toHaveLength(1);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  test('start is idempotent; stop unlistens and stops publishing', async () => {
    const bus = fakeTransport();
    const opts = { transport: bus.transport, origin: 'proc-a', resolveTitles: async () => new Map<string, string>() };
    await startTaskWakeupBridge(opts);
    await startTaskWakeupBridge(opts);
    expect(bus.listenerCount()).toBe(1);
    await stopTaskWakeupBridge();
    expect(bus.unlistened).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount()).toBe(0);
    await close();
    expect(bus.sent).toEqual([]);
  });
});
