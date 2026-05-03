/**
 * Phase 4 — workspace-scoped repository tests.
 *
 * Verifies that:
 *   - Without a workspace context (principal.workspaceId undefined),
 *     scoped repos behave as Phase 1a — see all of the user's rows.
 *   - With a workspace context, the repos:
 *     * see rows that match workspace_id
 *     * see rows with NULL workspace_id (user-level fallback)
 *     * DO NOT see rows from a sibling workspace
 *   - `create` stamps the principal's workspaceId on new rows.
 *   - Caller-supplied workspaceId on `create` wins over the
 *     principal's (admin override path).
 *   - `findById` / `update` / `delete` cross-workspace lookups
 *     collapse to null/false (same enumeration-collapse as Phase 1a).
 *
 * Backed by ephemeral PGlite — no Docker. RLS doesn't fire under
 * PGlite's single-superuser mode, so the scoped repos' application-
 * layer filtering is what the test exercises.
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

const aliceId = '11111111-1111-1111-1111-111111111111';

let aliceDefaultId: string;
let aliceProjectXId: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-wsscoped-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: aliceId, username: 'alice' }]);

  const { _resetOrgWorkspaceManagerForTests, getOrgWorkspaceManager } = await import('@/security/orgs');
  _resetOrgWorkspaceManagerForTests();
  const mgr = getOrgWorkspaceManager();
  aliceDefaultId = (await mgr.ensureDefaultWorkspace(aliceId)).id;
  aliceProjectXId = (await mgr.createWorkspace(aliceId, { slug: 'project-x', name: 'Project X' })).id;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

interface UserPrincipalOpts {
  workspaceId?: string;
}
function principal(opts: UserPrincipalOpts = {}) {
  return {
    kind: 'user' as const,
    userId: aliceId,
    username: 'alice',
    isAdmin: false,
    ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
  };
}

describe('sessions — workspace scoping', () => {
  test('no workspace context → sees all of user\'s sessions', async () => {
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const repo = scopedRepos(principal()).sessions;
    // Seed: one session in default ws, one in project-x, one with NULL workspace_id.
    const a = await repo.create({ channelType: 'webchat', channelId: 'a', workspaceId: aliceDefaultId });
    const b = await repo.create({ channelType: 'webchat', channelId: 'b', workspaceId: aliceProjectXId });
    const c = await repo.create({ channelType: 'webchat', channelId: 'c' });
    expect(a.workspaceId).toBe(aliceDefaultId);
    expect(b.workspaceId).toBe(aliceProjectXId);
    expect(c.workspaceId).toBeNull();

    // No workspace context: list returns all.
    const list = await repo.listOwn();
    const ids = list.map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
  });

  test('workspace context → sees only matching + NULL', async () => {
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const defaultRepo = scopedRepos(principal({ workspaceId: aliceDefaultId })).sessions;

    const list = await defaultRepo.listOwn();
    const channels = list.map((s) => s.channelId);
    expect(channels).toContain('a'); // default workspace
    expect(channels).toContain('c'); // NULL workspace_id (user-level)
    expect(channels).not.toContain('b'); // project-x workspace
  });

  test('create with workspace context stamps the principal\'s workspaceId', async () => {
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const projectRepo = scopedRepos(principal({ workspaceId: aliceProjectXId })).sessions;
    const created = await projectRepo.create({ channelType: 'webchat', channelId: 'd' });
    expect(created.workspaceId).toBe(aliceProjectXId);
  });

  test('caller-supplied workspaceId on create wins', async () => {
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const repo = scopedRepos(principal({ workspaceId: aliceDefaultId })).sessions;
    const override = await repo.create({
      channelType: 'webchat',
      channelId: 'e',
      workspaceId: aliceProjectXId, // explicit override
    });
    expect(override.workspaceId).toBe(aliceProjectXId);
  });

  test('cross-workspace findById collapses to null', async () => {
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const projectRepo = scopedRepos(principal({ workspaceId: aliceProjectXId })).sessions;
    const all = await projectRepo.listOwn();
    expect(all.find((s) => s.channelId === 'a')).toBeUndefined();
    // Look up the default-workspace session by id from the project context.
    const defRepo = scopedRepos(principal({ workspaceId: aliceDefaultId })).sessions;
    const defaultSession = (await defRepo.listOwn()).find((s) => s.channelId === 'a');
    expect(defaultSession).toBeDefined();
    expect(await projectRepo.findById(defaultSession!.id)).toBeNull();
  });

  test('cross-workspace update returns null', async () => {
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const defRepo = scopedRepos(principal({ workspaceId: aliceDefaultId })).sessions;
    const defaultSession = (await defRepo.listOwn()).find((s) => s.channelId === 'a');
    expect(defaultSession).toBeDefined();
    const projectRepo = scopedRepos(principal({ workspaceId: aliceProjectXId })).sessions;
    const r = await projectRepo.update(defaultSession!.id, { title: 'hijack' });
    expect(r).toBeNull();
  });

  test('cross-workspace delete returns false', async () => {
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const defRepo = scopedRepos(principal({ workspaceId: aliceDefaultId })).sessions;
    const defaultSession = (await defRepo.listOwn()).find((s) => s.channelId === 'a');
    const projectRepo = scopedRepos(principal({ workspaceId: aliceProjectXId })).sessions;
    expect(await projectRepo.delete(defaultSession!.id)).toBe(false);
    // Confirm the session still exists for the default-workspace caller.
    expect(await defRepo.findById(defaultSession!.id)).not.toBeNull();
  });
});

describe('documents — workspace scoping', () => {
  test('list isolated by workspace; create stamps id', async () => {
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const defRepo = scopedRepos(principal({ workspaceId: aliceDefaultId })).documents;
    const projectRepo = scopedRepos(principal({ workspaceId: aliceProjectXId })).documents;

    const inDefault = await defRepo.create({
      filename: 'a.pdf',
      originalName: 'a.pdf',
      mimeType: 'application/pdf',
      size: 1,
      storagePath: '/tmp/a',
    });
    const inProject = await projectRepo.create({
      filename: 'b.pdf',
      originalName: 'b.pdf',
      mimeType: 'application/pdf',
      size: 1,
      storagePath: '/tmp/b',
    });
    expect(inDefault.workspaceId).toBe(aliceDefaultId);
    expect(inProject.workspaceId).toBe(aliceProjectXId);

    const defList = await defRepo.listOwn();
    expect(defList.find((d) => d.id === inDefault.id)).toBeDefined();
    expect(defList.find((d) => d.id === inProject.id)).toBeUndefined();

    const projList = await projectRepo.listOwn();
    expect(projList.find((d) => d.id === inProject.id)).toBeDefined();
    expect(projList.find((d) => d.id === inDefault.id)).toBeUndefined();

    // findById from wrong workspace collapses to null.
    expect(await projectRepo.findById(inDefault.id)).toBeNull();
  });
});
