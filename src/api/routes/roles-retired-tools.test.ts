/**
 * A role row that still names a removed built-in tool (`atlassian`, `gitlab`)
 * or a binding of the removed connector framework (`connector:<id>`, the
 * `connector` container).
 *
 * The seeder used to merge `atlassian` into every install's `pm` row, and an
 * operator could bind `connector:<id>` in the role editor, so the ids are in
 * existing databases. Against PGlite and the real role routes:
 *
 *   - the seeder drops it from an unedited system row;
 *   - an edited row keeps what the user saved, but the id is not loaded into
 *     the registry, not listed by GET /roles, and not refused by PATCH when
 *     the editor sends the stored list back.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
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

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-roles-retired-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: adminId, username: 'root', isAdmin: true }]);

  // A populated tool registry, so `unknownToolIds` really checks.
  const { getToolRegistry } = await import('@/tools/registry');
  const { filesystemTool } = await import('@/tools/filesystem');
  const { githubTool } = await import('@/tools/github');
  await getToolRegistry().register(filesystemTool);
  await getToolRegistry().register(githubTool);

  const { seedRoles } = await import('@/db/seed-roles');
  await seedRoles();

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

async function pmRow() {
  const { getDb } = await import('@/db/postgres');
  const { roles } = await import('@/db/schema/roles');
  return (await getDb().select().from(roles).where(eq(roles.role, 'pm')))[0]!;
}

async function setPm(values: Record<string, unknown>) {
  const { getDb } = await import('@/db/postgres');
  const { roles } = await import('@/db/schema/roles');
  await getDb().update(roles).set(values).where(eq(roles.role, 'pm'));
}

describe('a role row naming a removed tool', () => {
  test('the shipped pm role no longer names atlassian', async () => {
    const { ROLE_CONFIGS } = await import('@/core/agent/roles');
    expect(ROLE_CONFIGS.pm.toolIds).not.toContain('atlassian');
    expect(ROLE_CONFIGS.pm.toolIds).toContain('github');
  });

  test('the seeder drops it from an unedited system row', async () => {
    const stored = (await pmRow()).toolIds as string[];
    await setPm({ toolIds: [...stored, 'atlassian', 'gitlab'], customized: false });
    const { seedRoles } = await import('@/db/seed-roles');
    await seedRoles();
    const toolIds = (await pmRow()).toolIds as string[];
    expect(toolIds).toEqual(stored);
    expect(toolIds).not.toContain('atlassian');
    expect(toolIds).not.toContain('gitlab');
  });

  test('an edited row keeps it stored, but it is not loaded, listed, or refused on save', async () => {
    await setPm({ toolIds: ['filesystem', 'github', 'atlassian', 'gitlab'], coreToolIds: ['atlassian', 'github'], customized: true });
    const { loadRolesFromDb, seedRoles } = await import('@/db/seed-roles');
    await seedRoles();
    // An edit is the user's: the seeder leaves the row as saved.
    expect((await pmRow()).toolIds).toEqual(['filesystem', 'github', 'atlassian', 'gitlab']);

    await loadRolesFromDb();
    const { ROLE_CONFIGS, getToolsForRole, unknownToolIds } = await import('@/core/agent/roles');
    expect(ROLE_CONFIGS.pm.toolIds).toEqual(['filesystem', 'github']);
    expect(ROLE_CONFIGS.pm.coreToolIds).toEqual(['github']);
    expect(getToolsForRole('pm').map((h) => h.toolId)).not.toContain('atlassian');
    // The registry does not know them, so an unfiltered save would be refused.
    expect(unknownToolIds(['atlassian', 'gitlab'])).toEqual(['atlassian', 'gitlab']);

    const list = await call('GET', '/roles');
    const pm = list.body.roles.find((r: { role: string }) => r.role === 'pm');
    expect(pm.toolIds).toEqual(['filesystem', 'github']);
    expect(pm.coreToolIds).toEqual(['github']);

    const saved = await call('PATCH', '/roles/pm', { toolIds: ['filesystem', 'github', 'atlassian', 'gitlab'] });
    expect(saved.status).toBe(200);
    expect(saved.body.toolIds).toEqual(['filesystem', 'github']);
    expect(ROLE_CONFIGS.pm.toolIds).toEqual(['filesystem', 'github']);
    // A new role cannot name one.
    const created = await call('POST', '/roles', { role: 'tracker', toolIds: ['gitlab'], systemPromptTemplate: 'x' });
    expect(created.status).toBe(400);
  });

  test('a removed connector binding: dropped by the seeder, not loaded or listed, not refused on save', async () => {
    const { ROLE_CONFIGS, getToolsForRole } = await import('@/core/agent/roles');
    const { loadRolesFromDb, seedRoles } = await import('@/db/seed-roles');
    const stale = ['connector:linear', 'connector', 'connector_call_tool'];

    // Unedited: the seeder removes them from the row itself.
    await setPm({ toolIds: ['filesystem', 'github', ...stale], customized: false });
    await seedRoles();
    for (const id of stale) expect((await pmRow()).toolIds as string[]).not.toContain(id);

    // Edited: kept as saved, ignored everywhere it is read.
    await setPm({ toolIds: ['filesystem', 'github', ...stale], coreToolIds: ['connector', 'github'], customized: true });
    await loadRolesFromDb();
    expect(ROLE_CONFIGS.pm.toolIds).toEqual(['filesystem', 'github']);
    expect(ROLE_CONFIGS.pm.coreToolIds).toEqual(['github']);
    expect(getToolsForRole('pm').map((h) => h.toolId)).not.toContain('connector');

    const list = await call('GET', '/roles');
    const pm = list.body.roles.find((r: { role: string }) => r.role === 'pm');
    expect(pm.toolIds).toEqual(['filesystem', 'github']);
    expect(pm.coreToolIds).toEqual(['github']);

    const saved = await call('PATCH', '/roles/pm', { toolIds: ['filesystem', ...stale] });
    expect(saved.status).toBe(200);
    expect(saved.body.toolIds).toEqual(['filesystem']);
    // A role of nothing but stale bindings has no tools: refused, as any empty list.
    const empty = await call('PATCH', '/roles/pm', { toolIds: stale });
    expect(empty.status).toBe(400);
    expect(ROLE_CONFIGS.pm.toolIds).toEqual(['filesystem']);
  });
});
