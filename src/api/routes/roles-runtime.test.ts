/**
 * An operator's runtime roles through the role routes (PGlite, the real
 * routes and registry): the whole definition (display name, spawn rules,
 * limits) persists and survives a reload; a built-in id, a reserved or lane
 * NEW id and a bad spawn rule are refused; a stored row keeps loading under
 * rules it predates, and one that cannot load is listed with why, repairable
 * and deletable; boot order does not decide what loads; a failed edit never
 * leaves the registry holding what the table does not; a plugin's role is
 * read-only here; stored recipes naming a lane keep running as general.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };
const adminId = randomUUID();
let app: ElysiaLike;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await app.handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

const NEW_ROLE = {
  role: 'translator',
  displayName: 'Translator',
  description: 'translate documents between languages',
  toolIds: ['filesystem'],
  defaultTopic: 'everyday',
  systemPromptTemplate: 'You translate documents.',
  spawns: ['research'],
  spawnedBy: ['general'],
  limits: { maxTokens: 30_000 },
};

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-roles-runtime-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: adminId, username: 'root', isAdmin: true }]);
  const { getToolRegistry } = await import('@/tools/registry');
  const { filesystemTool } = await import('@/tools/filesystem');
  await getToolRegistry().register(filesystemTool);
  const { seedRoles, loadRolesFromDb } = await import('@/db/seed-roles');
  await seedRoles();
  await loadRolesFromDb();

  const { Elysia } = await import('@/api/http');
  const { principalFromUser } = await import('@/security/principal');
  const { roleRoutes } = await import('./roles');
  const user = { id: adminId, username: 'root', isAdmin: true };
  app = new Elysia()
    .derive(() => ({ user, session: null, principal: principalFromUser(user) }))
    .group('/api', (a) => a.use(roleRoutes)) as unknown as ElysiaLike;
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('operator runtime roles', () => {
  test('created with spawn rules and limits; registered as the operator\'s, listed, and reloaded the same', async () => {
    const created = await call('POST', '/roles', NEW_ROLE);
    expect(created.status).toBe(200);
    const { ROLE_CONFIGS } = await import('@/core/agent/roles');
    const { resolveRole, roleSource, spawnRefusal } = await import('@/core/agent/role-registry');
    const role = resolveRole('translator');
    expect(roleSource(role)).toEqual({ kind: 'admin' });
    expect(ROLE_CONFIGS[role]).toMatchObject({ displayName: 'Translator', spawns: ['research'], spawnedBy: ['general'], limits: { maxTokens: 30_000 } });
    expect(spawnRefusal('coding', role)).toBe("role 'translator' may be spawned only by general");

    const list = await call('GET', '/roles');
    expect(list.body.roles.find((r: { role: string }) => r.role === 'translator')).toMatchObject({
      source: 'admin', plugin: null, displayName: 'Translator', spawns: ['research'], spawnedBy: ['general'], limits: { maxTokens: 30_000 }, isSystem: false,
    });

    const { unregisterRuntimeRole } = await import('@/core/agent/role-registry');
    unregisterRuntimeRole('translator', { kind: 'admin' });
    const { loadRolesFromDb } = await import('@/db/seed-roles');
    await loadRolesFromDb();
    expect(ROLE_CONFIGS[resolveRole('translator')]).toMatchObject({ spawns: ['research'], limits: { maxTokens: 30_000 } });
  });

  test('a built-in or reserved id, a tool no built-in role holds, a bad spawn rule or limit are refused', async () => {
    expect((await call('POST', '/roles', { ...NEW_ROLE, role: 'coding' })).status).toBe(409);
    const reserved = await call('POST', '/roles', { ...NEW_ROLE, role: 'root' });
    expect(reserved.status).toBe(400);
    expect(reserved.body.problems).toContain("role id 'root' is reserved");
    expect((await call('POST', '/roles', { ...NEW_ROLE, role: 'bad-rule', spawns: ['Not A Role'] })).status).toBe(400);
    expect((await call('POST', '/roles', { ...NEW_ROLE, role: 'bad-limit', limits: { maxTokens: 1 } })).status).toBe(400);
    const { isRegisteredRole } = await import('@/core/agent/role-registry');
    expect(['bad-rule', 'bad-limit', 'root'].some(isRegisteredRole)).toBe(false);
    // Nothing reached the table either.
    const list = await call('GET', '/roles');
    expect(list.body.roles.map((r: { role: string }) => r.role)).not.toContain('bad-rule');
  });

  test('a lane name is refused as a new id', async () => {
    const r = await call('POST', '/roles', { ...NEW_ROLE, role: 'everyday' });
    expect(r.status).toBe(400);
    expect(r.body.problems).toContain("role id 'everyday' is the name of a model lane");
  });

  test('an edit is held to the same rules, and spawn rules apply to runtime roles only', async () => {
    expect((await call('PATCH', '/roles/translator', { spawns: ['Not A Role'] })).status).toBe(400);
    const { ROLE_CONFIGS } = await import('@/core/agent/roles');
    const { resolveRole } = await import('@/core/agent/role-registry');
    expect(ROLE_CONFIGS[resolveRole('translator')].spawns).toEqual(['research']);

    const cleared = await call('PATCH', '/roles/translator', { spawnedBy: null, limits: null });
    expect(cleared.status).toBe(200);
    expect(ROLE_CONFIGS[resolveRole('translator')].spawnedBy).toBeUndefined();
    expect(ROLE_CONFIGS[resolveRole('translator')].limits).toBeUndefined();

    expect((await call('PATCH', '/roles/coding', { spawns: [] })).status).toBe(400);
  });

  test('a plugin\'s role is listed, read-only here', async () => {
    const { registerRuntimeRole, unregisterRuntimeRole } = await import('@/core/agent/role-registry');
    registerRuntimeRole({ id: 'plugged', description: 'from a plugin', systemPrompt: 'x', toolIds: ['filesystem'], lane: 'everyday' }, { kind: 'plugin', plugin: 'acme' });
    try {
      const list = await call('GET', '/roles');
      expect(list.body.roles.find((r: { role: string }) => r.role === 'plugged')).toMatchObject({ source: 'plugin', plugin: 'acme', isSystem: false });
      expect((await call('PATCH', '/roles/plugged', { description: 'mine now' })).status).toBe(409);
      expect((await call('DELETE', '/roles/plugged')).status).toBe(409);
      const taken = await call('POST', '/roles', { ...NEW_ROLE, role: 'plugged' });
      expect(taken.status).toBe(409);
      expect(taken.body.error).toContain('the plugin package acme');
    } finally {
      unregisterRuntimeRole('plugged', { kind: 'plugin', plugin: 'acme' });
    }
  });

  test('stored rows that predate the rules keep loading: a now-reserved id, a tool no built-in role holds', async () => {
    const { getToolRegistry } = await import('@/tools/registry');
    for (const id of ['plan', 'inline-ui']) {
      await getToolRegistry().register({
        id, name: id, version: '1.0.0', initialize: async () => {}, shutdown: async () => {},
        checkAvailability: async () => ({ available: true }), getToolHandlers: () => [], getTool: () => undefined,
        getManifest: () => ({ id, name: id, version: '1.0.0', description: 'stub', tools: [] }),
      } as never);
    }
    const { getDb } = await import('@/db/postgres');
    const { roles } = await import('@/db/schema/roles');
    await getDb().insert(roles).values([
      { role: 'agent', toolIds: ['filesystem'], defaultTopic: 'everyday', systemPromptTemplate: 'x', isSystem: false },
      { role: 'planner-old', toolIds: ['plan', 'inline-ui'], defaultTopic: 'everyday', systemPromptTemplate: 'x', isSystem: false },
    ]);
    const { loadRolesFromDb } = await import('@/db/seed-roles');
    await loadRolesFromDb();
    const { isRegisteredRole } = await import('@/core/agent/role-registry');
    expect(isRegisteredRole('agent')).toBe(true);
    expect(isRegisteredRole('planner-old')).toBe(true);
    // And they stay editable.
    expect((await call('PATCH', '/roles/agent', { description: 'still here' })).status).toBe(200);
  });

  test('boot order does not decide what loads: built-in rows first, then operator rows', async () => {
    // An operator role on a tool only an EDITED built-in holds, its row
    // stored before the built-in's: the reviewer's reproduction.
    const { getDb } = await import('@/db/postgres');
    const { roles } = await import('@/db/schema/roles');
    const { eq } = await import('drizzle-orm');
    expect((await call('POST', '/roles', { ...NEW_ROLE, role: 'order-probe', toolIds: ['filesystem'], spawns: undefined, spawnedBy: undefined })).status).toBe(200);
    expect((await call('PATCH', '/roles/writing', { toolIds: ['filesystem', 'plan'] })).status).toBe(200);
    expect((await call('PATCH', '/roles/order-probe', { toolIds: ['filesystem', 'plan'] })).status).toBe(200);
    // Rewrite the built-in row last, so it sits after the operator row in the heap.
    const [writing] = await getDb().select().from(roles).where(eq(roles.role, 'writing'));
    await getDb().delete(roles).where(eq(roles.role, 'writing'));
    await getDb().insert(roles).values(writing);
    const { unregisterRuntimeRole, isRegisteredRole, ROLE_CONFIGS } = await import('@/core/agent/role-registry');
    unregisterRuntimeRole('order-probe', { kind: 'admin' });
    const { loadRolesFromDb } = await import('@/db/seed-roles');
    await loadRolesFromDb();
    expect(isRegisteredRole('order-probe')).toBe(true);
    expect(ROLE_CONFIGS.writing.toolIds).toEqual(['filesystem', 'plan']);
  });

  test('a stored row that cannot load is listed with why, cannot be re-created over, and is repaired by an edit or deleted', async () => {
    const { getDb } = await import('@/db/postgres');
    const { roles } = await import('@/db/schema/roles');
    await getDb().insert(roles).values({ role: 'broken-lane', toolIds: ['filesystem'], defaultTopic: 'embedding', systemPromptTemplate: 'x', isSystem: false });
    const { loadRolesFromDb } = await import('@/db/seed-roles');
    await loadRolesFromDb();
    const { isRegisteredRole } = await import('@/core/agent/role-registry');
    expect(isRegisteredRole('broken-lane')).toBe(false);

    const listed = (await call('GET', '/roles')).body.roles.find((r: { role: string }) => r.role === 'broken-lane');
    expect(listed).toMatchObject({ loaded: false, source: 'admin', problems: ["lane must resolve to a text lane (got 'embedding')"] });
    // Not a unique-constraint 500.
    const again = await call('POST', '/roles', { ...NEW_ROLE, role: 'broken-lane', spawns: undefined, spawnedBy: undefined });
    expect(again.status).toBe(409);

    expect((await call('PATCH', '/roles/broken-lane', { defaultTopic: 'everyday' })).status).toBe(200);
    expect(isRegisteredRole('broken-lane')).toBe(true);
    expect((await call('GET', '/roles')).body.roles.find((r: { role: string }) => r.role === 'broken-lane')).toMatchObject({ loaded: true, problems: [] });
    expect((await call('DELETE', '/roles/broken-lane')).status).toBe(200);
    expect(isRegisteredRole('broken-lane')).toBe(false);
  });

  test('a failed edit whose rollback is refused leaves the role out of the registry, listed as not loaded', async () => {
    const { getDb, executeRaw } = await import('@/db/postgres');
    const { roles } = await import('@/db/schema/roles');
    await getDb().insert(roles).values({ role: 'rollback-probe', toolIds: ['filesystem'], defaultTopic: 'embedding', systemPromptTemplate: 'x', isSystem: false });
    const { loadRolesFromDb } = await import('@/db/seed-roles');
    await loadRolesFromDb();
    // The table refuses the write after the registry took the edit; the
    // stored definition (lane `embedding`) cannot be put back either.
    await executeRaw(`CREATE FUNCTION refuse_rollback_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role = 'rollback-probe' THEN RAISE EXCEPTION 'write refused'; END IF; RETURN NEW; END $$`);
    await executeRaw(`CREATE TRIGGER refuse_rollback_probe BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION refuse_rollback_probe()`);
    try {
      const r = await call('PATCH', '/roles/rollback-probe', { defaultTopic: 'everyday' });
      expect(r.status).toBe(500);
    } finally {
      await executeRaw('DROP TRIGGER refuse_rollback_probe ON roles');
      await executeRaw('DROP FUNCTION refuse_rollback_probe');
    }
    const { isRegisteredRole, unloadedRoleProblems } = await import('@/core/agent/role-registry');
    expect(isRegisteredRole('rollback-probe')).toBe(false);
    expect(unloadedRoleProblems('rollback-probe')).toEqual(["lane must resolve to a text lane (got 'embedding')"]);
    expect((await call('DELETE', '/roles/rollback-probe')).status).toBe(200);
  });

  test('a stored recipe whose step names a lane runs as general, as before; a new one is refused it', async () => {
    const { stageRoleOf, recipeStepRoleErrors, buildStagesFromTemplate, stepConfigToStageTemplate } = await import('@/core/agent/templates');
    expect(stageRoleOf('everyday')).toBe('general');
    expect(stageRoleOf('build')).toBe('general');
    expect(stageRoleOf('coding')).toBe('coding');
    expect(stageRoleOf(undefined)).toBe('general');
    // A role that is gone is not a lane: it keeps its name and fails by it.
    expect(stageRoleOf('gone-role')).toBe('gone-role');
    const stage = stepConfigToStageTemplate({ name: 'Draft', topic: 'everyday', requiresApproval: false } as never);
    expect(() => buildStagesFromTemplate({ stages: [stage] } as never, 'x')).not.toThrow();
    expect(recipeStepRoleErrors([
      { name: 'a', topic: 'everyday' }, { name: 'b', topic: 'gone-role' }, { name: 'c', topic: 'coding' }, { name: 'd', topic: '', stageType: 'human_input' },
    ] as never)).toEqual([
      "Stage 1: 'everyday' is a model lane, not a role; pick the role that does this step.",
      "Stage 2: 'gone-role' is not a registered role.",
    ]);
  });

  test('deleted: the role is gone from the registry', async () => {
    expect((await call('DELETE', '/roles/translator')).status).toBe(200);
    const { isRegisteredRole } = await import('@/core/agent/role-registry');
    expect(isRegisteredRole('translator')).toBe(false);
  });
});
