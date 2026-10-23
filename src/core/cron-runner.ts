import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { sweepPurgedSpaceFiles } from '@/core/spaces/purge';
import { maybeRunHeartbeats } from '@/core/heartbeat';
import { fireDueReminders } from '@/core/tasks/reminders';
import { defaultListenDeps, runListenTick } from '@/channels/group-listen';
import { getDb } from '@/db/postgres';
import { agentRepository } from '@/db/repositories/agent-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { type Hook, hooks } from '@/db/schema/hooks';
import { retentionPolicies } from '@/db/schema/retention-policies';
import { getHookManager } from '@/hooks/manager';
import { coreLogger } from '@/utils/logger';

const CRON_INTERVAL_MS = 60_000; // Check every minute
const SESSION_CLEANUP_INTERVAL_MS = 3600_000; // Check every hour
const KNOWLEDGE_CLEANUP_INTERVAL_MS = 7 * 24 * 3600_000; // Weekly
const AGENT_CLEANUP_INTERVAL_MS = 7 * 24 * 3600_000; // Weekly
const DOCS_REINDEX_INTERVAL_MS = 6 * 3600_000; // Every 6 hours
const TRAJECTORY_COMPRESS_INTERVAL_MS = 24 * 3600_000; // Daily
const SPACE_FILES_SWEEP_INTERVAL_MS = 3600_000; // Hourly
const VECTOR_INDEX_INTERVAL_MS = 24 * 3600_000; // Daily
const LOG_PRUNE_INTERVAL_MS = 24 * 3600_000; // Daily

/**
 * Default age cap for finished agent rows + their events. Nobody needs an
 * endless agent log on a test box; finished agents older than this get
 * swept weekly. Operators can override per deployment by upserting a
 * `retention_policies` row with purpose='agent_history' and a maxAgeDays.
 */
const AGENT_HISTORY_RETENTION_DAYS_DEFAULT = 14;

let cronTimer: NodeJS.Timeout | null = null;
let lastSessionCleanup = 0;
let lastKnowledgeCleanup = 0;
let lastAgentCleanup = 0;
let lastSpaceFilesSweep = 0;
// Seed to boot time, NOT 0: the boot sequence already runs `indexProductDocs()`
// (src/index.ts) before the cron loop starts, so the immediate first tick must
// NOT re-run it. The first cron refresh fires one DOCS_REINDEX_INTERVAL_MS
// later; the first-install / KB-not-ready-at-boot case is still handled because
// the boot pass bailed and subsequent ticks (every 6h) will land the docs once
// an embedding model is bound. (Session/knowledge cleanup init to 0 on purpose
// — they have no boot-time pass, so they SHOULD run on the first tick.)
let lastDocsReindex = Date.now();
// Seed to 0 so the first tick after boot compresses yesterday's file (idempotent).
let lastTrajectoryCompress = 0;
// Seeded to boot time: src/index.ts runs the same check during boot.
let lastVectorIndexEnsure = Date.now();
let lastLogPrune = 0;
let logPruneRunning = false;
let reminderSweepRunning = false;

/**
 * Parse a simple cron expression and compute the next run date.
 * Supports: minute hour dayOfMonth month dayOfWeek
 * Also supports interval shorthand: star/N (every N units)
 */
export function getNextCronDate(cronExpr: string, timezone = 'UTC'): Date {
  const now = new Date();
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) {
    // Fallback: treat as interval in minutes
    const intervalMin = parseInt(cronExpr.replace(/[^0-9]/g, ''), 10) || 60;
    return new Date(now.getTime() + intervalMin * 60_000);
  }

  const [minPart, hourPart] = parts;

  // Handle */N minute patterns
  const minMatch = minPart.match(/^\*\/(\d+)$/);
  if (minMatch) {
    const interval = parseInt(minMatch[1], 10);
    const currentMin = now.getMinutes();
    const nextMin = Math.ceil((currentMin + 1) / interval) * interval;
    const next = new Date(now);
    if (nextMin >= 60) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(nextMin - 60);
    } else {
      next.setMinutes(nextMin);
    }
    next.setSeconds(0);
    next.setMilliseconds(0);
    return next;
  }

  // Handle */N hour patterns
  const hourMatch = hourPart.match(/^\*\/(\d+)$/);
  if (hourMatch) {
    const interval = parseInt(hourMatch[1], 10);
    const currentHour = now.getHours();
    const nextHour = Math.ceil((currentHour + 1) / interval) * interval;
    const next = new Date(now);
    if (nextHour >= 24) {
      next.setDate(next.getDate() + 1);
      next.setHours(nextHour - 24);
    } else {
      next.setHours(nextHour);
    }
    next.setMinutes(minPart === '*' ? 0 : parseInt(minPart, 10) || 0);
    next.setSeconds(0);
    next.setMilliseconds(0);
    return next;
  }

  // Simple fixed time: run at specific minute/hour, next occurrence
  const targetMin = minPart === '*' ? 0 : parseInt(minPart, 10);
  const targetHour = hourPart === '*' ? now.getHours() : parseInt(hourPart, 10);

  const next = new Date(now);
  next.setMinutes(targetMin);
  next.setSeconds(0);
  next.setMilliseconds(0);

  if (hourPart === '*') {
    // Run every hour at targetMin
    if (now.getMinutes() >= targetMin) {
      next.setHours(next.getHours() + 1);
    }
  } else {
    next.setHours(targetHour);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
  }

  return next;
}

async function maybeCleanupSessions(): Promise<void> {
  const now = Date.now();
  if (now - lastSessionCleanup < SESSION_CLEANUP_INTERVAL_MS) return;
  lastSessionCleanup = now;

  try {
    const archived = await sessionRepository.cleanupOldWebchatSessions(7);
    if (archived > 0) {
      coreLogger.info({ archived }, 'Session cleanup: archived old webchat sessions');
    }

    // Retention: delete sessions idle past the configured window (0 = never).
    // Pinned ("keep") sessions are exempt — see SessionRepository.deleteExpired.
    const retentionDays = getConfig().sessions.retentionDays;
    if (retentionDays > 0) {
      const cutoff = new Date(now - retentionDays * 24 * 3600_000);
      const deleted = await sessionRepository.deleteExpired(cutoff);
      if (deleted > 0) {
        coreLogger.info({ deleted, retentionDays }, 'Session cleanup: deleted sessions past retention');
      }
    }
  } catch (err) {
    coreLogger.error({ err }, 'Session cleanup failed');
  }
}

/**
 * Retry for purged spaces whose directories could not be removed at purge
 * time (src/core/spaces/purge.ts): removes every space directory whose
 * workspace row is gone.
 */
async function maybeSweepPurgedSpaceFiles(): Promise<void> {
  const now = Date.now();
  if (now - lastSpaceFilesSweep < SPACE_FILES_SWEEP_INTERVAL_MS) return;
  lastSpaceFilesSweep = now;
  try {
    await sweepPurgedSpaceFiles();
  } catch (err) {
    coreLogger.error({ err }, 'Purged space directory sweep failed');
  }
}

async function maybeCleanupKnowledge(): Promise<void> {
  const now = Date.now();
  if (now - lastKnowledgeCleanup < KNOWLEDGE_CLEANUP_INTERVAL_MS) return;
  lastKnowledgeCleanup = now;

  try {
    const service = getEmbeddingService();
    const result = await service.cleanup({ kind: 'install' }, { maxAgeDays: 30, minContentLength: 50, triggeredBy: 'scheduled' });
    if (result.total > 0) {
      coreLogger.info(result, 'Knowledge cleanup: removed stale entries');
    }
  } catch (err) {
    coreLogger.error({ err }, 'Knowledge cleanup failed');
  }
}

async function maybeCleanupAgents(): Promise<void> {
  const now = Date.now();
  if (now - lastAgentCleanup < AGENT_CLEANUP_INTERVAL_MS) return;
  lastAgentCleanup = now;

  try {
    // Resolve the retention window: operator override row wins, else default.
    let days = AGENT_HISTORY_RETENTION_DAYS_DEFAULT;
    const [policy] = await getDb()
      .select()
      .from(retentionPolicies)
      .where(eq(retentionPolicies.purpose, 'agent_history'))
      .limit(1);
    if (policy?.maxAgeDays && policy.maxAgeDays > 0) {
      days = policy.maxAgeDays;
    }

    const cutoff = new Date(now - days * 24 * 3600_000);
    const removed = await agentRepository.deleteCompletedBefore(cutoff);
    if (removed > 0) {
      coreLogger.info({ removed, days }, 'Agent cleanup: removed stale agent history + events');
    }
  } catch (err) {
    coreLogger.error({ err }, 'Agent cleanup failed');
  }
}

async function maybeReindexDocs(): Promise<void> {
  const now = Date.now();
  if (now - lastDocsReindex < DOCS_REINDEX_INTERVAL_MS) return;
  lastDocsReindex = now;

  try {
    // Refresh the product-docs corpus in the KB. Idempotent — unchanged files
    // are skipped, so this is cheap. Also covers first-install where the
    // embedding model is bound AFTER boot: the boot-time index found the KB
    // not-ready and bailed, and this is what actually lands the docs once a
    // model is assigned.
    const { indexProductDocs } = await import('@/db/seed-docs');
    const res = await indexProductDocs();
    if (res.filesIndexed > 0) {
      coreLogger.info(res, 'Docs reindex: refreshed product docs in the knowledge base');
    }
  } catch (err) {
    coreLogger.error({ err }, 'Docs reindex failed');
  }
}

/**
 * Gzip yesterday's trajectory JSONL once a day. Without this the recorder's
 * daily files accumulate uncompressed forever (the `compress` script existed
 * but nothing ran it). Idempotent + best-effort — never aborts the tick.
 */
async function maybeCompressTrajectories(): Promise<void> {
  const now = Date.now();
  if (now - lastTrajectoryCompress < TRAJECTORY_COMPRESS_INTERVAL_MS) return;
  lastTrajectoryCompress = now;
  try {
    const { compressTrajectoryForDate } = await import('@/core/trajectories/recorder');
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const result = compressTrajectoryForDate(yesterday);
    if (result === 'compressed') {
      coreLogger.info({ result }, 'Trajectory compress: gzipped yesterday\'s JSONL');
    }
  } catch (err) {
    coreLogger.warn({ err: (err as Error).message }, 'Trajectory compress failed — continuing');
  }
}

/**
 * Build the HNSW indexes once the embedding tables have rows of one dimension
 * (src/db/vector-indexes.ts). Boot does it too; this catches an install whose
 * tables were still empty then. Not awaited: a build can take minutes.
 */
function maybeEnsureVectorIndexes(): void {
  const now = Date.now();
  if (now - lastVectorIndexEnsure < VECTOR_INDEX_INTERVAL_MS) return;
  lastVectorIndexEnsure = now;
  void import('@/db/vector-indexes')
    .then(({ ensureVectorIndexes }) => ensureVectorIndexes())
    .then((outcomes) => { if (outcomes && Object.values(outcomes).includes('created')) coreLogger.info({ outcomes }, 'Vector indexes built'); })
    .catch((err: unknown) => coreLogger.error({ err }, 'Vector index ensure failed'));
}

/**
 * Age out the log tables (src/core/log-retention.ts) once a day. Not awaited:
 * a first run over a large backlog deletes in many batches and must not hold
 * up the scheduled hooks below; a run still going makes the next one a no-op.
 */
function maybePruneLogs(): void {
  const now = Date.now();
  if (logPruneRunning || now - lastLogPrune < LOG_PRUNE_INTERVAL_MS) return;
  lastLogPrune = now;
  logPruneRunning = true;
  void import('@/core/log-retention')
    .then(({ pruneLogTables }) => pruneLogTables(new Date(now)))
    .then((removed) => {
      if (removed && Object.values(removed).some((n) => n > 0)) coreLogger.info({ removed }, 'Log retention: pruned old rows');
    })
    .catch((err: unknown) => coreLogger.error({ err }, 'Log retention prune failed'))
    .finally(() => { logPruneRunning = false; });
}

/**
 * Claim a due schedule hook for this tick: move its nextRunAt on (and disable
 * a one-shot) only if nextRunAt still holds what the tick read. Every instance
 * runs this loop, and two can read the same due hook; only the one whose
 * UPDATE matches fires it. The same compare-and-set as the heartbeat's slot
 * claim (heartbeat.ts) — compared at millisecond precision, since the row
 * was read into a JS Date.
 */
export async function claimDueHook(hook: Hook, nextRunAt: Date | null, oneShot: boolean, now: Date): Promise<boolean> {
  const snapshot = hook.nextRunAt;
  const [claimed] = await getDb()
    .update(hooks)
    .set({ nextRunAt, ...(oneShot && { isEnabled: false }), updatedAt: now })
    .where(and(
      eq(hooks.id, hook.id),
      eq(hooks.isEnabled, true),
      snapshot == null ? isNull(hooks.nextRunAt) : sql`date_trunc('milliseconds', ${hooks.nextRunAt}) = ${snapshot.toISOString()}::timestamptz`,
    ))
    .returning({ id: hooks.id });
  return claimed !== undefined;
}

const listenDeps = defaultListenDeps();
let roomListenDeps: import('@/channels/group-listen').ListenDeps<import('@/core/rooms/listen').RoomListenTarget> | null = null;

async function processCronTick(): Promise<void> {
  try {
    await maybeCleanupSessions();
    await maybeCleanupKnowledge();
    await maybeCleanupAgents();
    await maybeSweepPurgedSpaceFiles();
    await maybeReindexDocs();
    await maybeCompressTrajectories();
    maybeEnsureVectorIndexes();
    maybePruneLogs();
    const db = getDb();
    const now = new Date();

    // WS2 heartbeat — process due per-user heartbeat hooks (gated, cheap-first).
    // Runs before the schedule query's early return below. No-op when disabled.
    await maybeRunHeartbeats(now);

    // Follow-ups whose date has passed (core/tasks/reminders.ts). Not
    // awaited, so a burst of reminders never holds up scheduled hooks; a
    // sweep still running makes the next tick's a no-op.
    if (!reminderSweepRunning) {
      reminderSweepRunning = true;
      fireDueReminders(now)
        .then((sent) => { if (sent > 0) coreLogger.info({ sent }, 'Follow-up reminders handed to notifications'); })
        .catch((err: unknown) => coreLogger.error({ err }, 'Follow-up reminder sweep failed'))
        .finally(() => { reminderSweepRunning = false; });
    }

    // Group channels in listen / proactive mode: unanswered questions, gated
    // cheap-first (src/channels/group-listen.ts). No-op unless enabled. Not
    // awaited: its model calls must not hold up scheduled hooks; a tick still
    // running makes the next one a no-op.
    void runListenTick(listenDeps);
    // Rooms in listen / proactive mode (coworking §9.3): the same gate. Every
    // instance runs it (room transcripts are in the database); the probe is
    // claimed on the room's row before it is paid (`claimRoomProbe`), so one
    // instance probes a room at a time and never the same question twice.
    roomListenDeps ??= (await import('@/core/rooms/listen')).roomListenDeps();
    void runListenTick(roomListenDeps);

    // Find schedule-triggered hooks that are due
    const dueHooks = await db
      .select()
      .from(hooks)
      .where(
        and(
          eq(hooks.trigger, 'schedule'),
          eq(hooks.isEnabled, true),
          isNotNull(hooks.nextRunAt),
          lte(hooks.nextRunAt, now),
        ),
      );

    if (dueHooks.length === 0) return;

    coreLogger.info({ count: dueHooks.length }, 'Processing due scheduled hooks');
    const hookManager = getHookManager();

    for (const hook of dueHooks) {
      const cronExpression = hook.triggerConfig?.cronExpression as string;
      const scheduledAt = hook.triggerConfig?.scheduledAt as string | undefined;
      const timezone = (hook.triggerConfig?.timezone as string) || 'UTC';
      const isDatetimeTask = !!scheduledAt && !cronExpression;

      // IMPORTANT: Update nextRunAt BEFORE executing — hook execution can take minutes/hours
      // (e.g. spawning a root agent + research agent). Without this, the next cron tick
      // finds the same hook still "due" and fires it again, causing duplicate executions.
      // One-time datetime task: clear nextRunAt and disable after firing.
      const nextRun = isDatetimeTask ? null : getNextCronDate(cronExpression, timezone);
      if (!(await claimDueHook(hook, nextRun, isDatetimeTask, now))) {
        coreLogger.debug({ hookId: hook.id }, 'Scheduled hook claimed elsewhere since this tick read it; skipping');
        continue;
      }

      try {
        // Execute directly via hookManager.triggerHook() — this handles action execution + logging
        // Fire-and-forget for long-running actions (spawn_agent) to avoid blocking the cron loop
        hookManager.triggerHook(
          hook.id,
          { type: 'schedule', data: { hookId: hook.id }, timestamp: now },
          { schedule: { cronExpression, scheduledTime: now, hookName: hook.name } },
          // The row this tick claimed (a one-shot is already disabled in the DB).
          { claimedRow: hook },
        ).then(() => {
          db.update(hooks)
            .set({ lastError: null, updatedAt: new Date() })
            .where(eq(hooks.id, hook.id))
            .catch((err: unknown) => coreLogger.error({ err }, 'background task failed in cron-runner'));
          coreLogger.info({ hookId: hook.id, name: hook.name, nextRun }, 'Scheduled hook completed');
        }).catch(err => {
          db.update(hooks)
            .set({ lastError: (err as Error).message, updatedAt: new Date() })
            .where(eq(hooks.id, hook.id))
            .catch((err: unknown) => coreLogger.error({ err }, 'background task failed in cron-runner'));
          coreLogger.error({ err, hookId: hook.id }, 'Scheduled hook execution failed');
        });

        coreLogger.info({ hookId: hook.id, name: hook.name, nextRun }, 'Scheduled hook triggered');
      } catch (err) {
        await db
          .update(hooks)
          .set({
            lastError: (err as Error).message,
            updatedAt: now,
          })
          .where(eq(hooks.id, hook.id));

        coreLogger.error({ err, hookId: hook.id }, 'Scheduled hook execution failed');
      }
    }
  } catch (err) {
    coreLogger.error({ err }, 'Cron tick failed');
  }
}

export function startCronLoop(): void {
  if (cronTimer) return;

  coreLogger.info('Starting cron loop (60s interval)');
  cronTimer = setInterval(processCronTick, CRON_INTERVAL_MS);

  // Run immediately on start
  processCronTick().catch(err => coreLogger.error({ err }, 'Initial cron tick failed'));
}

export function stopCronLoop(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
    coreLogger.info('Cron loop stopped');
  }
}
