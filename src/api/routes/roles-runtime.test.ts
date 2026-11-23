/**
 * An operator's runtime roles through the role routes (PGlite, the real
 * routes and registry): the whole definition (display name, spawn rules,
 * limits) persists and survives a reload; a built-in or reserved id, a tool no
 * built-in role holds and a bad spawn rule are refused, on create and on edit;
 * a plugin's role is listed but cannot be edited or deleted here; and a stored
 * row that no longer passes is skipped at load, not registered.
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

  test('an edit is held to the same rules, and spawn rules apply to runtime roles only', async () => {
    const { getToolRegistry } = await import('@/tools/registry');
    const stubbed = 'unheld_tool';
    await getToolRegistry().register({
      id: stubbed, name: stubbed, version: '1.0.0', initialize: async () => {}, shutdown: async () => {},
      checkAvailability: async () => ({ available: true }), getToolHandlers: () => [], getTool: () => undefined,
      getManifest: () => ({ id: stubbed, name: stubbed, version: '1.0.0', description: 'stub', tools: [] }),
    } as never);
    const widened = await call('PATCH', '/roles/translator', { toolIds: ['filesystem', stubbed] });
    expect(widened.status).toBe(400);
    expect(widened.body.error).toMatch(/no built-in role holds/);
    const { ROLE_CONFIGS } = await import('@/core/agent/roles');
    const { resolveRole } = await import('@/core/agent/role-registry');
    expect(ROLE_CONFIGS[resolveRole('translator')].toolIds).toEqual(['filesystem']);

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

  test('a stored row that no longer passes is skipped at load, not registered', async () => {
    const { getDb } = await import('@/db/postgres');
    const { roles } = await import('@/db/schema/roles');
    await getDb().insert(roles).values({ role: 'system', toolIds: ['filesystem'], defaultTopic: 'everyday', systemPromptTemplate: 'x', isSystem: false });
    const { loadRolesFromDb } = await import('@/db/seed-roles');
    await loadRolesFromDb();
    const { isRegisteredRole } = await import('@/core/agent/role-registry');
    expect(isRegisteredRole('system')).toBe(false);
  });

  test('deleted: the role is gone from the registry', async () => {
    expect((await call('DELETE', '/roles/translator')).status).toBe(200);
    const { isRegisteredRole } = await import('@/core/agent/role-registry');
    expect(isRegisteredRole('translator')).toBe(false);
  });
});
