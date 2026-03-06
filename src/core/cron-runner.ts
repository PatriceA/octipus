import { getDb } from '@/db/postgres';
import { recurringTasks } from '@/db/schema/recurring-tasks';
import { eq, and, lte, sql } from 'drizzle-orm';
import { getScheduler } from './scheduler';
import { sessionRepository } from '@/db/repositories/session-repository';
import { coreLogger } from '@/utils/logger';

const CRON_INTERVAL_MS = 60_000; // Check every minute
const SESSION_CLEANUP_INTERVAL_MS = 3600_000; // Check every hour

let cronTimer: Timer | null = null;
let lastSessionCleanup = 0;

/**
 * Parse a simple cron expression and compute the next run date.
 * Supports: minute hour dayOfMonth month dayOfWeek
 * Also supports interval shorthand: *​/N (every N units)
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

async function processCronTick(): Promise<void> {
  try {
    await maybeCleanupSessions();
    const db = getDb();
    const now = new Date();

    const dueTasks = await db
      .select()
      .from(recurringTasks)
      .where(
        and(
          eq(recurringTasks.isEnabled, true),
          eq(recurringTasks.status, 'active'),
          lte(recurringTasks.nextRunAt, now),
        ),
      );

    if (dueTasks.length === 0) return;

    coreLogger.info({ count: dueTasks.length }, 'Processing due recurring tasks');
    const scheduler = getScheduler();

    for (const task of dueTasks) {
      try {
        // Schedule the task execution via the existing scheduler
        await scheduler.schedule(task.userId, task.actionType, {
          ...task.actionConfig as Record<string, unknown>,
          recurringTaskId: task.id,
        });

        // Update next run
        const nextRun = getNextCronDate(task.cronExpression, task.timezone || 'UTC');
        await db
          .update(recurringTasks)
          .set({
            lastRunAt: now,
            nextRunAt: nextRun,
            runCount: sql`run_count + 1`,
            lastError: null,
            updatedAt: now,
          })
          .where(eq(recurringTasks.id, task.id));

        coreLogger.info({ taskId: task.id, name: task.name, nextRun }, 'Recurring task triggered');
      } catch (err) {
        await db
          .update(recurringTasks)
          .set({
            lastError: (err as Error).message,
            status: 'error',
            updatedAt: now,
          })
          .where(eq(recurringTasks.id, task.id));

        coreLogger.error({ err, taskId: task.id }, 'Recurring task execution failed');
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
