/**
 * Phase 3d — admin impersonation route tests.
 *
 * Lives in its own file because the routes need a real `session.token`
 * in the Elysia derive() output (so the manager can hash it and look
 * up the active row); the existing admin.isolation.test.ts harness
 * passes `session: null`. Keeping setup separate avoids retrofitting
 * every test in that file.
 *
 * Verifies:
 *   - Non-admin → 403; anonymous → 401.
 *   - POST /admin/impersonate/:userId without a session token → 400
 *     (impersonation is incompatible with the legacy MASTER_KEY auth
 *     fallback, which has no rotatable session).
 *   - Self-target → 400 with reason; missing target → 404.
 *   - Happy path: returns sessionId + targetUsername; manager.findActive
 *     resolves the same row.
 *   - POST /impersonate/stop closes the active row; second call → 404.
 *   - GET /impersonate lists recent sessions for admins.
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

const adminId = '11111111-1111-1111-1111-111111111111';
const targetId = '22222222-2222-2222-2222-222222222222';
const ADMIN_TOKEN = 'admin-session-token-3d';

let adminApp: ElysiaLike;
let userApp: ElysiaLike;
let anonApp: ElysiaLike;
let adminAppNoSession: ElysiaLike;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-imp-route-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: adminId, username: 'root', isAdmin: true },
    { id: targetId, username: 'alice' },
  ]);

  const { adminRoutes } = await import('./admin');
  const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');

  const buildApp = (uid: string | null, isAdmin: boolean, withSession: boolean): ElysiaLike =>
    new Elysia()
      .derive(() => {
        if (!uid) return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL };
        const u = { id: uid, username: uid === adminId ? 'root' : 'alice', isAdmin };
        return {
          user: u,
          session: withSession ? { token: ADMIN_TOKEN, userId: uid, username: u.username, isAdmin } : null,
          principal: principalFromUser(u, withSession ? ADMIN_TOKEN : null),
        };
      })
      .group('/api', (a) => a.use(adminRoutes)) as unknown as ElysiaLike;

  adminApp = buildApp(adminId, true, true);
  adminAppNoSession = buildApp(adminId, true, false);
  userApp = buildApp(targetId, false, true);
  anonApp = buildApp(null, false, false);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}
async function postJson(app: ElysiaLike, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

describe('POST /api/admin/impersonate/:userId guards', () => {
  test('anonymous → 401', async () => {
    expect((await postJson(anonApp, `/api/admin/impersonate/${targetId}`)).status).toBe(401);
  });

  test('non-admin → 403', async () => {
    expect((await postJson(userApp, `/api/admin/impersonate/${targetId}`)).status).toBe(403);
  });

  test('admin without a real session token → 400', async () => {
    const r = await postJson(adminAppNoSession, `/api/admin/impersonate/${targetId}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/session token/i);
  });

  test('self-target → 400', async () => {
    const r = await postJson(adminApp, `/api/admin/impersonate/${adminId}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/yourself/i);
  });

  test('missing target → 404', async () => {
    const r = await postJson(adminApp, '/api/admin/impersonate/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(404);
  });
});

describe('POST /api/admin/impersonate/:userId happy path + lifecycle', () => {
  test('returns sessionId + target metadata; findActive resolves it', async () => {
    const r = await postJson(adminApp, `/api/admin/impersonate/${targetId}`, { reason: 'support' });
    expect([200, 201]).toContain(r.status);
    expect(r.body.sessionId).toBeDefined();
    expect(r.body.targetUserId).toBe(targetId);
    expect(r.body.targetUsername).toBe('alice');

    const { getImpersonationManager } = await import('@/security/impersonation');
    const active = await getImpersonationManager().findActive(ADMIN_TOKEN);
    expect(active?.id).toBe(r.body.sessionId);
  });

  test('POST /impersonate/stop ends the session; second call → 404', async () => {
    const first = await postJson(adminApp, '/api/admin/impersonate/stop');
    expect(first.status).toBe(200);
    expect(first.body.stopped).toBe(true);

    const second = await postJson(adminApp, '/api/admin/impersonate/stop');
    expect(second.status).toBe(404);
  });
});

describe('GET /api/admin/impersonate', () => {
  test('lists recent sessions for admins', async () => {
    // Seed at least one row.
    await postJson(adminApp, `/api/admin/impersonate/${targetId}`, { reason: 'r' });
    const r = await get(adminApp, '/api/admin/impersonate');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.sessions)).toBe(true);
    expect(r.body.sessions.length).toBeGreaterThan(0);
  });

  test('non-admin → 403', async () => {
    expect((await get(userApp, '/api/admin/impersonate')).status).toBe(403);
  });
});
