import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { getDb } from '@/db/postgres';
import { orgMembers, organizations } from '@/db/schema/organizations';
import { users } from '@/db/schema/users';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
  truncateTables,
} from '@/test-helpers/integration';
import { getUserOrgIds } from './org-membership';

describe('getUserOrgIds — pure-input early returns', () => {
  test('empty userId → []', async () => {
    expect(await getUserOrgIds('')).toEqual([]);
  });

  test('"system" userId → []', async () => {
    // System principals have no org memberships and must short-
    // circuit before touching the DB.
    expect(await getUserOrgIds('system')).toEqual([]);
  });
});

describe.skipIf(!isIntegration)('getUserOrgIds (Integration)', () => {
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    await setupIntegrationDb();
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  beforeEach(async () => {
    await truncateTables(['org_members', 'organizations', 'users']);
    const db = getDb();
    const u = await db.insert(users).values({ username: `u_${randomUUID().slice(0, 8)}` }).returning();
    userId = u[0].id;
    const u2 = await db.insert(users).values({ username: `u_${randomUUID().slice(0, 8)}` }).returning();
    otherUserId = u2[0].id;
  });

  test('user with no memberships → []', async () => {
    expect(await getUserOrgIds(userId)).toEqual([]);
  });

  test('returns every org the user is a member of', async () => {
    const db = getDb();
    const orgA = (await db.insert(organizations).values({ slug: `a_${randomUUID().slice(0, 8)}`, name: 'A', createdBy: userId }).returning())[0];
    const orgB = (await db.insert(organizations).values({ slug: `b_${randomUUID().slice(0, 8)}`, name: 'B', createdBy: userId }).returning())[0];
    await db.insert(orgMembers).values([
      { orgId: orgA.id, userId, role: 'admin' },
      { orgId: orgB.id, userId, role: 'member' },
    ]);
    const ids = (await getUserOrgIds(userId)).sort();
    expect(ids).toEqual([orgA.id, orgB.id].sort());
  });

  test('returns nothing for an unrelated user', async () => {
    const db = getDb();
    const org = (await db.insert(organizations).values({ slug: `c_${randomUUID().slice(0, 8)}`, name: 'C', createdBy: userId }).returning())[0];
    await db.insert(orgMembers).values({ orgId: org.id, userId, role: 'admin' });
    expect(await getUserOrgIds(otherUserId)).toEqual([]);
  });
});
