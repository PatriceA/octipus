import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Elysia } from '@/api/http';
import { closeDb, getDb, initializeDb } from '@/db/postgres';
import { runMigrations } from '@/db/migrate';
import { skills } from '@/db/schema/skills';
import { skillTopicAssignments } from '@/db/schema/skill-topic-assignments';
import { orgMembers, organizations } from '@/db/schema/organizations';
import { seedUsers } from '@/test-helpers/multiuser-fixtures';
import { principalFromUser } from '@/security/principal';
import { skillRoutes } from './skills';
import { skillTopicAssignmentRoutes } from './skill-topic-assignments';

process.env.MASTER_KEY ??= `test-${randomUUID()}`;
process.env.JWT_SECRET ??= `test-${randomUUID()}`;
process.env.SESSION_SECRET ??= `test-${randomUUID()}`;
process.env.LOG_LEVEL = 'error';
process.env.STORAGE_MODE = 'embedded';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skills-access-'));

type TestUser = { id: string; username: string; isAdmin: boolean };
const admin: TestUser = { id: randomUUID(), username: 'admin', isAdmin: true };
const alice: TestUser = { id: randomUUID(), username: 'alice', isAdmin: false };
const bob: TestUser = { id: randomUUID(), username: 'bob', isAdmin: false };
let current: TestUser | null = alice;
let app: { handle(req: Request): Promise<Response> };

async function call(method: string, path: string, body?: unknown) {
  const response = await app.handle(new Request(`http://localhost/skills/${path}`, {
    method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }));
  return { status: response.status, body: await response.json() as any };
}

async function seedSkills() {
  const db = getDb();
  await db.delete(skillTopicAssignments);
  await db.delete(skills);
  await db.insert(skills).values([
    { id: 'sys', name: 'System skill', description: 'system original', isSystem: true },
    { id: 'alice-own', name: 'Alice skill', description: 'alice original', userId: alice.id },
    { id: 'bob-private', name: 'Bob secret', description: 'bob original', userId: bob.id },
    { id: 'org-shared', name: 'Org skill', description: 'org original', userId: bob.id, orgId },
  ]);
}

let orgId: string;

beforeAll(async () => {
  await initializeDb();
  await runMigrations();
  await seedUsers([admin, alice, bob]);
  const db = getDb();
  orgId = (await db.insert(organizations).values({ slug: `o_${randomUUID().slice(0, 8)}`, name: 'Org', createdBy: bob.id }).returning())[0].id;
  await db.insert(orgMembers).values([{ orgId, userId: alice.id }, { orgId, userId: bob.id }]);
  app = new Elysia()
    .derive(() => ({ user: current, principal: current ? principalFromUser(current) : { kind: 'anonymous' as const } }))
    .use(skillRoutes).use(skillTopicAssignmentRoutes);
}, 60000);

beforeEach(async () => { current = alice; await seedSkills(); });
afterAll(async () => { await closeDb(); });

const descriptionOf = async (id: string) =>
  (await getDb().select().from(skills).where(eq(skills.id, id)))[0]?.description;

test('reload-mounted is admin-only', async () => {
  expect((await call('POST', 'reload-mounted')).status).toBe(403);
  current = admin;
  expect((await call('POST', 'reload-mounted')).status).toBe(200);
});

test('export by ids returns only rows the caller may see', async () => {
  const ids = 'sys,alice-own,bob-private,org-shared';
  const names = async () => (await call('GET', `export?ids=${ids}`)).body.skills.map((s: any) => s.name).sort();
  expect(await names()).toEqual(['Alice skill', 'Org skill', 'System skill']);
  current = admin;
  expect(await names()).toEqual(['Alice skill', 'Bob secret', 'Org skill', 'System skill']);
  current = null;
  expect(await names()).toEqual(['System skill']);
});

test('single export hides skills the caller may not see', async () => {
  expect((await call('GET', 'bob-private/export')).status).toBe(404);
  expect((await call('GET', 'org-shared/export')).body).toMatchObject({ name: 'Org skill' });
  current = null;
  expect((await call('GET', 'bob-private/export')).status).toBe(404);
  expect((await call('GET', 'sys/export')).status).toBe(200);
  current = admin;
  expect((await call('GET', 'bob-private/export')).body).toMatchObject({ name: 'Bob secret' });
});

test('import with overwrite only overwrites the caller\'s own skills', async () => {
  const incoming = ['System skill', 'Alice skill', 'Bob secret', 'Org skill']
    .map(name => ({ name, description: 'imported' }));
  const { status, body } = await call('POST', 'import', { skills: incoming, overwrite: true });
  expect(status).toBe(200);
  expect(body.updated).toEqual(['alice-own']);
  expect(body.notOwned.sort()).toEqual(['Org skill', 'System skill']);
  expect(body.skipped.sort()).toEqual(['Org skill', 'System skill']);
  // Bob's private skill is invisible to Alice: no conflict, she gets her own copy.
  expect(body.created).toHaveLength(1);
  const [copy] = await getDb().select().from(skills).where(eq(skills.id, body.created[0]));
  expect(copy).toMatchObject({ name: 'Bob secret', userId: alice.id, isSystem: false });
  expect(await descriptionOf('alice-own')).toBe('imported');
  expect(await descriptionOf('sys')).toBe('system original');
  expect(await descriptionOf('bob-private')).toBe('bob original');
  expect(await descriptionOf('org-shared')).toBe('org original');
});

test('an admin import may overwrite any skill', async () => {
  current = admin;
  const { body } = await call('POST', 'import', { skills: [{ name: 'System skill', description: 'by admin' },
    { name: 'Bob secret', description: 'by admin' }], overwrite: true });
  expect(body.updated.sort()).toEqual(['bob-private', 'sys']);
  expect(await descriptionOf('sys')).toBe('by admin');
});

test('import requires a signed-in user', async () => {
  current = null;
  expect((await call('POST', 'import', { skills: [{ name: 'x', description: 'y' }] })).status).toBe(401);
});

test('topic assignment changes are admin-only', async () => {
  const [row] = await getDb().insert(skillTopicAssignments).values({ skillId: 'sys', topic: 'coding' }).returning();
  expect((await call('POST', 'topics', { skillId: 'alice-own', topic: 'coding' })).status).toBe(403);
  expect((await call('PATCH', `topics/${row.id}`, { isActive: false })).status).toBe(403);
  expect((await call('PATCH', 'topics/bulk/sys', { isActive: false })).status).toBe(403);
  expect((await call('DELETE', `topics/${row.id}`)).status).toBe(403);
  expect((await getDb().select().from(skillTopicAssignments))[0]).toMatchObject({ isActive: true });

  current = admin;
  const created = await call('POST', 'topics', { skillId: 'sys', topic: 'research' });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ skillId: 'sys', topic: 'research' });
  expect((await call('PATCH', `topics/${row.id}`, { isActive: false })).body).toMatchObject({ isActive: false });
  expect((await call('PATCH', 'topics/bulk/sys', { isActive: true })).body).toMatchObject({ updated: 2 });
  expect((await call('DELETE', `topics/${created.body.id}`)).body).toEqual({ deleted: true });
});

test('listing assignments requires login and hides skills the caller may not see', async () => {
  await getDb().insert(skillTopicAssignments).values([
    { skillId: 'sys', topic: 'coding' },
    { skillId: 'alice-own', topic: 'coding' },
    { skillId: 'bob-private', topic: 'coding' },
    { skillId: 'org-shared', topic: 'coding' },
  ]);
  const listed = async () => (await call('GET', 'topics')).body.assignments.map((a: any) => a.skillName).sort();
  expect(await listed()).toEqual(['Alice skill', 'Org skill', 'System skill']);
  current = admin;
  expect(await listed()).toEqual(['Alice skill', 'Bob secret', 'Org skill', 'System skill']);
  current = null;
  expect((await call('GET', 'topics')).status).toBe(401);
});
