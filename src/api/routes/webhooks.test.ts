/**
 * Inbound webhook hardening:
 *  - the HMAC is checked over the raw request bytes (GitHub-style payloads
 *    with escaped unicode and odd spacing verify; a tampered body is a 401);
 *  - the route answers 202 while the hook action is still running;
 *  - a repeated delivery id fires the hook once (path and id-based routes),
 *    claimed in the shared kv store as in_progress (short TTL) then done
 *    (24h), released only when no action ran;
 *  - the run queue: FIFO per hook, per-user caps, a global ceiling shared
 *    round-robin across users, 503 + Retry-After only past a queue bound,
 *    claims refreshed when a queued run starts, and shutdown releasing the
 *    claims of runs still queued;
 *  - cooldown / maxExecutions hold under concurrency (runs are reserved in
 *    the database before the action starts).
 *
 * The storage provider is the Postgres one, on the embedded database, so the
 * claim SQL is the real thing. executeAction is mocked: it records which
 * hooks ran; `block` parks until the test releases it, `fail` returns an
 * unsuccessful result and `throw` throws.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';
import type { Hook } from '@/db/schema/hooks';
import { sha256 } from '@/utils/crypto';

const executed: string[] = [];
const bodies: unknown[] = [];
/** Every action as it starts (before any parking). */
const started: Array<{ name: string; body: unknown }> = [];
/** Parked `block` actions, per hook name, released one by one or all at once. */
const parked = new Map<string, Array<() => void>>();
let holding = false;

vi.mock('@/hooks/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/actions')>()),
  executeAction: vi.fn(async (hook: Hook, context: { webhook?: { body?: unknown } }) => {
    const cfg = (hook.actionConfig ?? {}) as Record<string, unknown>;
    started.push({ name: hook.name, body: context.webhook?.body });
    if (cfg.block === true && holding) {
      await new Promise<void>((resolve) => {
        const list = parked.get(hook.name) ?? [];
        list.push(resolve);
        parked.set(hook.name, list);
      });
    }
    executed.push(hook.name);
    bodies.push(context.webhook?.body);
    if (cfg.throw === true) throw new Error('kaboom');
    if (cfg.fail === true) return { success: false, error: 'boom' };
    return { success: true, data: { ran: hook.name } };
  }),
}));

type App = { handle: (req: Request) => Promise<Response> };
type Delivery = typeof import('@/hooks/webhook-delivery');

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '44444444-4444-4444-4444-444444444444';
const userB = '55555555-5555-5555-5555-555555555555';
const secret = 'gh-secret';
const ids: Record<string, string> = {};
let app: App;
let delivery: Delivery;
let manager: import('@/hooks/manager').HookManager;
let queryRaw: typeof import('@/db/postgres').queryRaw;

const sign = (raw: string | Buffer, key = secret) =>
  `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`;

function post(path: string, raw: string, headers: Record<string, string> = {}) {
  return app.handle(
    new Request(`http://localhost/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    }),
  );
}

/** A signed delivery to /api/webhooks/:path. */
function deliver(path: string, raw: string, headers: Record<string, string> = {}) {
  return post(`/webhooks/${path}`, raw, { 'x-hub-signature-256': sign(raw), ...headers });
}

/** Park every `block` action until released; the returned function releases all. */
function hold(): () => void {
  holding = true;
  return releaseAll;
}

function releaseAll(): void {
  holding = false;
  for (const list of parked.values()) for (const resolve of list.splice(0)) resolve();
}

/** Let the oldest parked run of `name` finish. */
function releaseOne(name: string): void {
  parked.get(name)?.shift()?.();
}

const drain = () => delivery.drainWebhookTasks();

async function executionErrors(hookId: string): Promise<string[]> {
  const { rows } = await queryRaw(
    `SELECT error FROM hook_executions WHERE hook_id = $1 AND status = 'error' ORDER BY created_at`,
    [hookId],
  );
  return (rows as Array<{ error: string }>).map((r) => r.error);
}

// A GitHub-style body: escaped `<`/`>`/`&` and unicode, with spacing and key
// order that JSON.stringify(JSON.parse(raw)) would not reproduce.
const githubRaw =
  '{\n  "action" : "opened",\n  "issue": {"title": "\\u003cscript\\u003e \\u0026 caf\\u00e9",' +
  '   "body":"line1\\nline2 \\u2603"},\n  "zen":"Keep it logically awesome."\n}\n';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-webhooks-'));

  const pg = await import('@/db/postgres');
  queryRaw = pg.queryRaw;
  await pg.initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  // The Postgres provider on the embedded database: exercises the real
  // INSERT ... ON CONFLICT claim.
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });

  const wh = (name: string, path: string | null, action: string, cfg: object, extra = '', owner = userId) => {
    const trig = JSON.stringify(path ? { webhookPath: path, webhookSecret: secret } : { webhookSecret: secret });
    return `('${owner}', '${name}', 'webhook', '${trig}'::jsonb, '${action}', '${JSON.stringify(cfg)}'::jsonb, true${extra})`;
  };
  await pg.executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'wh', false), ('${userB}', 'wh-b', false) ON CONFLICT DO NOTHING`);
  await pg.executeRaw(
    `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled)
     VALUES
       ${wh('gh', 'gh', 'notify', {})},
       ${wh('slow', 'slow', 'spawn_agent', { block: true })},
       ${wh('slow2', 'slow2', 'spawn_agent', { block: true })},
       ${wh('b-slow', 'bslow', 'spawn_agent', { block: true }, '', userB)},
       ${wh('failing', 'failing', 'notify', { fail: true })},
       ${wh('throwing', 'throwing', 'notify', { throw: true })},
       ${wh('incoming', null, 'notify', {})},
       ${wh('incoming-slow', null, 'spawn_agent', { block: true })}`,
  );
  await pg.executeRaw(
    `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled, conditions)
     VALUES ${wh('gh-push', 'ghpush', 'notify', {}, `, '[{"field":"webhook.headers.x-github-event","operator":"equals","value":"push"}]'::jsonb`)}`,
  );
  await pg.executeRaw(
    `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled, cooldown_ms)
     VALUES ${wh('cool', 'cool', 'spawn_agent', { block: true }, ', 600000')}`,
  );
  await pg.executeRaw(
    `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled, max_executions)
     VALUES ${wh('once', 'once', 'notify', {}, ', 1')}`,
  );
  const { rows } = await queryRaw(`SELECT id, name FROM hooks`);
  for (const r of rows as Array<{ id: string; name: string }>) ids[r.name] = r.id;

  const { getHookManager } = await import('@/hooks/manager');
  manager = getHookManager();
  await manager.loadHooks();
  delivery = await import('@/hooks/webhook-delivery');

  const { webhookRoutes } = await import('./webhooks');
  const { webhookIncomingRoutes } = await import('./webhook-incoming');
  app = new Elysia().group('/api', (a) => a.use(webhookRoutes).use(webhookIncomingRoutes)) as unknown as App;
});

afterAll(async () => {
  releaseAll();
  await delivery?.drainWebhookTasks(2000);
  const { closeStorage } = await import('@/db/storage');
  await closeStorage();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(() => {
  executed.length = 0;
  bodies.length = 0;
  started.length = 0;
  releaseAll();
  delivery._setRunLimits();
});

describe('verifyHmacSha256', () => {
  test('accepts only a sha256= signature over the exact bytes', () => {
    const { verifyHmacSha256 } = delivery;
    expect(verifyHmacSha256(githubRaw, secret, sign(githubRaw))).toBe(true);
    expect(verifyHmacSha256(Buffer.from(githubRaw), secret, `sha256=${sign(githubRaw).slice(7).toUpperCase()}`)).toBe(true);
    expect(verifyHmacSha256(JSON.stringify(JSON.parse(githubRaw)), secret, sign(githubRaw))).toBe(false);
    expect(verifyHmacSha256(githubRaw, secret, sign(githubRaw).replace('sha256=', 'sha1='))).toBe(false);
    expect(verifyHmacSha256(githubRaw, secret, 'sha256=abcd')).toBe(false);
    expect(verifyHmacSha256(githubRaw, secret, null)).toBe(false);
    expect(verifyHmacSha256(githubRaw, 'other', sign(githubRaw))).toBe(false);
  });

  test('generic request ids are not delivery ids', () => {
    const h = (o: Record<string, string>) => delivery.getDeliveryId(new Headers(o));
    expect(h({ 'x-request-id': 'r', 'x-delivery-id': 'd' })).toBeNull();
    expect(h({ 'x-request-id': 'r', 'idempotency-key': 'k' })).toBe('k');
    expect(h({ 'x-github-delivery': 'g', 'idempotency-key': 'k' })).toBe('g');
  });
});

describe('POST /api/webhooks/:path — verification', () => {
  test('a GitHub-style payload signed over the raw bytes verifies and is parsed from them', async () => {
    const res = await deliver('gh', githubRaw);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true, accepted: true, hooks: 1 });
    await drain();
    expect(executed).toEqual(['gh']);
    expect(bodies[0]).toEqual(JSON.parse(githubRaw));
  });

  test('a tampered body is rejected with 401 and fires nothing', async () => {
    const tampered = githubRaw.replace('opened', 'closed');
    const res = await post('/webhooks/gh', tampered, { 'x-hub-signature-256': sign(githubRaw) });
    expect(res.status).toBe(401);
    await drain();
    expect(executed).toEqual([]);
  });

  test('a signature over the re-serialised JSON no longer verifies', async () => {
    const res = await post('/webhooks/gh', githubRaw, {
      'x-hub-signature-256': sign(JSON.stringify(JSON.parse(githubRaw))),
    });
    expect(res.status).toBe(401);
  });

  test('an unknown path is a 404 without reading the body', async () => {
    const req = new Request('http://localhost/api/webhooks/nope', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const res = await app.handle(req);
    expect(res.status).toBe(404);
    expect(req.bodyUsed).toBe(false);
  });
});

describe('POST /api/webhooks/:path — background runs', () => {
  test('responds 202 while the action is still running', async () => {
    const open = hold();
    try {
      const res = await deliver('slow', '{"slow":true}');
      expect(res.status).toBe(202);
      expect(executed).toEqual([]); // the action is parked
    } finally {
      open();
    }
    await drain();
    expect(executed).toEqual(['slow']);
  });

  test('drainWebhookTasks gives up after its timeout', async () => {
    const open = hold();
    expect((await deliver('slow', '{}')).status).toBe(202);
    expect(await delivery.drainWebhookTasks(20)).toBe(false);
    open();
    expect(await delivery.drainWebhookTasks(2000)).toBe(true);
  });
});

describe('run queue', () => {
  const names = () => started.map((s) => s.name);

  test('beyond the per-hook cap, deliveries queue (202) and run later in order', async () => {
    const open = hold();
    try {
      for (let n = 1; n <= 5; n++) expect((await deliver('slow', `{"n":${n}}`)).status).toBe(202);
      await vi.waitFor(() => expect(names()).toEqual(['slow', 'slow']));
      // Another hook of the same user isn't held up by this one's queue.
      expect((await deliver('gh', '{}')).status).toBe(202);
      await vi.waitFor(() => expect(executed).toContain('gh'));
      for (let i = 0; i < 3; i++) {
        releaseOne('slow');
        await vi.waitFor(() => expect(started.filter((s) => s.name === 'slow')).toHaveLength(3 + i));
      }
    } finally {
      open();
    }
    await drain();
    expect(started.filter((s) => s.name === 'slow').map((s) => s.body)).toEqual(
      [1, 2, 3, 4, 5].map((n) => ({ n })),
    );
  });

  test('per-user cap: user A’s backlog doesn’t block user B', async () => {
    delivery._setRunLimits({ perUser: 2 });
    const open = hold();
    try {
      for (let i = 0; i < 2; i++) expect((await deliver('slow', '{}')).status).toBe(202);
      for (let i = 0; i < 2; i++) expect((await deliver('slow2', '{}')).status).toBe(202);
      await vi.waitFor(() => expect(names()).toHaveLength(2)); // A is at its cap
      expect((await deliver('bslow', '{}')).status).toBe(202);
      await vi.waitFor(() => expect(names()).toContain('b-slow'));
      expect(names().filter((n) => n !== 'b-slow')).toHaveLength(2); // A still capped
    } finally {
      open();
    }
    await drain();
    expect(executed).toHaveLength(5);
  });

  test('the global ceiling is handed out round-robin across users', async () => {
    delivery._setRunLimits({ global: 2 });
    const open = hold();
    try {
      // A queues four runs across two hooks; two start, two wait.
      for (const path of ['slow', 'slow2', 'slow', 'slow2']) expect((await deliver(path, '{}')).status).toBe(202);
      await vi.waitFor(() => expect(names()).toEqual(['slow', 'slow2']));
      // B arrives behind A's backlog.
      expect((await deliver('bslow', '{}')).status).toBe(202);
      releaseOne('slow');
      // The freed slot goes to B, not to A's next queued run.
      await vi.waitFor(() => expect(names()).toHaveLength(3));
      expect(names()[2]).toBe('b-slow');
      releaseOne('slow2');
      await vi.waitFor(() => expect(names()).toHaveLength(4));
      expect(names()[3]).toBe('slow');
    } finally {
      open();
    }
    await drain();
    expect(executed).toHaveLength(5);
  });

  test('503 + Retry-After only past the per-hook queue bound; the id is not claimed', async () => {
    delivery._setRunLimits({ hookPending: 1 });
    const open = hold();
    const k = `k-${rand(8)}`;
    try {
      expect((await deliver('slow', '{}')).status).toBe(202);
      expect((await deliver('slow', '{}')).status).toBe(202);
      await vi.waitFor(() => expect(names()).toHaveLength(2));
      expect((await deliver('slow', '{}')).status).toBe(202); // queued (1 pending)
      const over = await deliver('slow', '{}', { 'idempotency-key': k });
      expect(over.status).toBe(503);
      expect(over.headers.get('retry-after')).toBe('30');
    } finally {
      open();
    }
    await drain();
    expect(executed).toHaveLength(3);
    // The sender's retry is new, not a duplicate.
    expect((await deliver('slow', '{}', { 'idempotency-key': k })).status).toBe(202);
    await drain();
    expect(executed).toHaveLength(4);
  });

  test('503 past the per-user queue bound, across that user’s hooks', async () => {
    delivery._setRunLimits({ perUser: 1, userPending: 1 });
    const open = hold();
    try {
      expect((await deliver('slow', '{}')).status).toBe(202); // runs
      await vi.waitFor(() => expect(names()).toHaveLength(1));
      expect((await deliver('slow2', '{}')).status).toBe(202); // queued
      expect((await deliver('slow', '{}')).status).toBe(503);
      expect((await deliver('bslow', '{}')).status).toBe(202); // another user is unaffected
    } finally {
      open();
    }
    await drain();
  });

  test('a queued delivery keeps its claim, and the 15-minute TTL restarts when it runs', async () => {
    const id = `d-${rand(8)}`;
    const key = `webhook-delivery:${ids.slow}:${sha256(id)}`;
    const claim = async () => {
      const { rows } = await queryRaw(
        `SELECT value, expires_at > now() + interval '14 minutes' AS fresh FROM kv_store WHERE key = $1`,
        [key],
      );
      return rows[0] as { value: string; fresh: boolean } | undefined;
    };
    const open = hold();
    try {
      expect((await deliver('slow', '{}')).status).toBe(202);
      expect((await deliver('slow', '{}')).status).toBe(202);
      await vi.waitFor(() => expect(names()).toHaveLength(2));
      expect((await deliver('slow', '{}', { 'x-github-delivery': id })).status).toBe(202);
      expect(await claim()).toMatchObject({ value: 'in_progress' });
      // A redelivery while queued is a duplicate.
      expect((await deliver('slow', '{}', { 'x-github-delivery': id })).status).toBe(200);
      // Simulate a long wait in the queue.
      await queryRaw(`UPDATE kv_store SET expires_at = now() + interval '1 minute' WHERE key = $1`, [key]);
      expect(await claim()).toMatchObject({ fresh: false });
      releaseOne('slow');
      await vi.waitFor(() => expect(names()).toHaveLength(3));
      await vi.waitFor(async () => expect(await claim()).toEqual({ value: 'in_progress', fresh: true }));
    } finally {
      open();
    }
    await drain();
    expect(await claim()).toMatchObject({ value: 'done' });
  });

  test('shutdown drops queued runs and releases their claims; running ones get the bounded wait', async () => {
    const id = `d-${rand(8)}`;
    const key = `webhook-delivery:${ids.slow}:${sha256(id)}`;
    const open = hold();
    try {
      expect((await deliver('slow', '{}')).status).toBe(202);
      expect((await deliver('slow', '{}')).status).toBe(202);
      await vi.waitFor(() => expect(names()).toHaveLength(2));
      expect((await deliver('slow', '{}', { 'x-github-delivery': id })).status).toBe(202);

      expect(await delivery.shutdownWebhookTasks(50)).toBe(false); // two still running
      const { rows } = await queryRaw(`SELECT 1 FROM kv_store WHERE key = $1`, [key]);
      expect(rows).toHaveLength(0);
      // New deliveries are turned away while shutting down.
      expect((await deliver('gh', '{}')).status).toBe(503);
    } finally {
      open();
    }
    await drain();
    expect(executed).toEqual(['slow', 'slow']); // the queued one never ran
    delivery._setRunLimits(); // accept again (a restarted process)
    expect((await deliver('slow', '{}', { 'x-github-delivery': id })).status).toBe(202);
    await drain();
    expect(executed).toEqual(['slow', 'slow', 'slow']);
  });
});

describe('POST /api/webhooks/:path — idempotency', () => {
  test('a repeated X-GitHub-Delivery fires the hook once', async () => {
    const headers = { 'x-github-delivery': `d-${rand(8)}` };
    expect((await deliver('gh', '{"n":1}', headers)).status).toBe(202);
    const second = await deliver('gh', '{"n":1}', headers);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    await drain();
    expect(executed).toEqual(['gh']);

    // A different delivery id fires again.
    expect((await deliver('gh', '{"n":1}', { 'x-github-delivery': `d-${rand(8)}` })).status).toBe(202);
    await drain();
    expect(executed).toEqual(['gh', 'gh']);
  });

  test('the shared store is the authority, not the in-process cache', async () => {
    const headers = { 'idempotency-key': `k-${rand(8)}` };
    expect((await deliver('gh', '{"n":2}', headers)).status).toBe(202);
    delivery._resetDeliveryCache(); // as if the redelivery hit another process
    expect((await deliver('gh', '{"n":2}', headers)).status).toBe(200);
    await drain();
    expect(executed).toEqual(['gh']);
  });

  test('X-Request-Id is not used for dedupe', async () => {
    const headers = { 'x-request-id': `r-${rand(8)}` };
    expect((await deliver('gh', '{}', headers)).status).toBe(202);
    expect((await deliver('gh', '{}', headers)).status).toBe(202);
    await drain();
    expect(executed).toEqual(['gh', 'gh']);
  });

  test('an unauthenticated request cannot burn a delivery id', async () => {
    const raw = '{"n":3}';
    const id = `d-${rand(8)}`;
    const bad = await post('/webhooks/gh', raw, { 'x-hub-signature-256': sign(raw, 'wrong'), 'x-github-delivery': id });
    expect(bad.status).toBe(401);
    expect((await deliver('gh', raw, { 'x-github-delivery': id })).status).toBe(202);
    await drain();
    expect(executed).toEqual(['gh']);
  });

  test('the claim is in_progress with a short TTL while running, done for 24h after', async () => {
    const id = `d-${rand(8)}`;
    const claim = async () => {
      const { rows } = await queryRaw(
        `SELECT value,
                expires_at < now() + interval '16 minutes' AS short,
                expires_at > now() + interval '23 hours' AS long
           FROM kv_store WHERE key = $1`,
        [`webhook-delivery:${ids.slow}:${sha256(id)}`],
      );
      return rows as Array<{ value: string; short: boolean; long: boolean }>;
    };
    const open = hold();
    try {
      expect((await deliver('slow', '{}', { 'x-github-delivery': id })).status).toBe(202);
      expect(await claim()).toEqual([expect.objectContaining({ value: 'in_progress', short: true, long: false })]);
    } finally {
      open();
    }
    await drain();
    expect(await claim()).toEqual([expect.objectContaining({ value: 'done', short: false, long: true })]);
  });

  test('a delivery the hook skipped (no action ran) is released for a redelivery', async () => {
    const id = `d-${rand(8)}`;
    expect((await deliver('ghpush', '{}', { 'x-github-delivery': id, 'x-github-event': 'issues' })).status).toBe(202);
    await drain();
    expect(executed).toEqual([]);
    expect((await deliver('ghpush', '{}', { 'x-github-delivery': id, 'x-github-event': 'push' })).status).toBe(202);
    await drain();
    expect(executed).toEqual(['gh-push']);
  });

  test('triggerHook failing before the action: released, and logged in hook_executions', async () => {
    const spy = vi.spyOn(manager, 'triggerHook').mockRejectedValueOnce(new Error('db down'));
    const id = `d-${rand(8)}`;
    try {
      expect((await deliver('gh', '{}', { 'x-github-delivery': id })).status).toBe(202);
      await drain();
    } finally {
      spy.mockRestore();
    }
    expect(executed).toEqual([]);
    expect(await executionErrors(ids.gh)).toContain('db down');
    // Nothing ran, so the redelivery fires.
    expect((await deliver('gh', '{}', { 'x-github-delivery': id })).status).toBe(202);
    await drain();
    expect(executed).toEqual(['gh']);
  });

  test('an action that fails is done: the redelivery is dropped, the failure is logged', async () => {
    const id = `d-${rand(8)}`;
    expect((await deliver('failing', '{}', { 'x-github-delivery': id })).status).toBe(202);
    await drain();
    expect((await deliver('failing', '{}', { 'x-github-delivery': id })).status).toBe(200);
    await drain();
    expect(executed).toEqual(['failing']);
    expect(await executionErrors(ids.failing)).toEqual(['boom']);
  });

  test('an action that throws is done too (no listener-less error event rejects the run)', async () => {
    const id = `d-${rand(8)}`;
    expect((await deliver('throwing', '{}', { 'x-github-delivery': id })).status).toBe(202);
    await drain();
    expect((await deliver('throwing', '{}', { 'x-github-delivery': id })).status).toBe(200);
    await drain();
    expect(executed).toEqual(['throwing']);
    expect(await executionErrors(ids.throwing)).toEqual(['kaboom']);
  });
});

describe('cooldown / maxExecutions under concurrency', () => {
  test('two concurrent deliveries to a hook in cooldown run it once', async () => {
    const open = hold();
    try {
      expect((await deliver('cool', '{}', { 'idempotency-key': `k-${rand(8)}` })).status).toBe(202);
      expect((await deliver('cool', '{}', { 'idempotency-key': `k-${rand(8)}` })).status).toBe(202);
    } finally {
      open();
    }
    await drain();
    expect(executed).toEqual(['cool']);
  });

  test('a stale row cannot run past maxExecutions: the run is reserved in the database', async () => {
    const stale = (await manager.getHook(ids.once))!;
    const event = { type: 'webhook' as const, data: { path: 'once' }, timestamp: new Date() };
    const ctx = { webhook: { path: 'once', method: 'POST', headers: {}, body: {} } };
    // Both callers hold a row read before either ran (executionCount 0).
    const [a, b] = await Promise.all([
      manager.triggerHook(ids.once, event, ctx, { claimedRow: { ...stale } }),
      manager.triggerHook(ids.once, event, ctx, { claimedRow: { ...stale } }),
    ]);
    expect(a.length + b.length).toBe(1);
    expect(executed).toEqual(['once']);
    const { rows } = await queryRaw(`SELECT execution_count FROM hooks WHERE id = $1`, [ids.once]);
    expect((rows[0] as { execution_count: number }).execution_count).toBe(1);

    // A manual test fire still runs and still doesn't count.
    const t = await manager.triggerHook(ids.once, event, ctx, { manualTest: true });
    expect(t).toHaveLength(1);
    const after = await queryRaw(`SELECT execution_count FROM hooks WHERE id = $1`, [ids.once]);
    expect((after.rows[0] as { execution_count: number }).execution_count).toBe(1);
  });
});

describe('POST /api/hooks/incoming/:hookId', () => {
  test('a wrong secret is a 401', async () => {
    const res = await post(`/hooks/incoming/${ids.incoming}`, '{}', { 'x-webhook-secret': 'nope' });
    expect(res.status).toBe(401);
    const res2 = await post(`/hooks/incoming/${ids.incoming}`, '{}', { authorization: `Bearer ${secret}x` });
    expect(res2.status).toBe(401);
  });

  test('responds 202 while the action is still running; queues past the per-hook cap', async () => {
    const open = hold();
    const url = `/hooks/incoming/${ids['incoming-slow']}`;
    const auth = { authorization: `Bearer ${secret}` };
    try {
      const res = await post(url, '{"a":1}', auth);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ accepted: true, hookId: ids['incoming-slow'], hooks: 1 });
      expect(executed).toEqual([]);
      expect((await post(url, '{}', auth)).status).toBe(202);
      expect((await post(url, '{}', auth)).status).toBe(202); // queued
      await vi.waitFor(() => expect(started).toHaveLength(2));
    } finally {
      open();
    }
    await drain();
    expect(executed).toEqual(['incoming-slow', 'incoming-slow', 'incoming-slow']);
  });

  test('a repeated delivery id fires the hook once', async () => {
    const headers = { 'x-webhook-secret': secret, 'idempotency-key': `k-${rand(8)}` };
    expect((await post(`/hooks/incoming/${ids.incoming}`, '{"a":2}', headers)).status).toBe(202);
    const dup = await post(`/hooks/incoming/${ids.incoming}`, '{"a":2}', headers);
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ duplicate: true });
    await drain();
    expect(executed).toEqual(['incoming']);
  });
});
