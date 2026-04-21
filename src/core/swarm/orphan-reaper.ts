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
    repo?: Pick<SwarmNodeRepository, 'reapOrphans'>;
  } = {},
): Promise<ReapResult> {
  const cfg = getConfig();
  const olderThanMs = opts.olderThanMs ?? cfg.swarm?.orphanReaperIntervalMs ?? 600_000;
  const repo = opts.repo ?? swarmNodeRepository;

  try {
    const reaped = await repo.reapOrphans(olderThanMs);
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
    return { reaped, olderThanMs };
  } catch (err) {
    coreLogger.error(
      { err, olderThanMs },
      'Swarm orphan reaper failed — continuing boot',
    );
    return { reaped: 0, olderThanMs };
  }
}
