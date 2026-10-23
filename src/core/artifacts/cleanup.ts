/**
 * Hourly maintenance: cap snapshot history per source, purge soft-deleted
 * artifacts >30d, drop expired share links. Runs as a recurring scheduler
 * task type so it lives on the same primitive as refresh.
 */

import { isJobOn } from '@/core/modules/registry';
import { deleteArtifactBundles, KEEP_VERSION_BUNDLES, pruneArtifactBundles } from './bundler';
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import { artifactDataSources } from '@/db/schema/artifact-data-sources';
import { artifacts } from '@/db/schema/artifacts';
import { getDb } from '@/db/postgres';
import { getScheduler, type ScheduledTask } from '@/core/scheduler';
import { rawStore } from '@/db/cache';
import { generateId } from '@/utils/crypto';
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

/**
 * Each boot starts a fresh hourly chain. With external storage the queue
 * outlives the process, so the previous boot's chain is still queued; only the
 * chain named here re-arms, and older ones end the next time they fire instead
 * of piling up one extra cleanup chain per restart. A superseded task still
 * runs its cleanup before ending: a server restarting more often than hourly
 * would otherwise supersede every task before it ran and never clean up.
 */
const CLEANUP_CHAIN_KEY = 'artifact:cleanup:chain';

interface CleanupPayload {
  chain?: string;
}

export async function handleArtifactCleanupTask(task: ScheduledTask): Promise<void> {
  const chain = (task.payload as CleanupPayload | undefined)?.chain;
  // Off deletes nothing (docs/MODULES.md): the chain waits for the module.
  if (isJobOn('artifacts-cleanup')) await runArtifactCleanup();
  const current = await rawStore().get(CLEANUP_CHAIN_KEY);
  if (current && chain !== current) {
    coreLogger.info({ chain, current }, 'artifact.cleanup.superseded_chain — not requeueing');
    return;
  }
  await scheduleCleanup(chain);
}

export function registerArtifactCleanupHandler(): void {
  getScheduler().registerHandler(ARTIFACT_CLEANUP_TASK, handleArtifactCleanupTask);
}

async function scheduleCleanup(chain: string | undefined): Promise<void> {
  await getScheduler().schedule(
    'artifact:cleanup',
    ARTIFACT_CLEANUP_TASK,
    { chain } satisfies CleanupPayload,
    { delayMs: HOUR_MS },
  );
}

/** First-run kickoff — call once at boot to seed the recurring task. */
export async function bootstrapArtifactCleanup(): Promise<void> {
  const chain = generateId();
  await rawStore().set(CLEANUP_CHAIN_KEY, chain);
  await scheduleCleanup(chain);
}
