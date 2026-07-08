/**
 * Swarm Phase 3 — orphan reaper.
 *
 * Marks any `swarm_nodes` row with `status='running'` older than the
 * configured threshold (`config.swarm.orphanReaperIntervalMs`, default 10
 * minutes) as `cancelled` with `error='orphaned_at_restart'`. Runs once at
 * boot AND on the same interval thereafter via `startPeriodicOrphanReaper`
 * (wired in `src/core/gateway.ts`), so a worker orphaned mid-process (not
 * just one left over from a crashed prior process) is also cleaned up.
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
    /**
     * Stop a reaped worker by id (node id == agent id). Injected for tests;
     * defaults to `AgentManager.stop(id, { cascade: true })`.
     */
    stopWorker?: (id: string) => void;
  } = {},
): Promise<ReapResult> {
  const cfg = getConfig();
  const olderThanMs = opts.olderThanMs ?? cfg.swarm?.orphanReaperIntervalMs ?? 600_000;
  const repo = opts.repo ?? swarmNodeRepository;

  let reaped = 0;
  let uncollectedDetached = 0;
  // Node id == agent id (1:1). Only UNAMBIGUOUS orphans go here — detached
  // children whose parent already terminated (second pass). The age-based
  // reapOrphans is DB-relabel only: it keys on createdAt, so a match can be a
  // healthy long-running agent we must not kill mid-work.
  const orphanIds = new Set<string>();

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
      for (const r of rows) orphanIds.add(r.id);
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

  // Actually stop the detached-orphan workers. Relabeling the row alone leaves
  // a live orphaned worker running and burning budget until killed (RC5 D4 —
  // the run-743d4b66 child ran 30 min past its parent). Safe because these are
  // detached children whose parent is already terminal, so no legitimate work
  // is in flight. `stop(cascade)` handles both an in-memory worker and a
  // cross-process zombie (no-op if neither).
  if (orphanIds.size > 0) {
    try {
      let stop = opts.stopWorker;
      if (!stop) {
        const { getAgentManager } = await import('@/core/agent-manager');
        const mgr = getAgentManager();
        stop = (id: string) => mgr.stop(id, { cascade: true });
      }
      for (const id of orphanIds) {
        try {
          stop(id);
        } catch (err) {
          coreLogger.error({ err, id }, 'Orphan reaper — failed to stop worker');
        }
      }
      coreLogger.warn({ stopped: orphanIds.size }, 'Orphan reaper — stopped orphaned workers');
    } catch (err) {
      coreLogger.error({ err }, 'Orphan reaper — could not load AgentManager to stop workers');
    }
  }

  return { reaped, olderThanMs, uncollectedDetached };
}

/**
 * How often the periodic loop checks for orphans. Deliberately NOT the same
 * config value as the row-staleness age threshold (`orphanReaperIntervalMs`,
 * user-facing as "Orphan reaper cadence (ms)") — that field is read fresh by
 * `reapOrphanedSwarmNodes()` on every tick to decide which rows are stale.
 * Coupling the two would mean lowering the cadence for faster sweeps also
 * lowers the staleness cutoff, cancelling nodes that are still legitimately
 * running.
 */
const DEFAULT_CHECK_INTERVAL_MS = 120_000;

/**
 * Run the reaper immediately (awaited, so boot-sequence steps that assume
 * the initial pass has completed — e.g. ledger reconcile — are ordered
 * correctly), then on a recurring interval. Returns a stop function (call on
 * shutdown), mirroring `AgentManager.startPeriodicCleanup`.
 *
 * Without the recurring part, orphans created after boot (a worker orphaned
 * mid-process, not just one left over from a crashed prior run) are only
 * ever cleaned up on the next restart.
 */
export async function startPeriodicOrphanReaper(
  checkIntervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): Promise<() => void> {
  const tick = () => {
    reapOrphanedSwarmNodes().catch(err =>
      coreLogger.error({ err }, 'Periodic swarm orphan reaper tick failed'),
    );
  };

  await reapOrphanedSwarmNodes().catch(err =>
    coreLogger.error({ err }, 'Initial swarm orphan reaper pass failed'),
  );
  const timer = setInterval(tick, checkIntervalMs);
  return () => clearInterval(timer);
}
