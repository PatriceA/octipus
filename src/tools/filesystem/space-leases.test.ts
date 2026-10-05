/**
 * File leases on the agent's file tools (docs/plans/coworking-spec.md §7.5):
 * every `FILE_CHANGE_TOOLS` member, run by an agent in a space, is refused
 * on a path someone else leases — the file, a directory above it, or (for a
 * recursive delete or a directory move) a path under it — with who holds
 * it and until when, and nothing touches the disk. The lease check runs
 * under the per-path mutex with the write (compare-and-write).
 *
 * Backed by ephemeral PGlite and a temporary workspace root.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ToolHandler } from '@/core/agent-base';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const ben = randomUUID();
const ana = randomUUID();
let spaceId: string;
let root: string;
let tools: Map<string, ToolHandler>;
let anaAgent: AgentContext;

const benHuman = { userId: ben, kind: 'human' as const };

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-space-leases-'));
  const { getConfig, refreshConfigKey } = await import('@/config');
  getConfig();
  refreshConfigKey('workspace.rootPath', mkdtempSync(join(tmpdir(), 'octipus-space-leases-files-')));
  // Relative paths land at the space root, where the leases name them.
  refreshConfigKey('workspace.sessionFolders', false);
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: ben, username: 'ben' }, { id: ana, username: 'ana' }]);
  // Ana's stored permissions allow the writes: a refusal below is the lease's.
  const { getPermissionManager } = await import('@/security/permissions');
  for (const action of ['read', 'write', 'delete', 'list']) await getPermissionManager().setPermission(ana, 'filesystem', action, 'ALLOW');
  const { spaceWith } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(ben, [[ana, 'editor']]);
  const { WorkspaceFS } = await import('@/security/workspace-fs');
  root = WorkspaceFS.forSpace(spaceId).root;
  mkdirSync(root, { recursive: true });
  const { FilesystemTool } = await import('./index');
  const tool = new FilesystemTool();
  await tool.initialize();
  tools = (tool as unknown as { tools: Map<string, ToolHandler> }).tools;
  const { buildAgentContext } = await import('@/core/agent/context');
  anaAgent = buildAgentContext({
    sessionId: randomUUID(),
    userId: ana,
    scope: { workspaceId: spaceId, space: { workspaceId: spaceId, role: 'editor', scope: null }, trigger: 'user', funding: 'own' },
    topic: 'general',
    model: 'test-model',
    role: 'general',
    root: true,
    status: 'running',
  });
}, 120_000);

afterAll(async () => {
  const { _stopLeaseSweeperForTests } = await import('@/core/docs/file-leases');
  _stopLeaseSweeperForTests();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

const run = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, anaAgent);

async function lease(path: string): Promise<void> {
  const { acquireLease } = await import('@/core/docs/file-leases');
  expect((await acquireLease(spaceId, path, benHuman)).ok).toBe(true);
}

async function release(path: string): Promise<void> {
  const { releaseLease } = await import('@/core/docs/file-leases');
  await releaseLease(spaceId, path, benHuman);
}

describe('the agent and file leases', () => {
  test('every file-changing tool is refused on a file another member leases, with who and until when', async () => {
    const { FILE_CHANGE_TOOLS } = await import('@/core/tool-executor');
    const { ToolNotExecutedError } = await import('@/core/tool-execution-error');
    writeFileSync(join(root, 'plan.md'), 'v1\n');
    await lease('plan.md');
    const calls: Record<string, Record<string, unknown>> = {
      filesystem__write_file: { path: 'plan.md', content: 'v2\n' },
      filesystem__edit_file: { path: 'plan.md', old_string: 'v1', new_string: 'v2' },
      filesystem__append_file: { path: 'plan.md', content: 'more\n' },
      filesystem__delete_file: { path: 'plan.md' },
      filesystem__copy_file: { source: 'other.md', destination: 'plan.md' },
      filesystem__move_file: { source: 'plan.md', destination: 'moved.md' },
      filesystem__create_directory: { path: 'plan.md/sub' },
    };
    writeFileSync(join(root, 'other.md'), 'other\n');
    // One case per member: a tool added to the set must be covered here.
    expect(Object.keys(calls).sort()).toEqual([...FILE_CHANGE_TOOLS].sort());
    for (const [name, args] of Object.entries(calls)) {
      const refused = await run(name.replace('filesystem__', ''), args).catch((e: unknown) => e);
      expect(refused, name).toBeInstanceOf(ToolNotExecutedError);
      expect((refused as Error).message, name).toMatch(/plan\.md: ben is editing it until \d{4}-\d\d-\d\dT/);
    }
    expect(readFileSync(join(root, 'plan.md'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(root, 'moved.md'))).toBe(false);

    // Released: the agent writes.
    await release('plan.md');
    await run('write_file', { path: 'plan.md', content: 'v2\n' });
    expect(readFileSync(join(root, 'plan.md'), 'utf8')).toBe('v2\n');
  });

  test('a leased directory covers its files', async () => {
    mkdirSync(join(root, 'drafts'), { recursive: true });
    await lease('drafts');
    await expect(run('write_file', { path: 'drafts/deep/new.md', content: 'x' })).rejects.toThrow(/drafts: ben is editing it/);
    expect(existsSync(join(root, 'drafts', 'deep'))).toBe(false);
    await release('drafts');
  });

  test('a recursive delete or a move of a parent directory is refused when a file under it is leased', async () => {
    mkdirSync(join(root, 'reports', 'q3'), { recursive: true });
    writeFileSync(join(root, 'reports', 'q3', 'summary.md'), 'numbers\n');
    await lease('reports/q3/summary.md');

    await expect(run('delete_file', { path: 'reports', recursive: true })).rejects.toThrow(/reports\/q3\/summary\.md: ben is editing it/);
    await expect(run('move_file', { source: 'reports', destination: 'archive' })).rejects.toThrow(/reports\/q3\/summary\.md/);
    await expect(run('move_file', { source: 'reports/q3', destination: 'q3' })).rejects.toThrow(/reports\/q3\/summary\.md/);
    expect(readFileSync(join(root, 'reports', 'q3', 'summary.md'), 'utf8')).toBe('numbers\n');
    expect(existsSync(join(root, 'archive'))).toBe(false);

    // A sibling of the leased file, and a directory whose name only starts the same, are free.
    await run('write_file', { path: 'reports/q3/other.md', content: 'free\n' });
    mkdirSync(join(root, 'reports', 'q3x'), { recursive: true });
    await run('delete_file', { path: 'reports/q3x', recursive: true });
    expect(existsSync(join(root, 'reports', 'q3x'))).toBe(false);

    await release('reports/q3/summary.md');
    await run('move_file', { source: 'reports', destination: 'archive' });
    expect(existsSync(join(root, 'archive', 'q3', 'summary.md'))).toBe(true);
  });

  test('the lease check and the write are one compare-and-write under the per-path mutex', async () => {
    const { withPathLock } = await import('@/core/docs/file-leases');
    writeFileSync(join(root, 'race.md'), 'before\n');
    // Another writer holds the path's mutex; the agent's write waits behind it.
    let releaseLock!: () => void;
    const held = new Promise<void>((resolve) => { releaseLock = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const other = withPathLock(spaceId, 'race.md', async () => {
      entered();
      await held;
    });
    await inside;
    const write = run('write_file', { path: 'race.md', content: 'agent\n' }).catch((e: unknown) => e);
    // While it waits, a member takes the lease: the agent's check, inside
    // the mutex, sees it — no check-then-write gap.
    await lease('race.md');
    releaseLock();
    await other;
    expect(String(await write)).toMatch(/race\.md: ben is editing it/);
    expect(readFileSync(join(root, 'race.md'), 'utf8')).toBe('before\n');
    await release('race.md');

    // Two agent edits of one file run one after the other: both land.
    await Promise.all([
      run('append_file', { path: 'race.md', content: 'one\n' }),
      run('append_file', { path: 'race.md', content: 'two\n' }),
    ]);
    expect(readFileSync(join(root, 'race.md'), 'utf8').split('\n').sort()).toEqual(['', 'before', 'one', 'two']);
  });

  test('the agent working for the member who holds the lease is refused too (they are editing it now)', async () => {
    const { acquireLease, releaseLease } = await import('@/core/docs/file-leases');
    writeFileSync(join(root, 'mine.md'), 'x\n');
    expect((await acquireLease(spaceId, 'mine.md', { userId: ana, kind: 'human' })).ok).toBe(true);
    await expect(run('write_file', { path: 'mine.md', content: 'y\n' })).rejects.toThrow(/mine\.md: ana is editing it/);
    await releaseLease(spaceId, 'mine.md', { userId: ana, kind: 'human' });
  });
});
