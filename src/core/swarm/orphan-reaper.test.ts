import { describe, test, expect } from 'bun:test';
import { reapOrphanedSwarmNodes } from './orphan-reaper';
import type { SwarmNodeRepository } from './node-repository';

/**
 * Orphan reaper unit tests — mock the repo so we don't need a live DB.
 * The integration behaviour (actual SQL update) is exercised by the
 * admin-API integration slice once the test DB is wired up.
 */

function makeRepoMock(reapedCount: number): {
  repo: Pick<SwarmNodeRepository, 'reapOrphans'>;
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
    },
  };
}

describe('reapOrphanedSwarmNodes', () => {
  test('returns reaped count when rows are stale', async () => {
    const { repo, calls } = makeRepoMock(3);
    const result = await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo,
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
    });
    expect(result.reaped).toBe(0);
    expect(calls).toEqual([600_000]);
  });

  test('uses config default when olderThanMs is omitted', async () => {
    const { repo, calls } = makeRepoMock(1);
    await reapOrphanedSwarmNodes({ repo });
    // Default from config is 600_000 (10 min). Accept whatever the loaded
    // config says — this covers both env-provided overrides and defaults.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(30_000);
  });

  test('fails safe: repo throw returns 0 and does not propagate', async () => {
    const throwingRepo: Pick<SwarmNodeRepository, 'reapOrphans'> = {
      async reapOrphans(): Promise<number> {
        throw new Error('db_down');
      },
    };
    const result = await reapOrphanedSwarmNodes({
      olderThanMs: 600_000,
      repo: throwingRepo,
    });
    // Must not throw — boot path can't crash on a DB blip.
    expect(result.reaped).toBe(0);
  });
});
