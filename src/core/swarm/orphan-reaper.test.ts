import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { getConfig, refreshConfigKey, resetConfig } from '@/config';
import { reapOrphanedSwarmNodes } from './orphan-reaper';
import type { SwarmNodeRepository } from './node-repository';
import { createWorktree, releaseWorktree } from './worktree';

// No test here may touch the real ~/.octipus: every worktree sweep this file
// triggers resolves its root to a throwaway directory.
const prevWorktreesDir = process.env.OCTIPUS_WORKTREES_DIR;
let scratch: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'octipus-reaper-')));
  process.env.OCTIPUS_WORKTREES_DIR = join(scratch, 'worktrees');
});
afterAll(() => {
  if (prevWorktreesDir === undefined) delete process.env.OCTIPUS_WORKTREES_DIR;
  else process.env.OCTIPUS_WORKTREES_DIR = prevWorktreesDir;
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Orphan reaper unit tests — mock the repo + liveness so we don't need a live
 * DB or a running AgentManager. The age-based pass is now liveness-gated: it
 * cancels only wedged in-memory workers and cross-process zombies, and leaves
 * healthy/blocked workers running.
 */

type Activity = { lastActivityAt: number; blockedSince: number | null };

function makeRepoMock(
  candidateIds: string[],
  detachedOrphans: number = 0,
): {
  repo: Pick<SwarmNodeRepository, 'findRunningOlderThan' | 'cancelNodes' | 'reapUncollectedDetached'>;
  cancelled: string[];
  calls: number[];
} {
  const calls: number[] = [];
  const cancelled: string[] = [];
  return {
    calls,
    cancelled,
    repo: {
      async findRunningOlderThan(olderThanMs: number): Promise<string[]> {
        calls.push(olderThanMs);
        return candidateIds;
      },
      async cancelNodes(ids: string[]): Promise<void> {
        cancelled.push(...ids);
      },
      async reapUncollectedDetached(): Promise<Array<{ id: string; parentNodeId: string | null }>> {
        return Array.from({ length: detachedOrphans }, (_, i) => ({
          id: `detached-${i}`,
          parentNodeId: 'parent-x',
        }));
      },
    },
  };
}

describe('reapOrphanedSwarmNodes — liveness-gated age-based pass', () => {
  const noopStop = () => {};

  test('cancels a wedged worker but leaves healthy / slow ones running', async () => {
    const now = Date.now();
    const { repo, cancelled } = makeRepoMock(['healthy', 'slow', 'wedged']);
    const activity: Record<string, Activity> = {
      healthy: { lastActivityAt: now, blockedSince: null }, // just bumped
      // 12 min since last heartbeat but under the 30-min wedge window — e.g. a
      // slow un-instrumented gap; NOT wedged.
      slow: { lastActivityAt: now - 12 * 60_000, blockedSince: null },
      // >30 min with no activity and not blocked → genuinely wedged.
      wedged: { lastActivityAt: now - 40 * 60_000, blockedSince: null },
    };
    const stopped: string[] = [];
    const result = await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo,
      getActivity: (id) => activity[id] ?? null,
      stopWorker: (id) => stopped.push(id),
    });
    expect(cancelled).toEqual(['wedged']);
    expect(stopped).toEqual(['wedged']);
    expect(result.reaped).toBe(1);
  });

  test('leaves a worker busy in a long tool alone (blockedSince set)', async () => {
    const now = Date.now();
    const { repo, cancelled } = makeRepoMock(['in-long-tool']);
    const stopped: string[] = [];
    await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo,
      // Heartbeat is 40 min stale, but the worker is blocked (executing a tool)
      // → must NOT be killed.
      getActivity: () => ({ lastActivityAt: now - 40 * 60_000, blockedSince: now - 40 * 60_000 }),
      stopWorker: (id) => stopped.push(id),
    });
    expect(cancelled).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test('leaves a legitimately-blocked worker alone (awaiting approval/children)', async () => {
    const now = Date.now();
    const { repo, cancelled } = makeRepoMock(['blocked']);
    const stopped: string[] = [];
    await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo,
      // Old lastActivityAt, but blockedSince set → it's waiting on purpose.
      getActivity: () => ({ lastActivityAt: now - 900_000, blockedSince: now - 900_000 }),
      stopWorker: (id) => stopped.push(id),
    });
    expect(cancelled).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test('cancels a cross-process zombie (not in this process memory)', async () => {
    const { repo, cancelled } = makeRepoMock(['zombie']);
    const stopped: string[] = [];
    await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo,
      getActivity: () => null, // not in memory
      stopWorker: (id) => stopped.push(id),
    });
    expect(cancelled).toEqual(['zombie']);
    expect(stopped).toEqual(['zombie']);
  });

  test('no candidates → no cancel, no stop', async () => {
    const { repo, cancelled, calls } = makeRepoMock([]);
    let stopCalls = 0;
    const result = await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo,
      getActivity: () => null,
      stopWorker: () => { stopCalls += 1; },
    });
    expect(cancelled).toEqual([]);
    expect(stopCalls).toBe(0);
    expect(result.reaped).toBe(0);
    expect(calls).toEqual([600_000]);
  });

  test('detached-uncollected orphans are still cancelled + stopped', async () => {
    const { repo } = makeRepoMock([], 3);
    const stopped: string[] = [];
    const result = await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo,
      getActivity: () => null,
      stopWorker: (id) => stopped.push(id),
    });
    expect(result.uncollectedDetached).toBe(3);
    expect(stopped.sort()).toEqual(['detached-0', 'detached-1', 'detached-2']);
  });

  test('uses config default when olderThanMs is omitted', async () => {
    const { resetConfig, loadConfig } = await import('@/config');
    resetConfig();
    loadConfig();
    const { repo, calls } = makeRepoMock([]);
    await reapOrphanedSwarmNodes({ repo, getActivity: () => null, stopWorker: noopStop });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(30_000);
  });

  test('fails safe: a repo throw does not propagate', async () => {
    const throwingRepo: Pick<
      SwarmNodeRepository,
      'findRunningOlderThan' | 'cancelNodes' | 'reapUncollectedDetached'
    > = {
      async findRunningOlderThan(): Promise<string[]> { throw new Error('db_down'); },
      async cancelNodes(): Promise<void> { throw new Error('db_down'); },
      async reapUncollectedDetached(): Promise<Array<{ id: string; parentNodeId: string | null }>> {
        throw new Error('db_down');
      },
    };
    const result = await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo: throwingRepo,
      getActivity: () => null,
      stopWorker: noopStop,
    });
    expect(result.reaped).toBe(0);
    expect(result.uncollectedDetached).toBe(0);
  });
});

describe('reapOrphanedSwarmNodes — stale worktree pass', () => {
  let repo: string;
  const root = () => join(scratch, 'worktrees');

  beforeEach(async () => {
    repo = join(scratch, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(repo);
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    g('add', '-A');
    g('-c', 'user.name=T', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    resetConfig();
    getConfig();
  });
  afterEach(() => resetConfig());

  const reap = () =>
    reapOrphanedSwarmNodes({
      repo: makeRepoMock([]).repo,
      stopWorker: () => {},
      getActivity: () => null,
      worktrees: { root: root(), minAgeMs: 0 },
    });

  test('flag off: the sweep does not run, even over an abandoned merged worktree', async () => {
    const id = `off${Date.now()}`;
    const h = await createWorktree(repo, id, { root: root() });
    releaseWorktree(id);
    expect(getConfig().swarm.worktreeIsolation).toBe(false);

    const result = await reap();

    expect(result.staleWorktrees).toBeUndefined();
    expect(existsSync(h.path)).toBe(true);
    expect(execFileSync('git', ['branch', '--list', `octipus/${id}`], { cwd: repo, encoding: 'utf-8' }).trim()).not.toBe('');
  });

  test('flag on: an abandoned merged worktree is pruned', async () => {
    refreshConfigKey('swarm.worktreeIsolation', true);
    const id = `on${Date.now()}`;
    const h = await createWorktree(repo, id, { root: root() });
    releaseWorktree(id);

    const result = await reap();

    expect(result.staleWorktrees?.pruned).toContain(id);
    expect(existsSync(h.path)).toBe(false);
  });
});
