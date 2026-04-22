/**
 * Swarm Phase 3 — orphan reaper.
 *
 * On process start, marks any `swarm_nodes` row with `status='running'`
 * older than the configured threshold (`config.swarm.orphanReaperIntervalMs`,
 * default 10 minutes) as `cancelled` with `error='orphaned_at_restart'`.
 * Mirrors the agent-manager stale cleanup and is called once during the
 * gateway hub boot sequence in `src/index.ts`.
 *
 * Safe to run multiple times — idempotent (only flips `running` rows). No
 * effect on completed / cancelled / errored rows.
 */
import { getConfig } from '@/config';
import { coreLogger } from '@/utils/logger';
import { type SwarmNodeRepository, swarmNodeRepository } from './node-repository';

export interface ReapResult {
  /** Number of `running` rows flipped to `cancelled`. */
  reaped: number;
  /** Age threshold used (ms). */
  olderThanMs: number;
  /**
   * Detached-and-uncollected subagents whose parent was already terminal
   * when the reaper ran. These are the canonical "forgot-to-collect"
   * case — worth surfacing in metrics because they indicate an agent
   * prompt / behaviour drift, not a crash.
   */
  uncollectedDetached: number;
}

/**
 * Execute a single reaper pass. Returns the count of reaped rows so the
 * caller can log + surface in metrics.
 *
 * Errors are caught + logged: a boot-time reaper must never crash the
 * server. The server will still come up with orphans; they'll be garbage-
 * collected on the next successful pass.
 */
export async function reapOrphanedSwarmNodes(
  opts: {
    /** Override age threshold (ms). Defaults to `config.swarm.orphanReaperIntervalMs`. */
    olderThanMs?: number;
    /** Override repository (tests). */
    repo?: Pick<SwarmNodeRepository, 'reapOrphans' | 'reapUncollectedDetached'>;
  } = {},
): Promise<ReapResult> {
  const cfg = getConfig();
  const olderThanMs = opts.olderThanMs ?? cfg.swarm?.orphanReaperIntervalMs ?? 600_000;
  const repo = opts.repo ?? swarmNodeRepository;

  let reaped = 0;
  let uncollectedDetached = 0;

  try {
    reaped = await repo.reapOrphans(olderThanMs);
    if (reaped > 0) {
      coreLogger.warn(
        { reaped, olderThanMs },
        'Swarm orphan reaper — marked stale running nodes as cancelled',
      );
    } else {
      coreLogger.debug(
        { olderThanMs },
        'Swarm orphan reaper — no stale nodes found',
      );
    }
  } catch (err) {
    coreLogger.error(
      { err, olderThanMs },
      'Swarm orphan reaper failed — continuing boot',
    );
  }

  // Second pass: detached subagents whose parent went terminal without
  // calling collect_children. These are budget + memory orphans, not
  // necessarily age-related, so the age threshold above would miss them.
  try {
    if (repo.reapUncollectedDetached) {
      const rows = await repo.reapUncollectedDetached();
      uncollectedDetached = rows.length;
      if (uncollectedDetached > 0) {
        coreLogger.warn(
          { uncollectedDetached, sample: rows.slice(0, 5) },
          'Swarm orphan reaper — cancelled detached subagents whose parent forgot to collect',
        );
      }
    }
  } catch (err) {
    coreLogger.error(
      { err },
      'Swarm orphan reaper uncollected-detached pass failed',
    );
  }

  return { reaped, olderThanMs, uncollectedDetached };
}
