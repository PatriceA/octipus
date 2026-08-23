import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'crypto';
import { Elysia } from '@/api/http';
import { isIntegration, setupIntegrationDb, teardownIntegration, truncateTables } from '@/test-helpers/integration';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

// DB-backed: run via `bun run test:integration -- src/api/routes/roles.test.ts`.
describe.skipIf(!isIntegration)('Roles API (Integration)', () => {
  let adminApp: ElysiaLike;
  let userApp: ElysiaLike;
  const adminId = randomUUID();
  const userId = randomUUID();
  // ROLE_CONFIGS is a process-global singleton. `loadRolesFromDb()` below
  // replaces each entry with the DB row (which carries no lite prompt variant
  // and DB-sourced toolIds), so without restoring it this suite would leak the
  // mutated config into unit suites that assert the file-registry defaults
  // (e.g. core/orchestrator/roles.test.ts). Snapshot the original entries and
  // restore them in afterAll.
  let roleConfigsBackup: Record<string, unknown> | null = null;

  beforeAll(async () => {
    await setupIntegrationDb();
    await truncateTables(['roles', 'users']);

    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([
      { id: adminId, username: 'root', isAdmin: true },
      { id: userId, username: 'alice', isAdmin: false },
    ]);

    // Seed roles from the file registry into the DB + in-memory cache.
    const { seedRoles, loadRolesFromDb } = await import('@/db/seed-roles');
    const { ROLE_CONFIGS } = await import('@/core/orchestrator/roles');
    // Snapshot before mutating: loadRolesFromDb() replaces whole entries, so a
    // shallow copy of the original per-role objects is enough to restore.
    roleConfigsBackup = { ...ROLE_CONFIGS };
    await seedRoles();
    await loadRolesFromDb();

    const { roleRoutes } = await import('./roles');
    const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');

    const buildApp = (uid: string | null, isAdmin: boolean): ElysiaLike =>
      new Elysia()
        .derive(() => {
          if (!uid) return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL };
          const u = { id: uid, username: uid === adminId ? 'root' : 'alice', isAdmin };
          return { user: u, session: null, principal: principalFromUser(u) };
        })
        .group('/api', (a) => a.use(roleRoutes)) as unknown as ElysiaLike;

    adminApp = buildApp(adminId, true);
    userApp = buildApp(userId, false);
  });

  afterAll(async () => {
    // Restore the in-memory role registry so this suite's DB-sourced configs
    // don't leak into later unit suites.
    if (roleConfigsBackup) {
      const { ROLE_CONFIGS } = await import('@/core/orchestrator/roles');
      for (const key of Object.keys(roleConfigsBackup)) {
        (ROLE_CONFIGS as Record<string, unknown>)[key] = roleConfigsBackup[key];
      }
    }
    await teardownIntegration();
  });

  async function patchJson(app: ElysiaLike, path: string, body: unknown) {
    const res = await app.handle(new Request(`http://localhost${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function get(app: ElysiaLike, path: string) {
    const res = await app.handle(new Request(`http://localhost${path}`));
    return { status: res.status, body: await res.json() };
  }

  test('non-admin cannot PATCH a role', async () => {
    const r = await patchJson(userApp, '/api/roles/general', { toolIds: ['filesystem'] });
    expect(r.status).toBe(403);
  });

  test('admin PATCH updates toolIds, marks customized, and GET reflects it', async () => {
    const r = await patchJson(adminApp, '/api/roles/general', { toolIds: ['filesystem', 'shell'] });
    expect(r.status).toBe(200);
    expect(r.body.toolIds).toEqual(['filesystem', 'shell']);
    expect(r.body.customized).toBe(true);

    const list = await get(adminApp, '/api/roles');
    const general = list.body.roles.find((x: any) => x.role === 'general');
    expect(general.toolIds).toEqual(['filesystem', 'shell']);
    expect(general.customized).toBe(true);
  });

  test('admin PATCH dedupes + trims toolIds', async () => {
    const r = await patchJson(adminApp, '/api/roles/general', { toolIds: ['filesystem', ' filesystem ', 'shell', ''] });
    expect(r.status).toBe(200);
    expect(r.body.toolIds).toEqual(['filesystem', 'shell']);
  });

  test('PATCH updates the in-memory ROLE_CONFIGS (spawn-time read point)', async () => {
    await patchJson(adminApp, '/api/roles/general', { toolIds: ['git'] });
    const { ROLE_CONFIGS } = await import('@/core/orchestrator/roles');
    expect(ROLE_CONFIGS.general.toolIds).toEqual(['git']);
  });

  test('PATCH unknown role → 404', async () => {
    const r = await patchJson(adminApp, '/api/roles/does-not-exist', { toolIds: [] });
    expect(r.status).toBe(404);
  });

  test('PATCH with a non-array body is rejected (422)', async () => {
    const r = await patchJson(adminApp, '/api/roles/general', { toolIds: 'filesystem' });
    expect(r.status).toBe(422);
  });

  test('customized role survives a re-seed (user removal not re-added)', async () => {
    // Customize general to a single tool, then re-seed from code.
    await patchJson(adminApp, '/api/roles/general', { toolIds: ['filesystem'] });
    const { seedRoles } = await import('@/db/seed-roles');
    await seedRoles();
    const list = await get(adminApp, '/api/roles');
    const general = list.body.roles.find((x: any) => x.role === 'general');
    // Code config has many more tools; the customized row must NOT have them re-merged.
    expect(general.toolIds).toEqual(['filesystem']);
  });
});
