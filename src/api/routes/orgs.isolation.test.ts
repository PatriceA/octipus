/**
 * Phase 3g — orgs/workspaces route guards.
 *
 * Workspaces are always on. Verifies that:
 *   - /api/me/workspaces requires authentication; admins and users
 *     both manage their *own* workspaces (no admin shortcut).
 *   - /api/admin/orgs requires admin; non-admins get 403.
 *   - Cross-tenant workspace IDs collapse to 404 — alice's UUID
 *     can't be patched/deleted by bob.
 *   - Slug validation surfaces as 400; conflicts as 409.
 *   - A workspace's files stay in its own directory when the default
 *     changes (setDefault, createWorkspace isDefault), follow it on a
 *     transfer, and are removed with it.
 *
 * Backed by ephemeral PGlite — no Docker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const carolId = '44444444-4444-4444-4444-444444444444';
const daveId = '55555555-5555-5555-5555-555555555555';
// Workspace files land here, not under the repository.
const dataRoot = mkdtempSync(join(tmpdir(), 'octipus-orgs-iso-files-'));
process.env.WORKSPACE_PATH = dataRoot;

let adminApp: ElysiaLike;
let aliceApp: ElysiaLike;
let bobApp: ElysiaLike;
let anonApp: ElysiaLike;
let carolApp: ElysiaLike;
let daveApp: ElysiaLike;

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
    { id: carolId, username: 'carol' },
    { id: daveId, username: 'dave' },
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
  carolApp = buildApp(carolId, false, 'carol');
  daveApp = buildApp(daveId, false, 'dave');
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

describe('/api/me/workspaces', () => {
  test('anon → 401', async () => {
    const r = await get(anonApp, '/api/me/workspaces');
    expect(r.status).toBe(401);
  });

  test('user creates default workspace lazily on first list', async () => {
    const r = await get(aliceApp, '/api/me/workspaces');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.workspaces)).toBe(true);
    expect(r.body.workspaces.find((w: { slug: string }) => w.slug === 'default')).toBeDefined();
  });

  test('user creates a named workspace', async () => {
    const r = await postJson(aliceApp, '/api/me/workspaces', { slug: 'project-x', name: 'Project X' });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe('project-x');
    expect(r.body.userId).toBe(aliceId);
  });

  test('invalid slug → 400', async () => {
    const r = await postJson(aliceApp, '/api/me/workspaces', { slug: 'NOT VALID', name: 'X' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_slug');
  });

  test('duplicate slug → 409', async () => {
    const r = await postJson(aliceApp, '/api/me/workspaces', { slug: 'project-x', name: 'X2' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('slug_conflict');
  });

  test('cross-user workspace UUID collapses to 404 on PATCH', async () => {
    // Find Alice's project-x id, then have Bob try to rename it.
    const list = await get(aliceApp, '/api/me/workspaces');
    const px = list.body.workspaces.find((w: { slug: string }) => w.slug === 'project-x');
    expect(px).toBeDefined();
    const r = await patchJson(bobApp, `/api/me/workspaces/${px.id}`, { name: 'pwned' });
    expect(r.status).toBe(404);
  });

  test('cross-user DELETE collapses to 404', async () => {
    const list = await get(aliceApp, '/api/me/workspaces');
    const px = list.body.workspaces.find((w: { slug: string }) => w.slug === 'project-x');
    const r = await del(bobApp, `/api/me/workspaces/${px.id}`);
    expect(r.status).toBe(404);
    // Confirm the row still exists for Alice.
    const refreshed = await get(aliceApp, '/api/me/workspaces');
    expect(refreshed.body.workspaces.find((w: { slug: string }) => w.slug === 'project-x')).toBeDefined();
  });

  test('owner can DELETE non-default workspace', async () => {
    const list = await get(aliceApp, '/api/me/workspaces');
    const px = list.body.workspaces.find((w: { slug: string }) => w.slug === 'project-x');
    const r = await del(aliceApp, `/api/me/workspaces/${px.id}`);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(true);
  });

  test('cannot delete default workspace → 400', async () => {
    const list = await get(aliceApp, '/api/me/workspaces');
    const def = list.body.workspaces.find((w: { isDefault: boolean }) => w.isDefault);
    expect(def).toBeDefined();
    const r = await del(aliceApp, `/api/me/workspaces/${def.id}`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('cannot_delete_default');
  });
});

describe('/api/admin/orgs (admin-gated)', () => {
  test('non-admin → 403', async () => {
    const r = await get(aliceApp, '/api/admin/orgs');
    expect(r.status).toBe(403);
  });

  test('anon → 401', async () => {
    const r = await get(anonApp, '/api/admin/orgs');
    expect(r.status).toBe(401);
  });

  test('admin creates an org', async () => {
    const r = await postJson(adminApp, '/api/admin/orgs', { slug: 'globex', name: 'Globex' });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe('globex');
  });

  test('admin lists every org regardless of membership', async () => {
    const r = await get(adminApp, '/api/admin/orgs');
    expect(r.status).toBe(200);
    expect(r.body.orgs.find((o: { slug: string }) => o.slug === 'globex')).toBeDefined();
  });

  test('admin adds a member', async () => {
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
    const list = await get(adminApp, '/api/admin/orgs');
    const org = list.body.orgs.find((o: { slug: string }) => o.slug === 'globex');
    const r1 = await del(adminApp, `/api/admin/orgs/${org.id}/members/${aliceId}`);
    expect(r1.status).toBe(200);
    const r2 = await del(adminApp, `/api/admin/orgs/${org.id}/members/${aliceId}`);
    expect(r2.status).toBe(404);
  });
});

describe('/api/me/workspaces — files follow their workspace', () => {
  type Ws = { id: string; slug: string; isDefault: boolean; filesDir: string; userId: string };

  /** The files root of `workspaceId` for `userId`, as every agent and file surface computes it. */
  async function rootOf(userId: string, workspaceId: string): Promise<string> {
    const { WorkspaceFS } = await import('@/security/workspace-fs');
    const { principalFromUser } = await import('@/security/principal');
    const p = principalFromUser({ id: userId, username: 'x', isAdmin: false });
    return WorkspaceFS.forPrincipal({ ...p, workspaceId }).root;
  }
  async function write(userId: string, workspaceId: string, name: string, text: string): Promise<void> {
    const root = await rootOf(userId, workspaceId);
    expect(root.startsWith(dataRoot)).toBe(true);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, name), text);
  }
  async function read(userId: string, workspaceId: string, name: string): Promise<string | null> {
    const file = join(await rootOf(userId, workspaceId), name);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
  async function list(app: ElysiaLike): Promise<Ws[]> {
    return (await get(app, '/api/me/workspaces')).body.workspaces;
  }

  let carolDefault: Ws;
  let carolWork: Ws;

  test("parallel first requests create one default, kept under 'default'", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => get(carolApp, '/api/me/workspaces')));
    for (const r of results) expect(r.status).toBe(200);
    const all = await list(carolApp);
    expect(all.filter((w) => w.isDefault)).toHaveLength(1);
    carolDefault = all.find((w) => w.isDefault) as Ws;
    expect(carolDefault.filesDir).toBe('default');
    await write(carolId, carolDefault.id, 'note.txt', 'from default');
  });

  test('a new workspace keeps its files under its id', async () => {
    const r = await postJson(carolApp, '/api/me/workspaces', { slug: 'work', name: 'Work' });
    expect(r.status).toBe(201);
    carolWork = r.body;
    expect(carolWork.filesDir).toBe(carolWork.id);
    await write(carolId, carolWork.id, 'note.txt', 'from work');
  });

  test('POST /:id/default moves no file: each workspace still reads its own', async () => {
    const r = await postJson(carolApp, `/api/me/workspaces/${carolWork.id}/default`, {});
    expect(r.status).toBe(200);
    expect(r.body.isDefault).toBe(true);
    expect(await read(carolId, carolWork.id, 'note.txt')).toBe('from work');
    expect(await read(carolId, carolDefault.id, 'note.txt')).toBe('from default');
    // And back again.
    expect((await postJson(carolApp, `/api/me/workspaces/${carolDefault.id}/default`, {})).status).toBe(200);
    expect(await read(carolId, carolWork.id, 'note.txt')).toBe('from work');
    expect(await read(carolId, carolDefault.id, 'note.txt')).toBe('from default');
  });

  test('creating a workspace with isDefault gives it an empty root and leaves the others alone', async () => {
    const r = await postJson(carolApp, '/api/me/workspaces', { slug: 'fresh', name: 'Fresh', isDefault: true });
    expect(r.status).toBe(201);
    expect(r.body.isDefault).toBe(true);
    expect(await read(carolId, r.body.id, 'note.txt')).toBeNull();
    expect(await read(carolId, carolDefault.id, 'note.txt')).toBe('from default');
    expect(await read(carolId, carolWork.id, 'note.txt')).toBe('from work');
  });

  test("transfer moves the files into the recipient's tree, under the workspace id", async () => {
    // carolDefault (no longer the default) keeps its files under 'default';
    // dave already has a default workspace, and a `default` directory.
    const daveBefore = (await list(daveApp)).find((w) => w.isDefault) as Ws;
    expect(daveBefore.filesDir).toBe('default');
    await write(daveId, daveBefore.id, 'note.txt', 'dave own');
    const r = await postJson(carolApp, `/api/me/workspaces/${carolDefault.id}/transfer`, { recipientUserId: daveId });
    expect(r.status).toBe(200);
    expect(r.body.userId).toBe(daveId);
    expect(r.body.filesDir).toBe(carolDefault.id);
    expect(await rootOf(daveId, carolDefault.id)).toBe(join(dataRoot, 'users', daveId, 'workspaces', carolDefault.id, 'files'));
    expect(await read(daveId, carolDefault.id, 'note.txt')).toBe('from default');
    expect(existsSync(join(dataRoot, 'users', carolId, 'workspaces', 'default'))).toBe(false);
    // Dave's own default is untouched by the arrival.
    const daveDefault = (await list(daveApp)).find((w) => w.isDefault) as Ws;
    expect(daveDefault.id).toBe(daveBefore.id);
    expect(await read(daveId, daveDefault.id, 'note.txt')).toBe('dave own');
  });

  test('transfer onto an existing directory is refused (409) and changes nothing', async () => {
    mkdirSync(join(dataRoot, 'users', daveId, 'workspaces', carolWork.id), { recursive: true });
    const r = await postJson(carolApp, `/api/me/workspaces/${carolWork.id}/transfer`, { recipientUserId: daveId });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('files_conflict');
    const still = (await list(carolApp)).find((w) => w.id === carolWork.id) as Ws;
    expect(still.userId).toBe(carolId);
    expect(still.filesDir).toBe(carolWork.id);
    expect(await read(carolId, carolWork.id, 'note.txt')).toBe('from work');
  });

  test("DELETE removes the workspace's files", async () => {
    const dir = join(dataRoot, 'users', carolId, 'workspaces', carolWork.id);
    expect(existsSync(dir)).toBe(true);
    const r = await del(carolApp, `/api/me/workspaces/${carolWork.id}`);
    expect(r.status).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });
});
