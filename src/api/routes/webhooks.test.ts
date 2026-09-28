/**
 * Inbound webhook hardening:
 *  - the HMAC is checked over the raw request bytes (GitHub-style payloads
 *    with escaped unicode and odd spacing verify; a tampered body is a 401);
 *  - the route answers 202 while the hook action is still running;
 *  - a repeated delivery id fires the hook once (path and id-based routes).
 *
 * executeAction is mocked: it records which hooks ran and, for a hook whose
 * actionConfig has `block: true`, waits on a deferred the test resolves.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';
import type { Hook } from '@/db/schema/hooks';

const executed: string[] = [];
const bodies: unknown[] = [];
let release: (() => void) | null = null;
let gate: Promise<void> = Promise.resolve();

vi.mock('@/hooks/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/actions')>()),
  executeAction: vi.fn(async (hook: Hook, context: { webhook?: { body?: unknown } }) => {
    if ((hook.actionConfig as Record<string, unknown> | null)?.block === true) await gate;
    executed.push(hook.name);
    bodies.push(context.webhook?.body);
    return { success: true, data: { ran: hook.name } };
  }),
}));

type App = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '44444444-4444-4444-4444-444444444444';
const secret = 'gh-secret';
const ids: Record<string, string> = {};
let app: App;

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

// A GitHub-style body: escaped `<`/`>`/`&` and unicode, with spacing and key
// order that JSON.stringify(JSON.parse(raw)) would not reproduce.
const githubRaw =
  '{\n  "action" : "opened",\n  "issue": {"title": "\\u003cscript\\u003e \\u0026 caf\\u00e9",' +
  '   "body":"line1\\nline2 \\u2603"},\n  "zen":"Keep it logically awesome."\n}\n';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-webhooks-'));

  const { initializeDb, executeRaw, queryRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });

  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'wh', false) ON CONFLICT DO NOTHING`);
  await executeRaw(
    `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled)
     VALUES
       ('${userId}', 'gh', 'webhook', '{"webhookPath":"gh","webhookSecret":"${secret}"}'::jsonb, 'notify', '{}'::jsonb, true),
       ('${userId}', 'slow', 'webhook', '{"webhookPath":"slow","webhookSecret":"${secret}"}'::jsonb, 'spawn_agent', '{"block":true}'::jsonb, true),
       ('${userId}', 'incoming', 'webhook', '{"webhookSecret":"${secret}"}'::jsonb, 'notify', '{}'::jsonb, true),
       ('${userId}', 'incoming-slow', 'webhook', '{"webhookSecret":"${secret}"}'::jsonb, 'spawn_agent', '{"block":true}'::jsonb, true)`,
  );
  const { rows } = await queryRaw(`SELECT id, name FROM hooks`);
  for (const r of rows as Array<{ id: string; name: string }>) ids[r.name] = r.id;

  const { getHookManager } = await import('@/hooks/manager');
  await getHookManager().loadHooks();

  const { webhookRoutes } = await import('./webhooks');
  const { webhookIncomingRoutes } = await import('./webhook-incoming');
  app = new Elysia().group('/api', (a) => a.use(webhookRoutes).use(webhookIncomingRoutes)) as unknown as App;
});

afterAll(async () => {
  release?.();
  const { drainWebhookTasks } = await import('@/hooks/webhook-delivery');
  await drainWebhookTasks();
  const { closeStorage } = await import('@/db/storage');
  await closeStorage();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(() => {
  executed.length = 0;
  bodies.length = 0;
});

async function drain() {
  const { drainWebhookTasks } = await import('@/hooks/webhook-delivery');
  await drainWebhookTasks();
}

describe('verifyHmacSha256', () => {
  test('accepts only a sha256= signature over the exact bytes', async () => {
    const { verifyHmacSha256 } = await import('@/hooks/webhook-delivery');
    expect(verifyHmacSha256(githubRaw, secret, sign(githubRaw))).toBe(true);
    expect(verifyHmacSha256(Buffer.from(githubRaw), secret, sign(githubRaw).toUpperCase().replace('SHA256', 'sha256'))).toBe(true);
    expect(verifyHmacSha256(JSON.stringify(JSON.parse(githubRaw)), secret, sign(githubRaw))).toBe(false);
    expect(verifyHmacSha256(githubRaw, secret, sign(githubRaw).replace('sha256=', 'sha1='))).toBe(false);
    expect(verifyHmacSha256(githubRaw, secret, 'sha256=abcd')).toBe(false);
    expect(verifyHmacSha256(githubRaw, secret, null)).toBe(false);
    expect(verifyHmacSha256(githubRaw, 'other', sign(githubRaw))).toBe(false);
  });
});

describe('POST /api/webhooks/:path', () => {
  test('a GitHub-style payload signed over the raw bytes verifies and is parsed from them', async () => {
    const res = await post('/webhooks/gh', githubRaw, { 'x-hub-signature-256': sign(githubRaw) });
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

  test('responds 202 while the action is still running', async () => {
    gate = new Promise<void>((r) => { release = r; });
    const raw = '{"slow":true}';
    const res = await post('/webhooks/slow', raw, { 'x-hub-signature-256': sign(raw) });
    expect(res.status).toBe(202);
    expect(executed).toEqual([]); // the action is parked on the gate
    release!();
    await drain();
    expect(executed).toEqual(['slow']);
  });

  test('a repeated X-GitHub-Delivery fires the hook once', async () => {
    const raw = '{"n":1}';
    const headers = { 'x-hub-signature-256': sign(raw), 'x-github-delivery': `d-${rand(8)}` };
    const first = await post('/webhooks/gh', raw, headers);
    expect(first.status).toBe(202);
    const second = await post('/webhooks/gh', raw, headers);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    await drain();
    expect(executed).toEqual(['gh']);

    // A different delivery id fires again.
    const third = await post('/webhooks/gh', raw, { ...headers, 'x-github-delivery': `d-${rand(8)}` });
    expect(third.status).toBe(202);
    await drain();
    expect(executed).toEqual(['gh', 'gh']);
  });

  test('the duplicate is caught by the shared store, not only the in-process cache', async () => {
    const { _resetDeliveryCache } = await import('@/hooks/webhook-delivery');
    const raw = '{"n":2}';
    const headers = { 'x-hub-signature-256': sign(raw), 'idempotency-key': `k-${rand(8)}` };
    expect((await post('/webhooks/gh', raw, headers)).status).toBe(202);
    _resetDeliveryCache(); // as if the redelivery hit another process
    expect((await post('/webhooks/gh', raw, headers)).status).toBe(200);
    await drain();
    expect(executed).toEqual(['gh']);
  });

  test('an unauthenticated request cannot burn a delivery id', async () => {
    const raw = '{"n":3}';
    const id = `d-${rand(8)}`;
    const bad = await post('/webhooks/gh', raw, { 'x-hub-signature-256': sign(raw, 'wrong'), 'x-github-delivery': id });
    expect(bad.status).toBe(401);
    const good = await post('/webhooks/gh', raw, { 'x-hub-signature-256': sign(raw), 'x-github-delivery': id });
    expect(good.status).toBe(202);
    await drain();
    expect(executed).toEqual(['gh']);
  });
});

describe('POST /api/hooks/incoming/:hookId', () => {
  test('a wrong secret is a 401', async () => {
    const res = await post(`/hooks/incoming/${ids['incoming']}`, '{}', { 'x-webhook-secret': 'nope' });
    expect(res.status).toBe(401);
    const res2 = await post(`/hooks/incoming/${ids['incoming']}`, '{}', { authorization: `Bearer ${secret}x` });
    expect(res2.status).toBe(401);
  });

  test('responds 202 while the action is still running', async () => {
    gate = new Promise<void>((r) => { release = r; });
    const res = await post(`/hooks/incoming/${ids['incoming-slow']}`, '{"a":1}', { authorization: `Bearer ${secret}` });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true, hookId: ids['incoming-slow'], hooks: 1 });
    expect(executed).toEqual([]);
    release!();
    await drain();
    expect(executed).toEqual(['incoming-slow']);
  });

  test('a repeated delivery id fires the hook once', async () => {
    const headers = { 'x-webhook-secret': secret, 'x-request-id': `r-${rand(8)}` };
    expect((await post(`/hooks/incoming/${ids['incoming']}`, '{"a":2}', headers)).status).toBe(202);
    const dup = await post(`/hooks/incoming/${ids['incoming']}`, '{"a":2}', headers);
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ duplicate: true });
    await drain();
    expect(executed).toEqual(['incoming']);
  });
});
