/**
 * Phase 3g — OrgWorkspaceManager tests.
 *
 * Covers:
 *   - slug + name validation (rejects empties, oversize, illegal chars)
 *   - createOrg: admin-only + slug uniqueness + creator becomes org_admin
 *   - findBySlugForCaller: members see; non-members get null;
 *     admins always see
 *   - addMember / removeMember: admin-gated, idempotent on re-add
 *   - createWorkspace: per-user slug uniqueness (cross-user same slug ok)
 *   - ensureDefaultWorkspace: lazy create, idempotent, promotes existing
 *     `default` slug if present
 *   - findOwnedById / findOwnedBySlug: cross-tenant lookups collapse
 *     to null (no enumeration)
 *   - rename / setDefault / delete: cross-tenant safe; default cannot
 *     be deleted; setDefault clears the prior default atomically
 *
 * Backed by ephemeral PGlite — no Docker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const adminId = '11111111-1111-1111-1111-111111111111';
const aliceId = '22222222-2222-2222-2222-222222222222';
const bobId = '33333333-3333-3333-3333-333333333333';

const adminActor = { id: adminId, username: 'root', isAdmin: true };
const aliceActor = { id: aliceId, username: 'alice', isAdmin: false };
const bobActor = { id: bobId, username: 'bob', isAdmin: false };

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-orgs-'));

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
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('validation', () => {
  test('createOrg rejects invalid slug', async () => {
    const { getOrgWorkspaceManager, OrgWorkspaceError } = await import('@/security/orgs');
    await expect(
      getOrgWorkspaceManager().createOrg(adminActor, { slug: 'Has Spaces', name: 'X' }),
    ).rejects.toBeInstanceOf(OrgWorkspaceError);
    await expect(
      getOrgWorkspaceManager().createOrg(adminActor, { slug: 'UPPER', name: 'X' }),
    ).rejects.toBeInstanceOf(OrgWorkspaceError);
    await expect(
      getOrgWorkspaceManager().createOrg(adminActor, { slug: '', name: 'X' }),
    ).rejects.toBeInstanceOf(OrgWorkspaceError);
  });

  test('createOrg rejects empty name', async () => {
    const { getOrgWorkspaceManager, OrgWorkspaceError } = await import('@/security/orgs');
    await expect(
      getOrgWorkspaceManager().createOrg(adminActor, { slug: 'org-empty-name', name: '   ' }),
    ).rejects.toBeInstanceOf(OrgWorkspaceError);
  });

  test('createWorkspace rejects bad slug', async () => {
    const { getOrgWorkspaceManager, OrgWorkspaceError } = await import('@/security/orgs');
    await expect(
      getOrgWorkspaceManager().createWorkspace(aliceId, { slug: 'has space', name: 'X' }),
    ).rejects.toBeInstanceOf(OrgWorkspaceError);
  });
});

describe('createOrg', () => {
  test('rejects non-admin actors', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    await expect(
      getOrgWorkspaceManager().createOrg(aliceActor, { slug: 'unauthorized', name: 'X' }),
    ).rejects.toMatchObject({ code: 'not_admin' });
  });

  test('happy path: creates org + adds creator as org_admin member', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const org = await getOrgWorkspaceManager().createOrg(adminActor, {
      slug: 'acme',
      name: 'Acme',
    });
    expect(org.slug).toBe('acme');
    expect(org.name).toBe('Acme');

    const members = await getOrgWorkspaceManager().listMembers(adminActor, org.id);
    expect(members.find((m) => m.userId === adminId)?.role).toBe('org_admin');
  });

  test('rejects duplicate slug with slug_conflict', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    await expect(
      getOrgWorkspaceManager().createOrg(adminActor, { slug: 'acme', name: 'Acme 2' }),
    ).rejects.toMatchObject({ code: 'slug_conflict' });
  });
});

describe('membership', () => {
  test('addMember is admin-only', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const org = await getOrgWorkspaceManager().findBySlugForCaller(adminActor, 'acme');
    expect(org).not.toBeNull();
    await expect(
      getOrgWorkspaceManager().addMember(aliceActor, org!.id, bobId),
    ).rejects.toMatchObject({ code: 'not_admin' });
  });

  test('addMember idempotent', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const org = await getOrgWorkspaceManager().findBySlugForCaller(adminActor, 'acme');
    const m1 = await getOrgWorkspaceManager().addMember(adminActor, org!.id, aliceId);
    const m2 = await getOrgWorkspaceManager().addMember(adminActor, org!.id, aliceId);
    expect(m1.userId).toBe(aliceId);
    expect(m2.userId).toBe(aliceId);
    const members = await getOrgWorkspaceManager().listMembers(adminActor, org!.id);
    expect(members.filter((m) => m.userId === aliceId).length).toBe(1);
  });

  test('non-member cannot see members; member can; admin can', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const org = await getOrgWorkspaceManager().findBySlugForCaller(adminActor, 'acme');
    // Bob is not a member of 'acme'.
    expect(await getOrgWorkspaceManager().listMembers(bobActor, org!.id)).toEqual([]);
    // Alice is.
    const aliceView = await getOrgWorkspaceManager().listMembers(aliceActor, org!.id);
    expect(aliceView.length).toBeGreaterThan(0);
    // Admin always sees.
    const adminView = await getOrgWorkspaceManager().listMembers(adminActor, org!.id);
    expect(adminView.length).toBeGreaterThan(0);
  });

  test('findBySlugForCaller collapses to null for non-members', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const aliceView = await getOrgWorkspaceManager().findBySlugForCaller(aliceActor, 'acme');
    expect(aliceView).not.toBeNull();
    const bobView = await getOrgWorkspaceManager().findBySlugForCaller(bobActor, 'acme');
    expect(bobView).toBeNull();
    // Even an admin sees the row.
    const adminView = await getOrgWorkspaceManager().findBySlugForCaller(adminActor, 'acme');
    expect(adminView).not.toBeNull();
  });

  test('removeMember closes the membership', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const org = await getOrgWorkspaceManager().findBySlugForCaller(adminActor, 'acme');
    expect(await getOrgWorkspaceManager().removeMember(adminActor, org!.id, aliceId)).toBe(true);
    expect(await getOrgWorkspaceManager().removeMember(adminActor, org!.id, aliceId)).toBe(false);
  });
});

describe('workspaces — per-user CRUD', () => {
  test('createWorkspace + listOwn isolated per user', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const a = await getOrgWorkspaceManager().createWorkspace(aliceId, {
      slug: 'alice-ws-1',
      name: 'Alice WS 1',
    });
    const b = await getOrgWorkspaceManager().createWorkspace(bobId, {
      slug: 'alice-ws-1', // same slug, different user — must be allowed
      name: 'Bob WS 1',
    });
    expect(a.userId).toBe(aliceId);
    expect(b.userId).toBe(bobId);
    expect(a.slug).toBe(b.slug);

    const aliceList = await getOrgWorkspaceManager().listOwn(aliceId);
    expect(aliceList.find((w) => w.id === b.id)).toBeUndefined();
    expect(aliceList.find((w) => w.id === a.id)).toBeDefined();
  });

  test('per-user slug uniqueness rejected', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    await expect(
      getOrgWorkspaceManager().createWorkspace(aliceId, {
        slug: 'alice-ws-1',
        name: 'Dup',
      }),
    ).rejects.toMatchObject({ code: 'slug_conflict' });
  });

  test('ensureDefaultWorkspace is idempotent + lazy', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const w1 = await getOrgWorkspaceManager().ensureDefaultWorkspace(aliceId);
    const w2 = await getOrgWorkspaceManager().ensureDefaultWorkspace(aliceId);
    expect(w1.id).toBe(w2.id);
    expect(w1.isDefault).toBe(true);
    expect(w1.slug).toBe('default');
  });

  test('findOwnedById collapses cross-tenant to null', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const aliceWS = await getOrgWorkspaceManager().createWorkspace(aliceId, {
      slug: 'alice-private',
      name: 'Alice Private',
    });
    expect(await getOrgWorkspaceManager().findOwnedById(aliceId, aliceWS.id)).not.toBeNull();
    expect(await getOrgWorkspaceManager().findOwnedById(bobId, aliceWS.id)).toBeNull();
  });

  test('rename works on own; cross-tenant rename returns null', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const aliceWS = await getOrgWorkspaceManager().findOwnedBySlug(aliceId, 'alice-private');
    expect(aliceWS).not.toBeNull();
    const renamed = await getOrgWorkspaceManager().rename(aliceId, aliceWS!.id, 'Alice Renamed');
    expect(renamed?.name).toBe('Alice Renamed');
    expect(await getOrgWorkspaceManager().rename(bobId, aliceWS!.id, 'pwned')).toBeNull();
  });

  test('setDefault clears prior default', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const aliceWS = await getOrgWorkspaceManager().findOwnedBySlug(aliceId, 'alice-private');
    const promoted = await getOrgWorkspaceManager().setDefault(aliceId, aliceWS!.id);
    expect(promoted?.isDefault).toBe(true);

    const all = await getOrgWorkspaceManager().listOwn(aliceId);
    const defaults = all.filter((w) => w.isDefault);
    expect(defaults.length).toBe(1);
    expect(defaults[0].id).toBe(aliceWS!.id);
  });

  test('cannot delete default workspace', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const def = await getOrgWorkspaceManager().findOwnedBySlug(aliceId, 'alice-private');
    expect(def?.isDefault).toBe(true);
    await expect(
      getOrgWorkspaceManager().delete(aliceId, def!.id),
    ).rejects.toMatchObject({ code: 'cannot_delete_default' });
  });

  test('cross-tenant delete returns false', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const aliceWS = await getOrgWorkspaceManager().findOwnedBySlug(aliceId, 'alice-ws-1');
    expect(await getOrgWorkspaceManager().delete(bobId, aliceWS!.id)).toBe(false);
    // Confirm row still exists for alice.
    expect(await getOrgWorkspaceManager().findOwnedById(aliceId, aliceWS!.id)).not.toBeNull();
  });

  test('non-default delete works for owner', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const aliceWS = await getOrgWorkspaceManager().findOwnedBySlug(aliceId, 'alice-ws-1');
    expect(aliceWS?.isDefault).toBe(false);
    expect(await getOrgWorkspaceManager().delete(aliceId, aliceWS!.id)).toBe(true);
    expect(await getOrgWorkspaceManager().findOwnedById(aliceId, aliceWS!.id)).toBeNull();
  });
});
