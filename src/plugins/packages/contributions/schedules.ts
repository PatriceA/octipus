/**
 * Schedules of plugin packages (docs/PLUGIN-PACKAGES.md#schedules): the cron
 * runner calls `runDuePluginSchedules` every tick, and each bound schedule
 * whose cron expression matches a minute since the last tick calls its tool.
 *
 * Who it runs as: the install — the admin who installed (or last upgraded)
 * the package (`installedBy`), unattended. So the tool's declared effect
 * decides as for any unattended run: a `read` runs; a `write` runs only where
 * that admin's permission rules allow it (default ASK, and with nobody to
 * ask the call is refused); an `external` one is always refused. A package
 * whose installer is gone, or no longer an active admin, runs no schedule.
 *
 * Every instance runs the loop; a minute of a schedule is claimed in the
 * shared store before it runs, so it runs once. At most
 * `MAX_CONCURRENT_RUNS` calls run at a time, and a schedule whose previous
 * run is still going skips its turn. A failure is logged and recorded on the
 * package's row.
 */
import type { PluginScheduleDecl } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';
import { actingContext, callPluginTool } from './call';
import { type CronSpec, cronMatches, parseCron } from './cron';
import { recordRun } from './status';

export const MAX_CONCURRENT_RUNS = 4;
/** How far back a late tick still fires a missed minute. */
const CATCH_UP_MINUTES = 5;
const CLAIM_TTL_SECONDS = 2 * 24 * 3600;

interface BoundSchedule {
  pkg: string;
  decl: PluginScheduleDecl;
  spec: CronSpec;
  /** The admin it runs as; null when the installer is gone. */
  actor: string | null;
}

const schedules = new Map<string, BoundSchedule>();
const running = new Set<string>();
let lastTickMinute: number | null = null;

const keyOf = (pkg: string, id: string) => `${pkg}\n${id}`;

/** Bind one schedule; its disposer unbinds it. */
export function bindSchedule(pkg: string, decl: PluginScheduleDecl, actor: string | null): () => void {
  const key = keyOf(pkg, decl.id);
  const entry: BoundSchedule = { pkg, decl, spec: parseCron(decl.cron), actor };
  schedules.set(key, entry);
  return () => { if (schedules.get(key) === entry) schedules.delete(key); };
}

async function claim(pkg: string, id: string, minute: Date): Promise<boolean> {
  try {
    const { getStorageProvider } = await import('@/db/storage');
    return await getStorageProvider().setRawIfAbsent(`plugin-schedule:${pkg}:${id}:${minute.toISOString()}`, '1', CLAIM_TTL_SECONDS);
  } catch (err) {
    // No shared store (a single process in tests): this process is the only runner.
    coreLogger.debug({ err, pkg, id }, 'Plugin schedule claim without a store; running locally');
    return true;
  }
}

/** Run one schedule now, as its actor. Resolves when the call is done; never throws. */
export async function runSchedule(entry: BoundSchedule): Promise<void> {
  const runKey = `schedule:${entry.decl.id}`;
  if (!entry.actor) {
    await recordRun(entry.pkg, runKey, false, 'Not run: the admin who installed the package no longer exists; reinstall or upgrade it as an admin');
    return;
  }
  try {
    // Read on every run: an installer who is no longer an active admin stops the schedules.
    const { isAdminInDatabase } = await import('@/core/gateway/commands');
    if (!(await isAdminInDatabase(entry.actor))) {
      await recordRun(entry.pkg, runKey, false, 'Not run: the admin who installed the package is no longer an active admin; reinstall or upgrade it as an admin');
      return;
    }
    const context = await actingContext({ pkg: entry.pkg, userId: entry.actor, kind: 'schedule', attended: false });
    const { text, isError } = await callPluginTool(entry.pkg, entry.decl.tool, entry.decl.input ?? {}, context);
    if (isError) {
      coreLogger.warn({ pkg: entry.pkg, schedule: entry.decl.id, text }, 'Plugin schedule: the tool reported an error');
      await recordRun(entry.pkg, runKey, false, text || 'The tool reported an error');
    } else {
      await recordRun(entry.pkg, runKey, true);
    }
  } catch (err) {
    coreLogger.warn({ err, pkg: entry.pkg, schedule: entry.decl.id }, 'Plugin schedule failed');
    await recordRun(entry.pkg, runKey, false, (err as Error).message);
  }
}

/**
 * Start every bound schedule due in a minute since the last tick (at most
 * `CATCH_UP_MINUTES` back), claimed once across instances. Not awaited by the
 * cron runner; returns the runs started, for tests.
 */
export async function runDuePluginSchedules(now: Date): Promise<Array<Promise<void>>> {
  const current = Math.floor(now.getTime() / 60_000);
  const from = lastTickMinute === null ? current : Math.max(lastTickMinute + 1, current - CATCH_UP_MINUTES + 1);
  lastTickMinute = current;
  const started: Array<Promise<void>> = [];
  for (const [key, entry] of schedules) {
    for (let m = from; m <= current; m++) {
      const minute = new Date(m * 60_000);
      if (!cronMatches(entry.spec, minute)) continue;
      if (running.has(key)) {
        await recordRun(entry.pkg, `schedule:${entry.decl.id}`, false, `Skipped ${minute.toISOString()}: the previous run is still going`);
        continue;
      }
      if (running.size >= MAX_CONCURRENT_RUNS) {
        await recordRun(entry.pkg, `schedule:${entry.decl.id}`, false, `Skipped ${minute.toISOString()}: ${MAX_CONCURRENT_RUNS} plugin schedules already running`);
        continue;
      }
      if (!(await claim(entry.pkg, entry.decl.id, minute))) continue;
      running.add(key);
      started.push(runSchedule(entry).finally(() => running.delete(key)));
    }
  }
  return started;
}

/** Forget the last tick (tests). */
export function _resetScheduleClockForTesting(): void {
  lastTickMinute = null;
}
