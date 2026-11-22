/** Snooze: archive now, wake later unread, and retry a failed wake with a growing wait. */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { EmailSnooze } from '@/db/schema/email-snoozes';

interface Call { api: string; method: string; path: string; body?: unknown; account?: string }
const calls: Call[] = [];
let failGraph = false;
/** Per-call failures: a path (or path part) and the HTTP status the provider answers with. */
let failing: Array<{ match: string; status: number; times?: number }> = [];
const failFor = (path: string) => {
  const hit = failing.find((f) => path.includes(f.match) && (f.times ?? 1) > 0);
  if (!hit) return;
  if (hit.times !== undefined) hit.times--;
  throw new Error(`Mail provider returned an error (HTTP ${hit.status}).`);
};
vi.mock('@/security/oauth', () => ({ getOAuthManager: () => ({ listAccounts: async () => [{ provider: 'google', account: 'me@home.example', isDefault: true }, { provider: 'google', account: 'me@work.example', isDefault: false }] }) }));
vi.mock('./providers', () => ({
  gmailApi: async (_u: string, method: string, path: string, body?: unknown) => {
    // Which account the call ran in (the real gmailApi takes its token from the same place).
    const { selectedAccount } = await import('./account-context');
    const account = selectedAccount('google');
    calls.push({ api: 'gmail', method, path, body, ...(account ? { account } : {}) });
    failFor(path);
    return {};
  },
  graphApi: async (_u: string, method: string, path: string, body?: unknown) => {
    calls.push({ api: 'graph', method, path, body });
    if (failGraph) throw new Error('Mail provider returned an error (HTTP 503).');
    failFor(path);
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
    failInsert: false,
    async insert(row: Omit<EmailSnooze, 'id' | 'createdAt' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'givenUpAt'>) {
      if (this.failInsert) throw new Error('database unavailable');
      const saved: EmailSnooze = { ...row, id: `s${++seq}`, createdAt: new Date(), attempts: 0, nextAttemptAt: null, lastError: null, givenUpAt: null };
      rows.push(saved);
      return saved;
    },
    list: async (userId: string) => rows.filter((r) => r.userId === userId),
    get: async (userId: string, id: string) => rows.find((r) => r.userId === userId && r.id === id) ?? null,
    due: async (now: Date, limit: number) => rows.filter((r) => r.wakeAt <= now && !r.givenUpAt && (!r.nextAttemptAt || r.nextAttemptAt <= now)).slice(0, limit),
    async progress(id: string, messageIds: string[]) { rows.find((r) => r.id === id)!.messageIds = messageIds; },
    async gaveUp(id: string, attempts: number, error: string, at: Date) { Object.assign(rows.find((r) => r.id === id)!, { attempts, lastError: error, givenUpAt: at, nextAttemptAt: null }); },
    async remove(id: string) { rows.splice(rows.findIndex((r) => r.id === id), 1); },
    async failed(id: string, attempts: number, nextAttemptAt: Date, error: string) { Object.assign(rows.find((r) => r.id === id)!, { attempts, nextAttemptAt, lastError: error }); },
  };
}

const now = Date.parse('2026-11-21T12:00:00Z');
const request = (ids: string[], wakeAt = '2026-11-22T08:00:00Z') => ({ ids, wakeAt, threadId: 't1', from: { name: 'Boss', email: 'boss@x.com' }, subject: 'Budget', snippet: 'Please confirm' });

beforeEach(() => { calls.length = 0; failGraph = false; failing = []; });

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
    // The wake runs in the account the row names (the default's address here).
    expect(calls).toEqual([{ api: 'gmail', method: 'POST', path: '/messages/batchModify', body: { ids: ['a'], addLabelIds: ['INBOX', 'UNREAD'] }, account: 'me@home.example' }]);
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

describe('snooze in a further account', () => {
  test('the row keeps the account, and the wake moves the mail back in that account, not the default one', async () => {
    const { snooze, wakeDueSnoozes, listSnoozed } = await import('./snooze');
    const { inMailbox } = await import('./account-context');
    const store = memoryStore();
    const work = { provider: 'google' as const, account: 'me@work.example' };
    await inMailbox(work, () => snooze('u1', 'google', request(['w1']), store, now));
    expect(store.rows[0]).toMatchObject({ provider: 'google', account: 'me@work.example' });
    expect(calls.at(-1)).toMatchObject({ path: '/messages/batchModify', account: 'me@work.example' });
    // Each mailbox lists its own snoozes.
    expect(await listSnoozed('u1', 'google', store)).toEqual([]);
    expect((await inMailbox(work, () => listSnoozed('u1', 'google', store))).map((v) => v.account)).toEqual(['me@work.example']);
    calls.length = 0;
    // The sweep runs outside any request: the row alone says which account.
    expect(await inMailbox(null, () => wakeDueSnoozes(new Date('2026-11-22T09:00:00Z'), store))).toBe(1);
    expect(calls).toEqual([expect.objectContaining({ path: '/messages/batchModify', account: 'me@work.example' })]);
  });
});

describe('nothing is lost when a move fails part way', () => {
  const wakeAt = new Date('2026-11-22T09:00:00Z');
  const moves = () => calls.filter((c) => c.path.endsWith('/move')).map((c) => decodeURIComponent(c.path.split('/')[3]));

  test('the default account is stored by its address, and listed as the default mailbox', async () => {
    const { snooze, listSnoozed } = await import('./snooze');
    const store = memoryStore();
    await snooze('u1', 'google', request(['a']), store, now);
    expect(store.rows[0].account).toBe('me@home.example');
    const [view] = await listSnoozed('u1', 'google', store);
    expect(view.account).toBeUndefined();
  });

  test('Outlook wake: what came back is struck from the row, so a retry moves only the rest', async () => {
    const { snooze, wakeDueSnoozes } = await import('./snooze');
    const store = memoryStore();
    await snooze('u1', 'microsoft', request(['m1', 'm2', 'm3']), store, now);
    expect(store.rows[0].messageIds).toEqual(['m1-moved', 'm2-moved', 'm3-moved']);
    calls.length = 0;
    failing = [{ match: '/m2-moved/move', status: 503, times: 1 }];
    expect(await wakeDueSnoozes(wakeAt, store)).toBe(0);
    expect(store.rows[0]).toMatchObject({ messageIds: ['m2-moved'], attempts: 1 });
    calls.length = 0;
    expect(await wakeDueSnoozes(new Date(+wakeAt + 3_600_000), store)).toBe(1);
    expect(moves()).toEqual(['m2-moved']);
    expect(store.rows).toEqual([]);
  });

  test('a message the provider no longer has counts as back; Gmail goes one by one when the batch fails', async () => {
    const { snooze, wakeDueSnoozes } = await import('./snooze');
    const store = memoryStore();
    await snooze('u1', 'microsoft', request(['x1', 'x2']), store, now);
    failing = [{ match: '/x1-moved/move', status: 404 }];
    expect(await wakeDueSnoozes(wakeAt, store)).toBe(1);
    expect(store.rows).toEqual([]);

    await snooze('u1', 'google', request(['g1', 'deleted', 'g2']), store, now);
    calls.length = 0;
    failing = [{ match: '/messages/batchModify', status: 400 }, { match: '/messages/deleted/modify', status: 404 }];
    expect(await wakeDueSnoozes(wakeAt, store)).toBe(1);
    expect(calls.map((c) => c.path)).toEqual(['/messages/batchModify', '/messages/g1/modify', '/messages/deleted/modify', '/messages/g2/modify']);
    expect(calls[1].body).toEqual({ addLabelIds: ['INBOX', 'UNREAD'] });
    expect(store.rows).toEqual([]);
  });

  test('after so many failed wakes it is given up, says so, and is not tried again', async () => {
    const { snooze, wakeDueSnoozes, listSnoozed, MAX_WAKE_ATTEMPTS, dismissSnooze } = await import('./snooze');
    const store = memoryStore();
    await snooze('u1', 'microsoft', request(['m1']), store, now);
    failGraph = true;
    let t = +wakeAt;
    for (let i = 0; i < MAX_WAKE_ATTEMPTS; i++) { await wakeDueSnoozes(new Date(t), store); t += 7 * 60 * 60_000; }
    expect(store.rows[0]).toMatchObject({ attempts: MAX_WAKE_ATTEMPTS, nextAttemptAt: null });
    expect(store.rows[0].givenUpAt).toBeInstanceOf(Date);
    calls.length = 0;
    await wakeDueSnoozes(new Date(t + 86_400_000), store);
    expect(calls).toEqual([]);
    const [view] = await listSnoozed('u1', undefined, store);
    expect(view).toMatchObject({ gaveUp: true, error: 'Mail provider returned an error (HTTP 503).' });
    expect(view.retryAt).toBeUndefined();
    // The owner lets it go: the row goes, nothing is moved.
    expect(await dismissSnooze('u1', view.id, store)).toBe(true);
    expect(calls).toEqual([]);
    expect(store.rows).toEqual([]);
  });

  test('a snooze that moves only some messages keeps a row for those and says the rest stayed', async () => {
    const { snooze, SnoozePartialError } = await import('./snooze');
    const store = memoryStore();
    failing = [{ match: '/m2/move', status: 503 }];
    const err = await snooze('u1', 'microsoft', request(['m1', 'm2', 'm3']), store, now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnoozePartialError);
    expect((err as Error).message).toMatch(/2 of 3 messages were snoozed/);
    expect((err as InstanceType<typeof SnoozePartialError>).snoozed.messageIds).toEqual(['m1-moved', 'm3-moved']);
    // The ids as asked of what moved: the route marks only those as dealt with.
    expect((err as InstanceType<typeof SnoozePartialError>).snoozedIds).toEqual(['m1', 'm3']);
    expect(store.rows[0].messageIds).toEqual(['m1-moved', 'm3-moved']);
    // Nothing moved at all: no row, the error as it was.
    failing = [{ match: '/move', status: 503, times: 5 }];
    await expect(snooze('u1', 'microsoft', request(['n1']), store, now)).rejects.toThrow(/HTTP 503/);
    expect(store.rows).toHaveLength(1);
  });

  test('when the row cannot be stored, the archived mail is put back at once', async () => {
    const { snooze } = await import('./snooze');
    const store = memoryStore();
    store.failInsert = true;
    await expect(snooze('u1', 'microsoft', request(['m1', 'm2']), store, now)).rejects.toThrow(/database unavailable/);
    expect(calls.filter((c) => c.path.endsWith('/move')).map((c) => c.body)).toEqual([
      { destinationId: 'archive' }, { destinationId: 'archive' }, { destinationId: 'inbox' }, { destinationId: 'inbox' },
    ]);
  });
});
