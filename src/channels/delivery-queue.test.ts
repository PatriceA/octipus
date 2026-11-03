/**
 * Retrying chat messages whose first send failed (src/channels/delivery-queue.ts),
 * on embedded PGlite. The chat platform is mocked: `umi.fail` makes sends throw
 * the way a platform API outage does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const umi = vi.hoisted(() => ({ fail: false, sent: [] as Array<{ type: string; id: string; content: string }> }));
vi.mock('@/channels/interface', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/channels/interface')>()),
  getUMI: () => ({
    isChannelAvailable: () => !umi.fail,
    isChannelRegistered: () => true,
    send: async (type: string, id: string, res: { content: string }) => {
      if (umi.fail) throw new Error('Channel not connected: telegram');
      umi.sent.push({ type, id, content: res.content });
      return 'msg-1';
    },
  }),
}));

const aliceId = '11111111-1111-4111-8111-111111111111';

let q: typeof import('./delivery-queue');
let executeRaw: (sql: string) => Promise<unknown>;
let rows: <T = Record<string, unknown>>(sql: string) => Promise<T[]>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-delivery-queue-'));
  const db = await import('@/db/postgres');
  await db.initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  executeRaw = db.executeRaw as typeof executeRaw;
  rows = async <T,>(sql: string) => (await db.queryRaw(sql)).rows as T[];
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${aliceId}', 'alice', false) ON CONFLICT DO NOTHING`);
  await executeRaw(`INSERT INTO channel_identities (user_id, channel_type, external_id, verified_at) VALUES ('${aliceId}', 'telegram', 'tg-alice', now())`);
  q = await import('./delivery-queue');
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  umi.fail = false;
  umi.sent = [];
  await executeRaw('DELETE FROM channel_deliveries');
  await executeRaw('DELETE FROM notifications');
});

/** Make every pending row due now. */
const due = () => executeRaw(`UPDATE channel_deliveries SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'`);

describe('deliverDurably', () => {
  test('a send that works leaves no row', async () => {
    const r = await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: 'hi' }, { kind: 'notification' });
    expect(r.ok).toBe(true);
    expect(umi.sent).toHaveLength(1);
    expect(await rows('SELECT 1 FROM channel_deliveries')).toHaveLength(0);
  });

  test('a failed send is queued and goes out on a later flush', async () => {
    umi.fail = true;
    const r = await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: 'build is red' }, { kind: 'notification' });
    expect(r).toMatchObject({ ok: false, reason: 'send_failed', queued: true });
    const [row] = await rows<{ status: string; attempts: number; next_attempt_at: Date }>('SELECT status, attempts, next_attempt_at FROM channel_deliveries');
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20_000);

    // Not due yet: nothing is claimed.
    umi.fail = false;
    expect(await q.flushDeliveries()).toEqual({ sent: 0, retry: 0, failed: 0, dropped: 0 });
    await due();
    expect(await q.flushDeliveries()).toMatchObject({ sent: 1 });
    expect(umi.sent.map((s) => s.content)).toEqual(['build is red']);
    expect(await rows('SELECT status, attempts FROM channel_deliveries')).toEqual([{ status: 'sent', attempts: 2 }]);
  });

  test('a target the user may not message is refused, never queued', async () => {
    umi.fail = true;
    const r = await q.deliverDurably(aliceId, 'telegram', 'tg-someone-else', { content: 'x' }, { kind: 'notification' });
    expect(r).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(r.queued).toBeUndefined();
    expect(await rows('SELECT 1 FROM channel_deliveries')).toHaveLength(0);
  });

  test('a scope of another user is refused', async () => {
    const { loadNotifyScope } = await import('./ownership');
    const scope = await loadNotifyScope(aliceId);
    await expect(q.deliverDurably('22222222-2222-4222-8222-222222222222', 'telegram', 'tg-alice', { content: 'x' }, { kind: 'n', scope }))
      .rejects.toThrow(/another user/);
  });
});

describe('flushDeliveries', () => {
  test('out of attempts, the row fails and the user is told in the app', async () => {
    umi.fail = true;
    await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: 'deploy finished' }, { kind: 'hook_result' });
    for (let i = 1; i < q.MAX_ATTEMPTS; i++) {
      await due();
      await q.flushDeliveries();
    }
    const [row] = await rows<{ status: string; attempts: number }>('SELECT status, attempts FROM channel_deliveries');
    expect(row).toEqual({ status: 'failed', attempts: q.MAX_ATTEMPTS });
    const notes = await rows<{ type: string; title: string; body: string }>('SELECT type, title, body FROM notifications');
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe('channel_delivery_failed');
    expect(notes[0].title).toContain('telegram');
    expect(notes[0].body).toContain('deploy finished');
    expect(notes[0].body).toContain('Channel not connected');
  });

  test('backoff grows with each attempt', async () => {
    umi.fail = true;
    await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: 'x' }, { kind: 'notification' });
    await due();
    await q.flushDeliveries();
    const [row] = await rows<{ attempts: number; next_attempt_at: Date }>('SELECT attempts, next_attempt_at FROM channel_deliveries');
    expect(row.attempts).toBe(2);
    const wait = new Date(row.next_attempt_at).getTime() - Date.now();
    expect(wait).toBeGreaterThan(q.RETRY_DELAYS_MS[1] - 5_000);
    expect(wait).toBeLessThanOrEqual(q.RETRY_DELAYS_MS[1]);
  });

  test('a kind that no longer wants the message drops it; a sent one runs its follow-up', async () => {
    const wanted = new Set(['req-2']);
    const followed: string[] = [];
    q.registerDeliveryKind('test-approval', {
      stillWanted: (row) => wanted.has(String(row.meta.requestId)),
      onSent: (row) => { followed.push(String(row.meta.requestId)); },
    });
    umi.fail = true;
    await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: 'approve 1?' }, { kind: 'test-approval', meta: { requestId: 'req-1' } });
    await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: 'approve 2?' }, { kind: 'test-approval', meta: { requestId: 'req-2' } });
    umi.fail = false;
    await due();
    expect(await q.flushDeliveries()).toMatchObject({ sent: 1, dropped: 1 });
    expect(umi.sent.map((s) => s.content)).toEqual(['approve 2?']);
    expect(followed).toEqual(['req-2']);
  });

  test('a process-local row from an earlier process is dropped, not sent', async () => {
    umi.fail = true;
    await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: 'approve?' }, { kind: 'approval', processLocal: true, meta: { requestId: 'r' } });
    await executeRaw(`UPDATE channel_deliveries SET meta = jsonb_set(meta, '{__process}', '"an-earlier-process"')`);
    umi.fail = false;
    await due();
    expect(await q.flushDeliveries()).toMatchObject({ dropped: 1, sent: 0 });
    expect(umi.sent).toHaveLength(0);
  });

  test('a target unlinked since the failure is dropped', async () => {
    umi.fail = true;
    await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: 'x' }, { kind: 'notification' });
    await executeRaw(`UPDATE channel_deliveries SET channel_id = 'tg-not-alice'`);
    umi.fail = false;
    await due();
    expect(await q.flushDeliveries()).toMatchObject({ dropped: 1 });
    expect(umi.sent).toHaveLength(0);
  });

  test('rows a dead process left mid-send are requeued; fresh ones are not', async () => {
    umi.fail = true;
    await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: 'a' }, { kind: 'notification' });
    await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: 'b' }, { kind: 'notification' });
    await executeRaw(`UPDATE channel_deliveries SET status = 'sending', updated_at = now() - interval '10 minutes' WHERE content = 'a'`);
    await executeRaw(`UPDATE channel_deliveries SET status = 'sending' WHERE content = 'b'`);
    expect(await q.requeueStaleSending()).toBe(1);
    expect(await rows('SELECT content, status FROM channel_deliveries ORDER BY content'))
      .toEqual([{ content: 'a', status: 'pending' }, { content: 'b', status: 'sending' }]);
  });

  test('two flushes at once never send one row twice', async () => {
    umi.fail = true;
    for (const c of ['1', '2', '3', '4']) await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: c }, { kind: 'notification' });
    umi.fail = false;
    await due();
    await Promise.all([q.flushDeliveries(), q.flushDeliveries(), q.flushDeliveries()]);
    expect(umi.sent.map((s) => s.content).sort()).toEqual(['1', '2', '3', '4']);
  });

  test('finished rows past retention are deleted', async () => {
    umi.fail = true;
    await q.deliverDurably(aliceId, 'telegram', 'tg-alice', { content: 'old' }, { kind: 'notification' });
    await executeRaw(`UPDATE channel_deliveries SET status = 'sent', updated_at = now() - interval '8 days'`);
    await q.flushDeliveries();
    expect(await rows('SELECT 1 FROM channel_deliveries')).toHaveLength(0);
  });
});
