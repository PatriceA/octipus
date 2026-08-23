/**
 * Phase 3g — orgs/workspaces route guards.
 *
 * Verifies that:
 *   - When `multiuser.orgWorkspaces` is off, every endpoint returns
 *     404 — same shape as a missing route, so a fingerprint scanner
 *     can't tell whether the feature exists.
 *   - When the flag is on:
 *     * /api/me/workspaces requires authentication; admins and users
 *       both manage their *own* workspaces (no admin shortcut).
 *     * /api/admin/orgs requires admin; non-admins get 403.
 *     * Cross-tenant workspace IDs collapse to 404 — alice's UUID
 *       can't be patched/deleted by bob.
 *     * Slug validation surfaces as 400; conflicts as 409.
 *
 * Backed by ephemeral PGlite — no Docker.
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
const aliceId = '22222222-2222-2222-2222-222222222222';
const bobId = '33333333-3333-3333-3333-333333333333';

let adminApp: ElysiaLike;
let aliceApp: ElysiaLike;
let bobApp: ElysiaLike;
let anonApp: ElysiaLike;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-orgs-iso-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: adminId, username: 'root', isAdmin: true },
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);

  const { _resetOrgWorkspaceManagerForTests } = await import('@/security/orgs');
  _resetOrgWorkspaceManagerForTests();

  const { workspaceMeRoutes, orgAdminRoutes } = await import('./orgs');
  const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');

  const buildApp = (
    uid: string | null,
    isAdmin: boolean,
    username: string,
  ): ElysiaLike =>
    new Elysia()
      .derive(() => {
        if (!uid) return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL };
        const u = { id: uid, username, isAdmin };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(workspaceMeRoutes).use(orgAdminRoutes)) as unknown as ElysiaLike;

  adminApp = buildApp(adminId, true, 'root');
  aliceApp = buildApp(aliceId, false, 'alice');
  bobApp = buildApp(bobId, false, 'bob');
  anonApp = buildApp(null, false, 'anonymous');
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function postJson(app: ElysiaLike, path: string, body: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function patchJson(app: ElysiaLike, path: string, body: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function del(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, { method: 'DELETE' }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function setFlag(value: boolean) {
  // Imported lazily because tests above this block also share the
  // singleton; cheaper than rebuilding the entire config.
  return import('@/config').then(({ getConfig }) => {
    getConfig().multiuser.orgWorkspaces = value;
  });
}

describe('flag-gated 404 when orgWorkspaces is off', () => {
  test('GET /api/me/workspaces → 200 with default workspace (always available)', async () => {
    await setFlag(false);
    const r = await get(aliceApp, '/api/me/workspaces');
    expect(r.status).toBe(200);
    const body = r.body as { workspaces: Array<{ isDefault: boolean }> };
    expect(body.workspaces.length).toBeGreaterThanOrEqual(1);
    expect(body.workspaces.some((w) => w.isDefault)).toBe(true);
  });

  test('POST /api/me/workspaces → 404 (multi-workspace creation gated)', async () => {
    await setFlag(false);
    const r = await postJson(aliceApp, '/api/me/workspaces', { slug: 'x', name: 'X' });
    expect(r.status).toBe(404);
  });

  test('GET /api/admin/orgs → 404 (even for admin)', async () => {
    await setFlag(false);
    const r = await get(adminApp, '/api/admin/orgs');
    expect(r.status).toBe(404);
  });
});

describe('/api/me/workspaces with flag on', () => {
  test('anon → 401', async () => {
    await setFlag(true);
    const r = await get(anonApp, '/api/me/workspaces');
    expect(r.status).toBe(401);
  });

  test('user creates default workspace lazily on first list', async () => {
    await setFlag(true);
    const r = await get(aliceApp, '/api/me/workspaces');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.workspaces)).toBe(true);
    expect(r.body.workspaces.find((w: { slug: string }) => w.slug === 'default')).toBeDefined();
  });

  test('user creates a named workspace', async () => {
    await setFlag(true);
    const r = await postJson(aliceApp, '/api/me/workspaces', { slug: 'project-x', name: 'Project X' });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe('project-x');
    expect(r.body.userId).toBe(aliceId);
  });

  test('invalid slug → 400', async () => {
    await setFlag(true);
    const r = await postJson(aliceApp, '/api/me/workspaces', { slug: 'NOT VALID', name: 'X' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_slug');
  });

  test('duplicate slug → 409', async () => {
    await setFlag(true);
    const r = await postJson(aliceApp, '/api/me/workspaces', { slug: 'project-x', name: 'X2' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('slug_conflict');
  });

  test('cross-user workspace UUID collapses to 404 on PATCH', async () => {
    await setFlag(true);
    // Find Alice's project-x id, then have Bob try to rename it.
    const list = await get(aliceApp, '/api/me/workspaces');
    const px = list.body.workspaces.find((w: { slug: string }) => w.slug === 'project-x');
    expect(px).toBeDefined();
    const r = await patchJson(bobApp, `/api/me/workspaces/${px.id}`, { name: 'pwned' });
    expect(r.status).toBe(404);
  });

  test('cross-user DELETE collapses to 404', async () => {
    await setFlag(true);
    const list = await get(aliceApp, '/api/me/workspaces');
    const px = list.body.workspaces.find((w: { slug: string }) => w.slug === 'project-x');
    const r = await del(bobApp, `/api/me/workspaces/${px.id}`);
    expect(r.status).toBe(404);
    // Confirm the row still exists for Alice.
    const refreshed = await get(aliceApp, '/api/me/workspaces');
    expect(refreshed.body.workspaces.find((w: { slug: string }) => w.slug === 'project-x')).toBeDefined();
  });

  test('owner can DELETE non-default workspace', async () => {
    await setFlag(true);
    const list = await get(aliceApp, '/api/me/workspaces');
    const px = list.body.workspaces.find((w: { slug: string }) => w.slug === 'project-x');
    const r = await del(aliceApp, `/api/me/workspaces/${px.id}`);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(true);
  });

  test('cannot delete default workspace → 400', async () => {
    await setFlag(true);
    const list = await get(aliceApp, '/api/me/workspaces');
    const def = list.body.workspaces.find((w: { isDefault: boolean }) => w.isDefault);
    expect(def).toBeDefined();
    const r = await del(aliceApp, `/api/me/workspaces/${def.id}`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('cannot_delete_default');
  });
});

describe('/api/admin/orgs with flag on', () => {
  test('non-admin → 403', async () => {
    await setFlag(true);
    const r = await get(aliceApp, '/api/admin/orgs');
    expect(r.status).toBe(403);
  });

  test('anon → 401', async () => {
    await setFlag(true);
    const r = await get(anonApp, '/api/admin/orgs');
    expect(r.status).toBe(401);
  });

  test('admin creates an org', async () => {
    await setFlag(true);
    const r = await postJson(adminApp, '/api/admin/orgs', { slug: 'globex', name: 'Globex' });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe('globex');
  });

  test('admin lists every org regardless of membership', async () => {
    await setFlag(true);
    const r = await get(adminApp, '/api/admin/orgs');
    expect(r.status).toBe(200);
    expect(r.body.orgs.find((o: { slug: string }) => o.slug === 'globex')).toBeDefined();
  });

  test('admin adds a member', async () => {
    await setFlag(true);
    const list = await get(adminApp, '/api/admin/orgs');
    const org = list.body.orgs.find((o: { slug: string }) => o.slug === 'globex');
    const r = await postJson(adminApp, `/api/admin/orgs/${org.id}/members`, {
      userId: aliceId,
      role: 'member',
    });
    expect(r.status).toBe(201);
    expect(r.body.userId).toBe(aliceId);
  });

  test('admin removes a member; idempotent removal returns 404', async () => {
    await setFlag(true);
    const list = await get(adminApp, '/api/admin/orgs');
    const org = list.body.orgs.find((o: { slug: string }) => o.slug === 'globex');
    const r1 = await del(adminApp, `/api/admin/orgs/${org.id}/members/${aliceId}`);
    expect(r1.status).toBe(200);
    const r2 = await del(adminApp, `/api/admin/orgs/${org.id}/members/${aliceId}`);
    expect(r2.status).toBe(404);
  });
});
