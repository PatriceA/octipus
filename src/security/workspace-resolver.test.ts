/**
 * Phase 4 — workspace-resolver tests.
 *
 * Verifies that:
 *   - flag off → workspaceId always null
 *   - flag on, no header → user gets their default workspace lazily
 *   - flag on, header is "all" / "default" → default workspace
 *   - flag on, header is owned UUID → that workspace
 *   - flag on, header is cross-tenant UUID → collapses to default
 *   - flag on, header is owned slug → that workspace
 *   - flag on, header is unknown slug → collapses to default
 *   - anonymous principal → workspaceId null even when flag is on
 *
 * Backed by ephemeral PGlite — no Docker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

let aliceDefaultId: string;
let aliceProjectXId: string;
let bobDefaultId: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-wsres-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);

  const { _resetOrgWorkspaceManagerForTests, getOrgWorkspaceManager } = await import('@/security/orgs');
  _resetOrgWorkspaceManagerForTests();
  const mgr = getOrgWorkspaceManager();
  aliceDefaultId = (await mgr.ensureDefaultWorkspace(aliceId)).id;
  bobDefaultId = (await mgr.ensureDefaultWorkspace(bobId)).id;
  aliceProjectXId = (await mgr.createWorkspace(aliceId, { slug: 'project-x', name: 'Project X' })).id;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  const { getConfig } = await import('@/config');
  getConfig().multiuser.orgWorkspaces = false;
});

const alicePrincipal = {
  kind: 'user' as const,
  userId: aliceId,
  username: 'alice',
  isAdmin: false,
};
const bobPrincipal = {
  kind: 'user' as const,
  userId: bobId,
  username: 'bob',
  isAdmin: false,
};
const anonPrincipal = {
  kind: 'anonymous' as const,
  userId: 'anonymous',
  username: 'anonymous',
  isAdmin: false,
};

describe('flag-off behavior', () => {
  test('flag off → real user gets default workspace, header ignored', async () => {
    const { resolveWorkspace } = await import('@/security/workspace-resolver');
    const r1 = await resolveWorkspace(alicePrincipal, null);
    expect(r1.workspaceId).toBe(aliceDefaultId);
    expect(r1.isDefault).toBe(true);
    // Header is ignored when switching is disabled — still default.
    expect((await resolveWorkspace(alicePrincipal, aliceProjectXId)).workspaceId).toBe(aliceDefaultId);
    expect((await resolveWorkspace(alicePrincipal, 'project-x')).workspaceId).toBe(aliceDefaultId);
  });

  test('flag off → anonymous still gets workspaceId null', async () => {
    const { resolveWorkspace } = await import('@/security/workspace-resolver');
    expect((await resolveWorkspace(anonPrincipal, null)).workspaceId).toBeNull();
  });
});

describe('flag-on resolution', () => {
  beforeEach(async () => {
    const { getConfig } = await import('@/config');
    getConfig().multiuser.orgWorkspaces = true;
  });

  test('no header → default workspace', async () => {
    const { resolveWorkspace } = await import('@/security/workspace-resolver');
    const r = await resolveWorkspace(alicePrincipal, null);
    expect(r.workspaceId).toBe(aliceDefaultId);
    expect(r.isDefault).toBe(true);
  });

  test('header "all" or "default" → default workspace', async () => {
    const { resolveWorkspace } = await import('@/security/workspace-resolver');
    expect((await resolveWorkspace(alicePrincipal, 'all')).workspaceId).toBe(aliceDefaultId);
    expect((await resolveWorkspace(alicePrincipal, 'default')).workspaceId).toBe(aliceDefaultId);
  });

  test('owned uuid → that workspace', async () => {
    const { resolveWorkspace } = await import('@/security/workspace-resolver');
    const r = await resolveWorkspace(alicePrincipal, aliceProjectXId);
    expect(r.workspaceId).toBe(aliceProjectXId);
    expect(r.isDefault).toBe(false);
  });

  test('cross-tenant uuid → collapses to default', async () => {
    const { resolveWorkspace } = await import('@/security/workspace-resolver');
    // Bob hands Alice's workspace UUID — should be ignored.
    const r = await resolveWorkspace(bobPrincipal, aliceProjectXId);
    expect(r.workspaceId).toBe(bobDefaultId);
    expect(r.isDefault).toBe(true);
  });

  test('owned slug → that workspace', async () => {
    const { resolveWorkspace } = await import('@/security/workspace-resolver');
    const r = await resolveWorkspace(alicePrincipal, 'project-x');
    expect(r.workspaceId).toBe(aliceProjectXId);
  });

  test('unknown slug → collapses to default', async () => {
    const { resolveWorkspace } = await import('@/security/workspace-resolver');
    const r = await resolveWorkspace(alicePrincipal, 'nonexistent-slug');
    expect(r.workspaceId).toBe(aliceDefaultId);
    expect(r.isDefault).toBe(true);
  });

  test('cross-tenant slug → collapses to caller default (not bob\'s)', async () => {
    const { resolveWorkspace } = await import('@/security/workspace-resolver');
    // Alice's slug "project-x" doesn't exist for bob.
    const r = await resolveWorkspace(bobPrincipal, 'project-x');
    expect(r.workspaceId).toBe(bobDefaultId);
  });

  test('anonymous principal → workspaceId null', async () => {
    const { resolveWorkspace } = await import('@/security/workspace-resolver');
    const r = await resolveWorkspace(anonPrincipal, 'project-x');
    expect(r.workspaceId).toBeNull();
  });
});
