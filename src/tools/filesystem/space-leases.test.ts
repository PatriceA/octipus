/**
 * File leases on the agent's file tools (docs/plans/coworking-spec.md §7.5):
 * every `FILE_CHANGE_TOOLS` member, run by an agent in a space, is refused
 * on a path someone else leases — the file, a directory above it, or (for a
 * recursive delete or a directory move) a path under it — with who holds
 * it and until when, and nothing touches the disk. A lease names the
 * canonical path (symlinks followed) and the agent's write is checked by
 * both spellings. The lease check runs under the path locks with the
 * write, and lease acquisition takes the same locks: no lease is taken
 * between the agent's check and its write.
 *
 * Backed by ephemeral PGlite and a temporary workspace root.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ToolHandler } from '@/core/agent-base';
import type { AgentContext } from '@/core/types';

/**
 * A gate on the filesystem tool's `writeFile`: while `path` is set, a write
 * to a file ending with it signals `entered` and waits for `release` — the
 * agent is then past its lease check, inside its write.
 */
const gate = vi.hoisted(() => ({
  path: null as string | null,
  entered: null as (() => void) | null,
  release: Promise.resolve(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const writeFile = (async (...args: Parameters<typeof actual.writeFile>) => {
    if (gate.path && String(args[0]).endsWith(gate.path)) {
      gate.entered?.();
      await gate.release;
    }
    return actual.writeFile(...args);
  }) as typeof actual.writeFile;
  return { ...actual, default: { ...actual, writeFile }, writeFile };
});

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

  test('no lease is taken between the agent\'s check and its write (on the file, or a directory above it)', async () => {
    const { acquireLease } = await import('@/core/docs/file-leases');
    mkdirSync(join(root, 'gapdir'), { recursive: true });
    for (const leased of ['gapdir/gap.md', 'gapdir']) {
      writeFileSync(join(root, 'gapdir', 'gap.md'), 'before\n');
      let open!: () => void;
      gate.release = new Promise<void>((resolve) => { open = resolve; });
      const entered = new Promise<void>((resolve) => { gate.entered = resolve; });
      gate.path = 'gap.md';
      const write = run('write_file', { path: 'gapdir/gap.md', content: 'agent\n' });
      // The agent passed its lease check and is writing.
      await entered;
      let settled = false;
      const taking = acquireLease(spaceId, leased, benHuman).then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled, leased).toBe(false);
      gate.path = null;
      open();
      await write;
      // Taken once the write is done: the member's editor loads what the agent wrote.
      expect((await taking).ok, leased).toBe(true);
      expect(readFileSync(join(root, 'gapdir', 'gap.md'), 'utf8')).toBe('agent\n');
      await expect(run('write_file', { path: 'gapdir/gap.md', content: 'again\n' })).rejects.toThrow(/ben is editing it/);
      await release(leased);
    }
  });

  test('two agent edits of one file run one after the other', async () => {
    writeFileSync(join(root, 'race.md'), 'before\n');
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
    await expect(run('write_file', { path: 'mine.md', content: 'y\n' })).rejects.toThrow(/mine\.md: ana \(the member you work for\) is editing it/);
    await releaseLease(spaceId, 'mine.md', { userId: ana, kind: 'human' });
  });

  test('a lease through a symlinked directory names the real file; the agent is refused by either spelling', async () => {
    const { acquireLease, canonicalLeasePath, releaseLease } = await import('@/core/docs/file-leases');
    mkdirSync(join(root, 'projects', 'x'), { recursive: true });
    writeFileSync(join(root, 'projects', 'x', 'plan.md'), 'v1\n');
    symlinkSync(join(root, 'projects', 'x'), join(root, 'shared'));
    expect(canonicalLeasePath(spaceId, 'shared/plan.md')).toBe('projects/x/plan.md');
    expect(canonicalLeasePath(spaceId, '/shared/./plan.md')).toBe('projects/x/plan.md');
    expect(canonicalLeasePath(spaceId, 'shared')).toBe('projects/x');
    // A link out of the space is not a lease path.
    symlinkSync(tmpdir(), join(root, 'out'));
    expect(() => canonicalLeasePath(spaceId, 'out/x')).toThrow(/outside the space/);

    await lease(canonicalLeasePath(spaceId, 'shared/plan.md'));
    for (const path of ['shared/plan.md', 'projects/x/plan.md', 'shared/../shared/plan.md', join(root, 'shared', 'plan.md')]) {
      await expect(run('write_file', { path, content: 'v2\n' }), path).rejects.toThrow(/projects\/x\/plan\.md: ben is editing it/);
    }
    await expect(run('delete_file', { path: 'shared', recursive: true })).rejects.toThrow(/projects\/x\/plan\.md/);
    await expect(run('move_file', { source: 'shared', destination: 'elsewhere' })).rejects.toThrow(/projects\/x\/plan\.md/);
    expect(readFileSync(join(root, 'projects', 'x', 'plan.md'), 'utf8')).toBe('v1\n');
    await release('projects/x/plan.md');

    // A lease kept under the alias spelling (taken before canonical paths)
    // still refuses: the agent's write is checked by its lexical path too.
    expect((await acquireLease(spaceId, 'shared/plan.md', benHuman)).ok).toBe(true);
    await expect(run('write_file', { path: 'shared/plan.md', content: 'v2\n' })).rejects.toThrow(/shared\/plan\.md: ben is editing it/);
    await releaseLease(spaceId, 'shared/plan.md', benHuman);
  });

  test('a move into a leased directory is refused', async () => {
    mkdirSync(join(root, 'inbox'), { recursive: true });
    writeFileSync(join(root, 'loose.md'), 'loose\n');
    await lease('inbox');
    await expect(run('move_file', { source: 'loose.md', destination: 'inbox/loose.md' })).rejects.toThrow(/inbox: ben is editing it/);
    await expect(run('copy_file', { source: 'loose.md', destination: 'inbox/copy.md' })).rejects.toThrow(/inbox: ben is editing it/);
    expect(existsSync(join(root, 'loose.md'))).toBe(true);
    expect(existsSync(join(root, 'inbox', 'loose.md'))).toBe(false);
    await release('inbox');
  });

  test('with session folders on, a relative path lands in the session dir, and its lease is checked there', async () => {
    const { refreshConfigKey } = await import('@/config');
    refreshConfigKey('workspace.sessionFolders', true);
    try {
      const written = await run('write_file', { path: 'session-note.md', content: 'v1\n' }) as { path: string };
      const rel = relative(root, written.path).split('\\').join('/');
      expect(rel).toMatch(/^sessions\/[^/]+\/session-note\.md$/);
      await lease(rel);
      await expect(run('write_file', { path: 'session-note.md', content: 'v2\n' })).rejects.toThrow(/session-note\.md: ben is editing it/);
      await expect(run('append_file', { path: 'session-note.md', content: 'more\n' })).rejects.toThrow(/ben is editing it/);
      expect(readFileSync(written.path, 'utf8')).toBe('v1\n');
      await release(rel);
    } finally {
      refreshConfigKey('workspace.sessionFolders', false);
    }
  });
});
