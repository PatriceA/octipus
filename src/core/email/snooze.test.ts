/** Snooze: archive now, wake later unread, and retry a failed wake with a growing wait. */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { EmailSnooze } from '@/db/schema/email-snoozes';

interface Call { api: string; method: string; path: string; body?: unknown }
const calls: Call[] = [];
let failGraph = false;
vi.mock('./providers', () => ({
  gmailApi: async (_u: string, method: string, path: string, body?: unknown) => { calls.push({ api: 'gmail', method, path, body }); return {}; },
  graphApi: async (_u: string, method: string, path: string, body?: unknown) => {
    calls.push({ api: 'graph', method, path, body });
    if (failGraph) throw new Error('Mail provider returned an error (HTTP 503).');
    // Outlook gives a moved message a new id.
    return method === 'POST' && path.endsWith('/move') ? { id: `${decodeURIComponent(path.split('/')[3])}-moved` } : {};
  },
}));
vi.mock('./mailbox', () => ({ invalidateEmailCache: vi.fn() }));
vi.mock('@/db/postgres', () => ({ getDb: () => { throw new Error('no database in this test'); } }));

/** An in-memory store. */
function memoryStore() {
  const rows: EmailSnooze[] = [];
  let seq = 0;
  return {
    rows,
    async insert(row: Omit<EmailSnooze, 'id' | 'createdAt' | 'attempts' | 'nextAttemptAt' | 'lastError'>) {
      const saved: EmailSnooze = { ...row, id: `s${++seq}`, createdAt: new Date(), attempts: 0, nextAttemptAt: null, lastError: null };
      rows.push(saved);
      return saved;
    },
    list: async (userId: string) => rows.filter((r) => r.userId === userId),
    get: async (userId: string, id: string) => rows.find((r) => r.userId === userId && r.id === id) ?? null,
    due: async (now: Date, limit: number) => rows.filter((r) => r.wakeAt <= now && (!r.nextAttemptAt || r.nextAttemptAt <= now)).slice(0, limit),
    async remove(id: string) { rows.splice(rows.findIndex((r) => r.id === id), 1); },
    async failed(id: string, attempts: number, nextAttemptAt: Date, error: string) { Object.assign(rows.find((r) => r.id === id)!, { attempts, nextAttemptAt, lastError: error }); },
  };
}

const now = Date.parse('2026-11-21T12:00:00Z');
const request = (ids: string[], wakeAt = '2026-11-22T08:00:00Z') => ({ ids, wakeAt, threadId: 't1', from: { name: 'Boss', email: 'boss@x.com' }, subject: 'Budget', snippet: 'Please confirm' });

beforeEach(() => { calls.length = 0; failGraph = false; });

describe('snooze', () => {
  test('Gmail: the INBOX label comes off now and the row keeps what the list shows', async () => {
    const { snooze } = await import('./snooze');
    const store = memoryStore();
    const view = await snooze('u1', 'google', request(['a', 'b', 'a']), store, now);
    expect(calls).toEqual([{ api: 'gmail', method: 'POST', path: '/messages/batchModify', body: { ids: ['a', 'b'], removeLabelIds: ['INBOX'] } }]);
    expect(view).toMatchObject({ provider: 'google', messageIds: ['a', 'b'], from: { name: 'Boss', email: 'boss@x.com' }, subject: 'Budget', wakeAt: '2026-11-22T08:00:00.000Z' });
  });

  test('Outlook: the row keeps the ids the messages have after the move', async () => {
    const { snooze } = await import('./snooze');
    const store = memoryStore();
    await snooze('u1', 'microsoft', request(['m/1']), store, now);
    expect(calls[0]).toEqual({ api: 'graph', method: 'POST', path: '/me/messages/m%2F1/move', body: { destinationId: 'archive' } });
    expect(store.rows[0].messageIds).toEqual(['m/1-moved']);
  });

  test('a time in the past, too soon, too far, or not a time is refused before the mailbox is touched', async () => {
    const { snooze, SnoozeInputError } = await import('./snooze');
    for (const wakeAt of ['2026-11-21T11:00:00Z', '2026-11-21T12:00:30Z', '2028-01-01T00:00:00Z', 'tomorrow']) {
      await expect(snooze('u1', 'google', request(['a'], wakeAt), memoryStore(), now)).rejects.toBeInstanceOf(SnoozeInputError);
    }
    expect(calls).toEqual([]);
  });
});

describe('waking', () => {
  test('due mail goes back to the inbox unread and the row goes; mail not due stays', async () => {
    const { snooze, wakeDueSnoozes } = await import('./snooze');
    const store = memoryStore();
    await snooze('u1', 'google', request(['a']), store, now);
    await snooze('u1', 'microsoft', request(['m1'], '2026-11-23T08:00:00Z'), store, now);
    calls.length = 0;
    expect(await wakeDueSnoozes(new Date('2026-11-22T08:00:01Z'), store)).toBe(1);
    expect(calls).toEqual([{ api: 'gmail', method: 'POST', path: '/messages/batchModify', body: { ids: ['a'], addLabelIds: ['INBOX', 'UNREAD'] } }]);
    expect(store.rows.map((r) => r.provider)).toEqual(['microsoft']);
    calls.length = 0;
    expect(await wakeDueSnoozes(new Date('2026-11-23T08:00:01Z'), store)).toBe(1);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /me/messages/m1-moved/move', 'PATCH /me/messages/m1-moved-moved']);
    expect(calls[1].body).toEqual({ isRead: false });
  });

  test('a failed wake is kept, says why, and waits longer each time', async () => {
    const { snooze, wakeDueSnoozes, wakeBackoffMs, listSnoozed } = await import('./snooze');
    const store = memoryStore();
    await snooze('u1', 'microsoft', request(['m1']), store, now);
    failGraph = true;
    const t1 = new Date('2026-11-22T09:00:00Z');
    expect(await wakeDueSnoozes(t1, store)).toBe(0);
    expect(store.rows[0]).toMatchObject({ attempts: 1, lastError: 'Mail provider returned an error (HTTP 503).' });
    expect(+store.rows[0].nextAttemptAt! - +t1).toBe(wakeBackoffMs(1));
    // Not tried again before its time.
    calls.length = 0;
    expect(await wakeDueSnoozes(new Date(+t1 + 1000), store)).toBe(0);
    expect(calls).toEqual([]);
    const [view] = await listSnoozed('u1', undefined, store);
    expect(view.error).toBe('Mail provider returned an error (HTTP 503).');
    expect(view.retryAt).toBe(new Date(+t1 + wakeBackoffMs(1)).toISOString());
    failGraph = false;
    expect(await wakeDueSnoozes(new Date(+t1 + wakeBackoffMs(1)), store)).toBe(1);
    expect(store.rows).toEqual([]);
  });

  test('backoff: 1, 2, 4 … minutes, never more than six hours', async () => {
    const { wakeBackoffMs } = await import('./snooze');
    expect([1, 2, 3].map(wakeBackoffMs)).toEqual([60_000, 120_000, 240_000]);
    expect(wakeBackoffMs(30)).toBe(6 * 60 * 60_000);
  });

  test('unsnooze brings it back now without marking it unread, only for its owner', async () => {
    const { snooze, unsnooze } = await import('./snooze');
    const store = memoryStore();
    const view = await snooze('u1', 'google', request(['a']), store, now);
    calls.length = 0;
    expect(await unsnooze('u2', view.id, store)).toBe(false);
    expect(calls).toEqual([]);
    expect(await unsnooze('u1', view.id, store)).toBe(true);
    expect(calls[0].body).toEqual({ ids: ['a'], addLabelIds: ['INBOX'] });
    expect(store.rows).toEqual([]);
  });
});
