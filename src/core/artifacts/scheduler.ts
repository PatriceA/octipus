/**
 * Recurring refresh wiring on top of the one-shot Scheduler. Each refresh
 * task re-schedules itself; cancellation is achieved by deleting the source
 * (the next tick observes the missing source and exits without re-queueing).
 *
 * Wake-gate prevents idle artifacts from grinding on tools forever — if no
 * one has loaded the artifact in `max(2 * refreshSeconds, 1h)`, skip the
 * refresh.
 */

import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import { getScheduler, type ScheduledTask } from '@/core/scheduler';
import { refreshSource } from './refresh';
import { coreLogger } from '@/utils/logger';

export const ARTIFACT_REFRESH_TASK = 'artifact:refresh';

interface RefreshPayload {
  sourceId: string;
}

/** In-memory last-view timestamps. Replaced by Redis-backed storage in step 13. */
const lastViewedAt = new Map<string, number>();

export function recordArtifactView(artifactId: string): void {
  lastViewedAt.set(artifactId, Date.now());
}

export function getLastViewMs(artifactId: string): number | null {
  return lastViewedAt.get(artifactId) ?? null;
}

/** Schedule the first refresh for a source (or no-op if already scheduled). */
export async function scheduleArtifactRefresh(sourceId: string): Promise<void> {
  const source = await artifactsRepository.getSource(sourceId);
  if (!source) return;
  const scheduler = getScheduler();
  await scheduler.schedule(
    `artifact:${source.artifactId}`,
    ARTIFACT_REFRESH_TASK,
    { sourceId } satisfies RefreshPayload,
    { delayMs: source.refreshSeconds * 1000 },
  );
}

/** Handler — registered once at boot. Runs the refresh, then re-queues. */
export async function handleArtifactRefreshTask(task: ScheduledTask): Promise<void> {
  const { sourceId } = task.payload as unknown as RefreshPayload;
  const source = await artifactsRepository.getSource(sourceId);
  if (!source) {
    coreLogger.info({ sourceId }, 'artifact.scheduler.source_gone — not requeueing');
    return;
  }

  // Wake-gate: skip when no one is watching.
  const lastView = getLastViewMs(source.artifactId);
  const idleThresholdMs = Math.max(2 * source.refreshSeconds * 1000, 60 * 60 * 1000);
  if (lastView == null || Date.now() - lastView > idleThresholdMs) {
    coreLogger.debug({ sourceId, artifactId: source.artifactId }, 'artifact.scheduler.skip_idle');
  } else {
    await refreshSource(sourceId);
  }

  // Re-queue for the next interval.
  const scheduler = getScheduler();
  await scheduler.schedule(
    `artifact:${source.artifactId}`,
    ARTIFACT_REFRESH_TASK,
    { sourceId } satisfies RefreshPayload,
    { delayMs: source.refreshSeconds * 1000 },
  );
}

/** Wire the handler. Call once at boot after Scheduler init. */
export function registerArtifactRefreshHandler(): void {
  getScheduler().registerHandler(ARTIFACT_REFRESH_TASK, handleArtifactRefreshTask);
}
