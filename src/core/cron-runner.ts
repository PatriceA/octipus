import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getDb } from '@/db/postgres';
import { agentRepository } from '@/db/repositories/agent-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { hooks } from '@/db/schema/hooks';
import { retentionPolicies } from '@/db/schema/retention-policies';
import { getHookManager } from '@/hooks/manager';
import { coreLogger } from '@/utils/logger';

const CRON_INTERVAL_MS = 60_000; // Check every minute
const SESSION_CLEANUP_INTERVAL_MS = 3600_000; // Check every hour
const KNOWLEDGE_CLEANUP_INTERVAL_MS = 7 * 24 * 3600_000; // Weekly
const AGENT_CLEANUP_INTERVAL_MS = 7 * 24 * 3600_000; // Weekly
const DOCS_REINDEX_INTERVAL_MS = 6 * 3600_000; // Every 6 hours

/**
 * Default age cap for finished agent rows + their events. Nobody needs an
 * endless agent log on a test box; finished agents older than this get
 * swept weekly. Operators can override per deployment by upserting a
 * `retention_policies` row with purpose='agent_history' and a maxAgeDays.
 */
const AGENT_HISTORY_RETENTION_DAYS_DEFAULT = 14;

let cronTimer: Timer | null = null;
let lastSessionCleanup = 0;
let lastKnowledgeCleanup = 0;
let lastAgentCleanup = 0;
// Seed to boot time, NOT 0: the boot sequence already runs `indexProductDocs()`
// (src/index.ts) before the cron loop starts, so the immediate first tick must
// NOT re-run it. The first cron refresh fires one DOCS_REINDEX_INTERVAL_MS
// later; the first-install / KB-not-ready-at-boot case is still handled because
// the boot pass bailed and subsequent ticks (every 6h) will land the docs once
// an embedding model is bound. (Session/knowledge cleanup init to 0 on purpose
// — they have no boot-time pass, so they SHOULD run on the first tick.)
let lastDocsReindex = Date.now();

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
  } catch (err) {
    coreLogger.error({ err }, 'Session cleanup failed');
  }
}

async function maybeCleanupKnowledge(): Promise<void> {
  const now = Date.now();
  if (now - lastKnowledgeCleanup < KNOWLEDGE_CLEANUP_INTERVAL_MS) return;
  lastKnowledgeCleanup = now;

  try {
    const service = getEmbeddingService();
    const result = await service.cleanup({ maxAgeDays: 30, minContentLength: 50, triggeredBy: 'scheduled' });
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

async function processCronTick(): Promise<void> {
  try {
    await maybeCleanupSessions();
    await maybeCleanupKnowledge();
    await maybeCleanupAgents();
    await maybeReindexDocs();
    const db = getDb();
    const now = new Date();

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
      // (e.g. spawning an orchestrator + research agent). Without this, the next cron tick
      // finds the same hook still "due" and fires it again, causing duplicate executions.
      const nextRun = isDatetimeTask ? null : getNextCronDate(cronExpression, timezone);
      if (isDatetimeTask) {
        // One-time datetime task: clear nextRunAt and disable after firing
        await db
          .update(hooks)
          .set({
            nextRunAt: null,
            isEnabled: false,
            updatedAt: now,
          })
          .where(eq(hooks.id, hook.id));
      } else {
        await db
          .update(hooks)
          .set({
            nextRunAt: nextRun,
            updatedAt: now,
          })
          .where(eq(hooks.id, hook.id));
      }

      try {
        // Execute directly via hookManager.trigger() — this handles action execution + logging
        // Fire-and-forget for long-running actions (spawn_agent) to avoid blocking the cron loop
        hookManager.trigger(
          { type: 'schedule', data: { hookId: hook.id }, timestamp: now },
          { schedule: { cronExpression, scheduledTime: now, hookName: hook.name } },
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
