/**
 * Hourly maintenance: cap snapshot history per source, purge soft-deleted
 * artifacts >30d, drop expired share links. Runs as a recurring scheduler
 * task type so it lives on the same primitive as refresh.
 */

import { deleteArtifactBundles, KEEP_VERSION_BUNDLES, pruneArtifactBundles } from './bundler';
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import { artifactDataSources } from '@/db/schema/artifact-data-sources';
import { artifacts } from '@/db/schema/artifacts';
import { getDb } from '@/db/postgres';
import { getScheduler, type ScheduledTask } from '@/core/scheduler';
import { coreLogger } from '@/utils/logger';

export const ARTIFACT_CLEANUP_TASK = 'artifact:cleanup';
const HOUR_MS = 60 * 60 * 1000;
const SNAPSHOT_RETENTION = 50;
const SOFT_DELETE_TTL_MS = 30 * 24 * HOUR_MS;

export interface CleanupReport {
  prunedSnapshots: number;
  purgedArtifacts: number;
  expiredShareLinks: number;
  /** Superseded version bundles removed from disk. */
  prunedBundles: number;
}

export async function runArtifactCleanup(): Promise<CleanupReport> {
  const db = getDb();
  const sources = await db.select({ id: artifactDataSources.id }).from(artifactDataSources);
  let prunedSnapshots = 0;
  for (const s of sources) {
    prunedSnapshots += await artifactsRepository.pruneSnapshots(s.id, SNAPSHOT_RETENTION);
  }

  const purgedIds = await artifactsRepository.purgeSoftDeleted(
    new Date(Date.now() - SOFT_DELETE_TTL_MS),
  );
  // The row is gone; the built JS on disk is not, and nothing else references it.
  for (const id of purgedIds) await deleteArtifactBundles(id);
  const purgedArtifacts = purgedIds.length;
  const expiredShareLinks = await artifactsRepository.deleteExpiredShareLinks(new Date());

  // Every edit mints a version directory under the bundles root and version
  // rows are never pruned, so cap what each surviving artifact keeps.
  let prunedBundles = 0;
  const live = await db
    .select({ id: artifacts.id, currentVersionId: artifacts.currentVersionId })
    .from(artifacts);
  for (const a of live) {
    // listVersions is newest-first by created_at — the DB, not the filesystem,
    // decides which versions are recent.
    const recent = await artifactsRepository.listVersions(a.id, KEEP_VERSION_BUNDLES);
    const keep = new Set(recent.map((v) => v.id));
    if (a.currentVersionId) keep.add(a.currentVersionId);
    prunedBundles += await pruneArtifactBundles(a.id, keep);
  }

  coreLogger.info(
    { prunedSnapshots, purgedArtifacts, expiredShareLinks, prunedBundles },
    'artifact.cleanup.done',
  );
  return { prunedSnapshots, purgedArtifacts, expiredShareLinks, prunedBundles };
}

export async function handleArtifactCleanupTask(_task: ScheduledTask): Promise<void> {
  await runArtifactCleanup();
  await getScheduler().schedule(
    'artifact:cleanup',
    ARTIFACT_CLEANUP_TASK,
    {},
    { delayMs: HOUR_MS },
  );
}

export function registerArtifactCleanupHandler(): void {
  getScheduler().registerHandler(ARTIFACT_CLEANUP_TASK, handleArtifactCleanupTask);
}

/** First-run kickoff — call once at boot to seed the recurring task. */
export async function bootstrapArtifactCleanup(): Promise<void> {
  await getScheduler().schedule(
    'artifact:cleanup',
    ARTIFACT_CLEANUP_TASK,
    {},
    { delayMs: HOUR_MS },
  );
}
