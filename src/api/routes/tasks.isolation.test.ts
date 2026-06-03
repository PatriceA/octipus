/**
 * Route-level cross-tenant isolation test for /api/tasks.
 *
 * Seeds one task for alice and one for bob. Verifies alice cannot read,
 * list, mutate, or delete bob's task through any endpoint — cross-tenant
 * ids return "Task not found", indistinguishable from a missing row.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

let aliceApp: ElysiaLike;
let bobApp: ElysiaLike;
const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
let aliceTaskId: string;
let bobTaskId: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-tasks-iso-'));

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
    `INSERT INTO tasks (user_id, title, status, priority)
     VALUES
       ('${aliceId}', 'alice-task', 'open', 2),
       ('${bobId}', 'bob-task', 'open', 1)`,
  );
  const { rows } = await queryRaw(`SELECT id, user_id FROM tasks`);
  aliceTaskId = rows.find((r: any) => r.user_id === aliceId).id;
  bobTaskId = rows.find((r: any) => r.user_id === bobId).id;

  const { taskRoutes } = await import('./tasks');
  const { principalFromUser } = await import('@/security/principal');

  const buildApp = (uid: string): ElysiaLike =>
    new Elysia()
      .derive(() => {
        const u = { id: uid, username: 'u', isAdmin: false };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(taskRoutes)) as unknown as ElysiaLike;

  aliceApp = buildApp(aliceId);
  bobApp = buildApp(bobId);
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

describe('GET /api/tasks/:id cross-tenant', () => {
  test('alice reads her own task but not bob’s', async () => {
    const own = await get(aliceApp, `/api/tasks/${aliceTaskId}`);
    expect(own.body.id).toBe(aliceTaskId);

    const cross = await get(aliceApp, `/api/tasks/${bobTaskId}`);
    expect(cross.body).toEqual({ error: 'Task not found' });
  });
});

describe('GET /api/tasks list cross-tenant', () => {
  test('alice sees only her own tasks', async () => {
    const r = await get(aliceApp, '/api/tasks');
    expect(r.body.tasks.find((t: any) => t.id === bobTaskId)).toBeUndefined();
    expect(r.body.tasks.find((t: any) => t.id === aliceTaskId)).toBeDefined();
  });
});

describe('PATCH /api/tasks/:id cross-tenant', () => {
  test('alice cannot mutate bob’s task', async () => {
    const r = await patchJson(aliceApp, `/api/tasks/${bobTaskId}`, { title: 'pwned' });
    expect(r.body).toEqual({ error: 'Task not found' });

    const verify = await get(bobApp, `/api/tasks/${bobTaskId}`);
    expect(verify.body.title).toBe('bob-task');
  });
});

describe('DELETE /api/tasks/:id cross-tenant', () => {
  test('alice cannot delete bob’s task', async () => {
    const r = await del(aliceApp, `/api/tasks/${bobTaskId}`);
    expect(r.body).toEqual({ error: 'Task not found' });

    const verify = await get(bobApp, `/api/tasks/${bobTaskId}`);
    expect(verify.body.id).toBe(bobTaskId);
  });
});

describe('own-task lifecycle', () => {
  test('create → complete sets completedAt; reopen clears it', async () => {
    const created = await postJson(aliceApp, '/api/tasks', { title: 'ship it', priority: 3 });
    expect(created.body.status).toBe('open');
    expect(created.body.completedAt).toBeNull();
    const id = created.body.id;

    const done = await patchJson(aliceApp, `/api/tasks/${id}`, { status: 'done' });
    expect(done.body.status).toBe('done');
    expect(done.body.completedAt).not.toBeNull();

    const reopened = await patchJson(aliceApp, `/api/tasks/${id}`, { status: 'open' });
    expect(reopened.body.completedAt).toBeNull();
  });

  test('invalid status is rejected, not coerced', async () => {
    const created = await postJson(aliceApp, '/api/tasks', { title: 'x' });
    const bad = await patchJson(aliceApp, `/api/tasks/${created.body.id}`, { status: 'bogus' });
    expect(bad.body).toEqual({ error: 'Invalid status "bogus"' });
  });
});
