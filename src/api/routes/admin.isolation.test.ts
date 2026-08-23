/**
 * Admin route guards — Phase 2c.
 *
 * Verifies that:
 *   - Non-admin callers get 403 on every /admin/* route.
 *   - Anonymous callers get 401.
 *   - Admins can list/create/update users and read the audit log.
 *   - Self-demotion / self-deactivation guard fires (400).
 *   - Audit rows are written for user_created and user_updated.
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

const adminId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';

let adminApp: ElysiaLike;
let userApp: ElysiaLike;
let anonApp: ElysiaLike;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-admin-iso-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: adminId, username: 'root', isAdmin: true },
    { id: userId, username: 'alice', isAdmin: false },
  ]);

  const { adminRoutes } = await import('./admin');
  const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');

  const buildApp = (uid: string | null, isAdmin: boolean): ElysiaLike =>
    new Elysia()
      .derive(() => {
        if (!uid) return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL };
        const u = { id: uid, username: uid === adminId ? 'root' : 'alice', isAdmin };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(adminRoutes)) as unknown as ElysiaLike;

  adminApp = buildApp(adminId, true);
  userApp = buildApp(userId, false);
  anonApp = buildApp(null, false);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}
async function postJson(app: ElysiaLike, path: string, body: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
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
async function del(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, { method: 'DELETE' }));
  return { status: res.status, body: await res.json() };
}

describe('admin routes — guard behavior', () => {
  test('anonymous → 401 on every /admin endpoint', async () => {
    expect((await get(anonApp, '/api/admin/users')).status).toBe(401);
    expect((await get(anonApp, '/api/admin/audit')).status).toBe(401);
  });

  test('non-admin authenticated user → 403', async () => {
    expect((await get(userApp, '/api/admin/users')).status).toBe(403);
    expect((await get(userApp, '/api/admin/audit')).status).toBe(403);
    expect((await postJson(userApp, '/api/admin/users', { username: 'evil' })).status).toBe(403);
  });

  test('admin can list users', async () => {
    const r = await get(adminApp, '/api/admin/users');
    expect(r.status).toBe(200);
    const usernames = r.body.users.map((u: any) => u.username);
    expect(usernames).toContain('root');
    expect(usernames).toContain('alice');
  });
});

describe('admin: user CRUD', () => {
  test('create user + audit row', async () => {
    const r = await postJson(adminApp, '/api/admin/users', {
      username: 'bob', email: 'bob@example.com', isAdmin: false,
    });
    expect([200, 201]).toContain(r.status);
    expect(r.body.username).toBe('bob');
    // Hash never leaks.
    expect((r.body as Record<string, unknown>).passwordHash).toBeUndefined();

    const { queryRaw } = await import('@/db/postgres');
    const audit = await queryRaw(
      `SELECT details FROM audit_log WHERE action='user_created' AND resource_id='${r.body.id}'`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  test('update toggles isActive on another user', async () => {
    const r = await patchJson(adminApp, `/api/admin/users/${userId}`, { isActive: false });
    expect(r.status).toBe(200);
    expect(r.body.isActive).toBe(false);
    // Restore.
    await patchJson(adminApp, `/api/admin/users/${userId}`, { isActive: true });
  });

  test('admin cannot demote themselves (400 guard)', async () => {
    const r = await patchJson(adminApp, `/api/admin/users/${adminId}`, { isAdmin: false });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cannot demote/i);
  });

  test('admin cannot deactivate themselves (400 guard)', async () => {
    const r = await patchJson(adminApp, `/api/admin/users/${adminId}`, { isActive: false });
    expect(r.status).toBe(400);
  });

  test('updating an unknown user returns 404', async () => {
    const r = await patchJson(adminApp, '/api/admin/users/00000000-0000-0000-0000-000000000000', {
      isActive: false,
    });
    expect(r.status).toBe(404);
  });
});

describe('admin: audit log viewer', () => {
  test('lists recent entries with limit', async () => {
    const r = await get(adminApp, '/api/admin/audit?limit=10');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.entries)).toBe(true);
  });

  test('filters by action', async () => {
    const r = await get(adminApp, '/api/admin/audit?action=user_created');
    expect(r.status).toBe(200);
    expect(r.body.entries.every((e: any) => e.action === 'user_created')).toBe(true);
  });
});

describe('admin: quotas', () => {
  test('non-admin → 403 on every quota endpoint', async () => {
    expect((await get(userApp, '/api/admin/quotas')).status).toBe(403);
    expect((await get(userApp, `/api/admin/quotas/${userId}`)).status).toBe(403);
    expect((await patchJson(userApp, `/api/admin/quotas/${userId}`, { maxConcurrentAgents: 1 })).status).toBe(403);
  });

  test('GET /quotas lists every user with effective quota + usage', async () => {
    const r = await get(adminApp, '/api/admin/quotas');
    expect(r.status).toBe(200);
    const usernames = r.body.quotas.map((q: any) => q.username);
    expect(usernames).toContain('root');
    expect(usernames).toContain('alice');
    for (const q of r.body.quotas) {
      expect(typeof q.quota.maxConcurrentAgents).toBe('number');
      expect(typeof q.usage.concurrentAgents).toBe('number');
    }
  });

  test('PATCH sets per-field overrides + audit row written', async () => {
    const r = await patchJson(adminApp, `/api/admin/quotas/${userId}`, {
      maxConcurrentAgents: 3, maxTokensPerDay: 50_000,
    });
    expect(r.status).toBe(200);
    expect(r.body.maxConcurrentAgents).toBe(3);
    expect(r.body.maxTokensPerDay).toBe(50_000);

    // GET reflects the override.
    const detail = await get(adminApp, `/api/admin/quotas/${userId}`);
    expect(detail.body.quota.maxConcurrentAgents).toBe(3);
    expect(detail.body.quota.overrides.maxConcurrentAgents).toBe(true);

    // Audit row written.
    const { queryRaw } = await import('@/db/postgres');
    const audit = await queryRaw(
      `SELECT details FROM audit_log WHERE action='settings_changed' AND resource_type='user_quota' AND resource_id='${userId}'`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  test('PATCH with negative or zero value → 400', async () => {
    const neg = await patchJson(adminApp, `/api/admin/quotas/${userId}`, { maxConcurrentAgents: -5 });
    expect(neg.status).toBe(400);
    const zero = await patchJson(adminApp, `/api/admin/quotas/${userId}`, { maxTokensPerDay: 0 });
    expect(zero.status).toBe(400);
  });

  test('PATCH with null clears that field', async () => {
    await patchJson(adminApp, `/api/admin/quotas/${userId}`, { maxConcurrentAgents: 7 });
    const cleared = await patchJson(adminApp, `/api/admin/quotas/${userId}`, { maxConcurrentAgents: null });
    expect(cleared.body.maxConcurrentAgents).toBeNull();
  });

  test('PATCH for unknown user → 404', async () => {
    const r = await patchJson(adminApp, '/api/admin/quotas/00000000-0000-0000-0000-000000000000', {
      maxConcurrentAgents: 1,
    });
    expect(r.status).toBe(404);
  });

  test('DELETE drops the override row; second call → 404', async () => {
    await patchJson(adminApp, `/api/admin/quotas/${userId}`, { maxConcurrentAgents: 9 });
    const first = await del(adminApp, `/api/admin/quotas/${userId}`);
    expect(first.status).toBe(200);
    expect(first.body.cleared).toBe(true);
    const second = await del(adminApp, `/api/admin/quotas/${userId}`);
    expect(second.status).toBe(404);
  });
});
