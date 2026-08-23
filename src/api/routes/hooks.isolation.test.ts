/**
 * Route-level cross-tenant isolation test for /api/hooks and
 * /api/recurring-tasks (which proxies to schedule-trigger hooks).
 *
 * Seeds one hook for alice and one schedule-hook for bob. Verifies
 * that alice cannot read, list, mutate, toggle, test, or delete bob's
 * hooks/tasks through any of the route's endpoints.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

let aliceHooksApp: ElysiaLike;
let aliceTasksApp: ElysiaLike;
let bobHooksApp: ElysiaLike;
const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
let aliceHookId: string;
let bobScheduleId: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-hooks-iso-'));

  const { initializeDb, executeRaw, queryRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES
       ('${aliceId}', 'alice', false),
       ('${bobId}', 'bob', false)
     ON CONFLICT DO NOTHING`,
  );

  await executeRaw(
    `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled)
     VALUES
       ('${aliceId}', 'alice-hook', 'message_received', '{}'::jsonb, 'notify', '{}'::jsonb, true),
       ('${bobId}', 'bob-cron', 'schedule', '{"cronExpression":"* * * * *"}'::jsonb, 'spawn_agent', '{}'::jsonb, true)`,
  );
  const { rows } = await queryRaw(`SELECT id, user_id, trigger FROM hooks`);
  aliceHookId = rows.find((r: any) => r.user_id === aliceId).id;
  bobScheduleId = rows.find((r: any) => r.user_id === bobId).id;

  const { hookRoutes } = await import('./hooks');
  const { recurringTaskRoutes } = await import('./recurring-tasks');
  const { principalFromUser } = await import('@/security/principal');

  const buildHooksApp = (uid: string): ElysiaLike =>
    new Elysia()
      .derive(() => {
        const u = { id: uid, username: 'u', isAdmin: false };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(hookRoutes)) as unknown as ElysiaLike;

  const buildTasksApp = (uid: string): ElysiaLike =>
    new Elysia()
      .derive(() => {
        const u = { id: uid, username: 'u', isAdmin: false };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(recurringTaskRoutes)) as unknown as ElysiaLike;

  aliceHooksApp = buildHooksApp(aliceId);
  bobHooksApp = buildHooksApp(bobId);
  aliceTasksApp = buildTasksApp(aliceId);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}
async function del(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, { method: 'DELETE' }));
  return { status: res.status, body: await res.json() };
}
async function patchJson(app: ElysiaLike, path: string, body: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function postJson(app: ElysiaLike, path: string, body: unknown = {}) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/hooks/:id cross-tenant', () => {
  test('alice cannot fetch bob’s schedule hook — "Hook not found"', async () => {
    const own = await get(aliceHooksApp, `/api/hooks/${aliceHookId}`);
    expect(own.body.id).toBe(aliceHookId);

    const cross = await get(aliceHooksApp, `/api/hooks/${bobScheduleId}`);
    expect(cross.body).toEqual({ error: 'Hook not found' });
  });
});

describe('GET /api/hooks list cross-tenant', () => {
  test('alice sees only her own hooks', async () => {
    const r = await get(aliceHooksApp, '/api/hooks');
    expect(r.body.hooks.find((h: any) => h.id === bobScheduleId)).toBeUndefined();
    expect(r.body.hooks.find((h: any) => h.id === aliceHookId)).toBeDefined();
  });
});

describe('PATCH /api/hooks/:id cross-tenant', () => {
  test('alice cannot mutate bob’s hook', async () => {
    const r = await patchJson(aliceHooksApp, `/api/hooks/${bobScheduleId}`, { name: 'pwned' });
    expect(r.body).toEqual({ error: 'Hook not found' });

    const verify = await get(bobHooksApp, `/api/hooks/${bobScheduleId}`);
    expect(verify.body.name).toBe('bob-cron');
  });
});

describe('DELETE /api/hooks/:id cross-tenant', () => {
  test('alice cannot delete bob’s hook', async () => {
    const r = await del(aliceHooksApp, `/api/hooks/${bobScheduleId}`);
    expect(r.body).toEqual({ error: 'Hook not found' });

    const verify = await get(bobHooksApp, `/api/hooks/${bobScheduleId}`);
    expect(verify.body.id).toBe(bobScheduleId);
  });
});

describe('POST /api/hooks/:id/toggle cross-tenant', () => {
  test('alice cannot disable bob’s hook', async () => {
    const r = await postJson(aliceHooksApp, `/api/hooks/${bobScheduleId}/toggle`, { enabled: false });
    expect(r.body).toEqual({ error: 'Hook not found' });

    const verify = await get(bobHooksApp, `/api/hooks/${bobScheduleId}`);
    expect(verify.body.isEnabled).toBe(true);
  });
});

describe('GET /api/recurring-tasks/:id cross-tenant', () => {
  test('alice cannot fetch bob’s schedule via the recurring-tasks proxy', async () => {
    const r = await get(aliceTasksApp, `/api/recurring-tasks/${bobScheduleId}`);
    expect(r.body).toEqual({ error: 'Task not found' });
  });

  test('alice list returns nothing because she has no schedule hooks', async () => {
    const r = await get(aliceTasksApp, '/api/recurring-tasks');
    expect(r.body.tasks).toEqual([]);
  });
});

describe('DELETE /api/recurring-tasks/:id cross-tenant', () => {
  test('alice cannot delete bob’s schedule hook through the proxy', async () => {
    const r = await del(aliceTasksApp, `/api/recurring-tasks/${bobScheduleId}`);
    expect(r.body).toEqual({ error: 'Task not found' });
  });
});
