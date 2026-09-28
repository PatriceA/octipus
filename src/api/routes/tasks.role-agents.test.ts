/**
 * /api/tasks/role-agents: the tasks page's panel of role heartbeat agents.
 *
 * GET lists the roles the caller has tasks assigned to (or a role heartbeat
 * for), with active-task counts, the hook state and whether tasks/write is
 * ALLOW; PUT turns a role's heartbeat hook on or off. Everything is the
 * caller's own: bob's tasks and hooks never show up for alice, and alice's
 * toggle never touches bob's hook. It is per user across workspaces, like the
 * hook it toggles and that hook's probe.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
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

// The real heartbeat module, with ensureRoleHeartbeatHook wrapped so one test
// can make it fail the way a database error would.
vi.mock('@/core/heartbeat', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/core/heartbeat')>();
  return { ...real, ensureRoleHeartbeatHook: vi.fn(real.ensureRoleHeartbeatHook) };
});

let aliceApp: ElysiaLike;
/** Alice with a workspace selected: the panel is still per user. */
let aliceInWorkspaceApp: ElysiaLike;
const workspaceA = '33333333-3333-3333-3333-333333333333';
const workspaceB = '55555555-5555-5555-5555-555555555555';
let bobApp: ElysiaLike;
let anonApp: ElysiaLike;
const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-tasks-role-agents-'));

  const { initializeDb, executeRaw } = await import('@/db/postgres');
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
    `INSERT INTO tasks (user_id, title, status, priority, assignee_kind, assignee_ref) VALUES
       ('${aliceId}', 'spec it', 'open', 0, 'role', 'pm'),
       ('${aliceId}', 'plan it', 'in_progress', 0, 'role', 'pm'),
       ('${aliceId}', 'shipped', 'done', 0, 'role', 'pm'),
       ('${aliceId}', 'test it', 'open', 0, 'role', 'qa'),
       ('${aliceId}', 'mine', 'open', 0, 'user', 'me'),
       ('${aliceId}', 'nobody', 'open', 0, NULL, NULL),
       ('${bobId}', 'bob review', 'open', 0, 'role', 'review')`,
  );

  await executeRaw(
    `INSERT INTO workspaces (id, user_id, slug, name) VALUES
       ('${workspaceA}', '${aliceId}', 'a', 'A'),
       ('${workspaceB}', '${aliceId}', 'b', 'B')`,
  );
  // A qa task filed under workspace B: counted even when alice is in A.
  await executeRaw(
    `INSERT INTO tasks (user_id, workspace_id, title, status, priority, assignee_kind, assignee_ref)
     VALUES ('${aliceId}', '${workspaceB}', 'test it in B', 'in_progress', 0, 'role', 'qa')`,
  );

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
  aliceInWorkspaceApp = new Elysia()
    .derive(() => {
      const u = { id: aliceId, username: 'u', isAdmin: false };
      return { user: u, session: null, principal: { ...principalFromUser(u), workspaceId: workspaceA } };
    })
    .group('/api', (a) => a.use(taskRoutes)) as unknown as ElysiaLike;
  bobApp = buildApp(bobId);
  anonApp = new Elysia()
    .derive(() => ({ user: null, session: null, principal: null }))
    .group('/api', (a) => a.use(taskRoutes)) as unknown as ElysiaLike;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function send(app: ElysiaLike, method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/tasks/role-agents', () => {
  test('refuses an unauthenticated caller', async () => {
    expect((await send(anonApp, 'GET', '/api/tasks/role-agents')).status).toBe(401);
    expect((await send(anonApp, 'PUT', '/api/tasks/role-agents', { role: 'pm', enabled: true })).status).toBe(401);
  });

  test('lists the caller’s assigned roles with counts, none enabled yet, board writes not allowed', async () => {
    const { status, body } = await send(aliceApp, 'GET', '/api/tasks/role-agents');
    expect(status).toBe(200);
    expect(body.boardWritesAllowed).toBe(false);
    expect(body.heartbeatEnabled).toBe(false);
    expect(body.roles).toEqual([
      { role: 'pm', activeTasks: 2, totalTasks: 3, enabled: false, hookId: null, known: true },
      { role: 'qa', activeTasks: 2, totalTasks: 2, enabled: false, hookId: null, known: true },
    ]);
  });

  test('is per user across workspaces: the same counts whichever workspace is selected', async () => {
    const all = await send(aliceApp, 'GET', '/api/tasks/role-agents');
    const inA = await send(aliceInWorkspaceApp, 'GET', '/api/tasks/role-agents');
    expect(inA.body.roles).toEqual(all.body.roles);
  });

  test('reports the server heartbeat switch', async () => {
    const { getConfig } = await import('@/config');
    const hb = getConfig().heartbeat;
    const was = hb.enabled;
    hb.enabled = true;
    try {
      expect((await send(aliceApp, 'GET', '/api/tasks/role-agents')).body.heartbeatEnabled).toBe(true);
    } finally {
      hb.enabled = was;
    }
  });

  test('does not show another user’s roles', async () => {
    const alice = await send(aliceApp, 'GET', '/api/tasks/role-agents');
    expect(alice.body.roles.map((r: { role: string }) => r.role)).not.toContain('review');
    const bob = await send(bobApp, 'GET', '/api/tasks/role-agents');
    expect(bob.body.roles.map((r: { role: string }) => r.role)).toEqual(['review']);
  });

  test('reports tasks/write once the user allows it', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    await getPermissionManager().setPermission(bobId, 'tasks', 'write', 'ALLOW');
    expect((await send(bobApp, 'GET', '/api/tasks/role-agents')).body.boardWritesAllowed).toBe(true);
    expect((await send(aliceApp, 'GET', '/api/tasks/role-agents')).body.boardWritesAllowed).toBe(false);
  });
});

describe('PUT /api/tasks/role-agents', () => {
  test('enables a role agent (one hook, idempotent), then disables it', async () => {
    const on = await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'pm', enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ role: 'pm', enabled: true });
    const again = await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'pm', enabled: true });
    expect(again.body.hookId).toBe(on.body.hookId);

    let list = await send(aliceApp, 'GET', '/api/tasks/role-agents');
    expect(list.body.roles.find((r: { role: string }) => r.role === 'pm')).toMatchObject({ enabled: true, hookId: on.body.hookId });
    expect(list.body.roles.find((r: { role: string }) => r.role === 'qa')).toMatchObject({ enabled: false, hookId: null });

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `SELECT id, user_id, is_enabled, trigger_config FROM hooks WHERE trigger = 'heartbeat' AND trigger_config->>'role' = 'pm'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(aliceId);

    const off = await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'pm', enabled: false });
    expect(off.body).toEqual({ role: 'pm', enabled: false });
    list = await send(aliceApp, 'GET', '/api/tasks/role-agents');
    expect(list.body.roles.find((r: { role: string }) => r.role === 'pm')).toMatchObject({ enabled: false, hookId: on.body.hookId });
  });

  test('a role heartbeat with no tasks left still lists, so it can be turned off', async () => {
    await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'research', enabled: true });
    const list = await send(aliceApp, 'GET', '/api/tasks/role-agents');
    expect(list.body.roles.find((r: { role: string }) => r.role === 'research')).toMatchObject({ enabled: true, activeTasks: 0, totalTasks: 0 });
  });

  test('refuses an unknown role to turn on, a malformed one either way; an unknown one may be turned off', async () => {
    const r = await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'no-such-role', enabled: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Unknown role');
    const bad = await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'Not A Role', enabled: false });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('Invalid role');
    const off = await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'no-such-role', enabled: false });
    expect(off.status).toBe(200);
  });

  test('an unexpected failure is a 500 with a generic message, not the error text', async () => {
    const hb = await import('@/core/heartbeat');
    vi.mocked(hb.ensureRoleHeartbeatHook).mockRejectedValueOnce(new Error('connection to db lost at 10.0.0.3'));
    const r = await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'qa', enabled: true });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Could not update the role agent' });
  });

  test('duplicate hooks for a role: any enabled one shows as on, off disables all, on keeps one', async () => {
    const { executeRaw, queryRaw } = await import('@/db/postgres');
    // Two rows for "writing", as a racing POST /api/hooks could leave them.
    await executeRaw(
      `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled, created_at) VALUES
         ('${aliceId}', 'hb writing 1', 'heartbeat', '{"role":"writing"}', 'spawn_agent', '{}', false, now() - interval '2 hours'),
         ('${aliceId}', 'hb writing 2', 'heartbeat', '{"role":"writing"}', 'spawn_agent', '{}', true, now() - interval '1 hour')`,
    );
    const ids = async () =>
      (await queryRaw(`SELECT name, is_enabled FROM hooks WHERE user_id = '${aliceId}' AND trigger_config->>'role' = 'writing' ORDER BY name`)).rows
        .map((r: { name: string; is_enabled: boolean }) => `${r.name}:${r.is_enabled}`);
    const row = async () => (await send(aliceApp, 'GET', '/api/tasks/role-agents')).body.roles.find((r: { role: string }) => r.role === 'writing');

    expect(await row()).toMatchObject({ enabled: true });
    // On while one is already on: nothing else is switched on.
    await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'writing', enabled: true });
    expect(await ids()).toEqual(['hb writing 1:false', 'hb writing 2:true']);

    await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'writing', enabled: false });
    expect(await ids()).toEqual(['hb writing 1:false', 'hb writing 2:false']);
    expect(await row()).toMatchObject({ enabled: false });

    // On from all-off: exactly one (the oldest) comes back.
    await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'writing', enabled: true });
    expect(await ids()).toEqual(['hb writing 1:true', 'hb writing 2:false']);
    expect(await row()).toMatchObject({ enabled: true });
  });

  test('bob turning off his "pm" agent leaves alice’s alone', async () => {
    await send(aliceApp, 'PUT', '/api/tasks/role-agents', { role: 'pm', enabled: true });
    await send(bobApp, 'PUT', '/api/tasks/role-agents', { role: 'pm', enabled: false });
    const list = await send(aliceApp, 'GET', '/api/tasks/role-agents');
    expect(list.body.roles.find((r: { role: string }) => r.role === 'pm')).toMatchObject({ enabled: true });
  });
});
