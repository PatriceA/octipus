import { describe, test, expect } from 'bun:test';
import { reapOrphanedSwarmNodes } from './orphan-reaper';
import type { SwarmNodeRepository } from './node-repository';

/**
 * Orphan reaper unit tests — mock the repo so we don't need a live DB.
 * The integration behaviour (actual SQL update) is exercised by the
 * admin-API integration slice once the test DB is wired up.
 */

function makeRepoMock(reapedCount: number, detachedOrphans: number = 0): {
  repo: Pick<SwarmNodeRepository, 'reapOrphans' | 'reapUncollectedDetached'>;
  calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    repo: {
      async reapOrphans(olderThanMs: number): Promise<number> {
        calls.push(olderThanMs);
        return reapedCount;
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

describe('reapOrphanedSwarmNodes', () => {
  // Inject a no-op stopper by default so unit tests stay hermetic (don't reach
  // the real AgentManager). Tests that care assert on `stopped`.
  const noopStop = () => {};

  test('returns reaped count when rows are stale', async () => {
    const { repo, calls } = makeRepoMock(3);
    const result = await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo,
      stopWorker: noopStop,
    });
    expect(result.reaped).toBe(3);
    expect(result.olderThanMs).toBe(600_000);
    expect(calls).toEqual([600_000]);
  });

  test('returns 0 when nothing is stale (fresh rows untouched)', async () => {
    const { repo, calls } = makeRepoMock(0);
    const result = await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo,
      stopWorker: noopStop,
    });
    expect(result.reaped).toBe(0);
    expect(calls).toEqual([600_000]);
  });

  test('uses config default when olderThanMs is omitted', async () => {
    // This is the one case that reads getConfig() (for the default threshold).
    // Reset + reload the config cache from this worker's test env so the result
    // can't depend on a half-mutated singleton an earlier test left behind
    // (T1 — the source of the cross-file ordering flake).
    const { resetConfig, loadConfig } = await import('@/config');
    resetConfig();
    loadConfig();

    const { repo, calls } = makeRepoMock(1);
    await reapOrphanedSwarmNodes({ repo, stopWorker: noopStop });
    // Default from config is 600_000 (10 min). Accept whatever the loaded
    // config says — this covers both env-provided overrides and defaults.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(30_000);
  });

  test('fails safe: repo throw returns 0 and does not propagate', async () => {
    const throwingRepo: Pick<SwarmNodeRepository, 'reapOrphans' | 'reapUncollectedDetached'> = {
      async reapOrphans(): Promise<number> {
        throw new Error('db_down');
      },
      async reapUncollectedDetached(): Promise<Array<{ id: string; parentNodeId: string | null }>> {
        throw new Error('db_down');
      },
    };
    const result = await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo: throwingRepo,
      stopWorker: noopStop,
    });
    // Must not throw — boot path can't crash on a DB blip.
    expect(result.reaped).toBe(0);
    expect(result.uncollectedDetached).toBe(0);
  });

  test('reports detached-uncollected orphans in second pass', async () => {
    const { repo } = makeRepoMock(0, 2);
    const result = await reapOrphanedSwarmNodes({ olderThanMs: 600_000, repo, stopWorker: noopStop });
    expect(result.uncollectedDetached).toBe(2);
  });

  test('stops detached-uncollected orphans but NOT age-based ones', async () => {
    // RC5 D4: detached orphans (parent terminal) must actually be stopped, not
    // just relabeled. Age-based reap is DB-only — it keys on createdAt and would
    // otherwise kill healthy long-running agents.
    const { repo } = makeRepoMock(2, 3); // 2 age-based, 3 detached
    const stopped: string[] = [];
    await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo,
      stopWorker: (id) => stopped.push(id),
    });
    expect(stopped.sort()).toEqual(['detached-0', 'detached-1', 'detached-2']);
  });

  test('does not invoke the stopper when there are no detached orphans', async () => {
    // Age-based reaps alone (no detached orphans) must not stop any worker.
    const { repo } = makeRepoMock(5, 0);
    let called = 0;
    await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo,
      stopWorker: () => { called += 1; },
    });
    expect(called).toBe(0);
  });
});
