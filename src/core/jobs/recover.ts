/**
 * Boot sweep for `background_jobs`. Runs once, before any worker starts:
 * whatever the previous process left `running` is marked `interrupted`,
 * each kind repairs the rows it owns, and terminal rows past retention go.
 * `queued` rows are untouched — a worker will drain them, which is the
 * whole point of a queue that survives a restart.
 */
import { backgroundJobRepository, INTERRUPTED_ERROR } from '@/db/repositories/background-job-repository';
import { documentRepository } from '@/db/repositories/document-repository';
import type { BackgroundJob } from '@/db/schema/background-jobs';
import { coreLogger } from '@/utils/logger';

export interface RecoveryReport {
  interrupted: number;
  pruned: number;
}

/**
 * A document whose job died mid-flight is still `processing` in its own
 * table. Leaving it there is the same lie one table over; `failed` with a
 * reason is something the user can act on (re-upload).
 */
async function repairDocument(job: BackgroundJob): Promise<void> {
  const documentId = typeof job.payload.documentId === 'string' ? job.payload.documentId : null;
  if (!documentId) return;
  const doc = await documentRepository.findById(documentId);
  if (doc && (doc.status === 'processing' || doc.status === 'queued')) {
    await documentRepository.updateStatus(documentId, 'failed', INTERRUPTED_ERROR);
  }
}

export async function recoverBackgroundJobs(now = new Date()): Promise<RecoveryReport> {
  const interrupted = await backgroundJobRepository.sweepInterrupted(now);
  for (const job of interrupted) {
    try {
      if (job.kind === 'document') await repairDocument(job);
    } catch (err) {
      coreLogger.warn({ jobId: job.id, kind: job.kind, err: (err as Error).message }, 'background jobs: repair after interrupt failed');
    }
  }
  const pruned = await backgroundJobRepository.pruneFinished(now);
  return { interrupted: interrupted.length, pruned };
}
