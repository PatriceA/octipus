import { EventEmitter } from 'events';
import { backgroundJobRepository } from '@/db/repositories/background-job-repository';
import { documentRepository } from '@/db/repositories/document-repository';
import type { BackgroundJob } from '@/db/schema/background-jobs';
import { coreLogger } from '@/utils/logger';
import { documentProcessor } from './processor';

export interface QueueEvents {
  enqueued: (documentId: string, userId?: string) => void;
  processing: (documentId: string, userId?: string) => void;
  completed: (documentId: string, userId?: string) => void;
  failed: (documentId: string, error: string, userId?: string) => void;
}

/** What the caller already knows about the document, so enqueue is one insert rather than a read and an insert. */
export interface EnqueueHint {
  title?: string;
  workspaceId?: string | null;
}

/** How long to wait before trying the queue again after the database refused a claim. */
const RETRY_AFTER_ERROR_MS = 15_000;

export interface QueueStatus {
  queueLength: number;
  isProcessing: boolean;
  currentDocumentId?: string;
}

/**
 * Document processing queue: one document at a time per process, in upload
 * order, with events for the UI.
 *
 * The queue itself is the `background_jobs` table (`kind = 'document'`), not
 * an array in this process. An upload used to be lost the moment the process
 * restarted — the document stayed `queued` in its own table with nothing that
 * would ever pick it up. Now `enqueue` writes a row and the worker claims the
 * oldest `queued` row with a lock, so a restart drains what it finds (`resume`
 * at boot), a second process cannot run the same document twice, and a run
 * the restart killed is marked `interrupted` by the boot sweep rather than
 * looking live forever.
 *
 * Events stay in-process: they are how THIS process's websocket clients see
 * progress, and a job another process ran was never this process's to narrate.
 */
export class DocumentQueue extends EventEmitter {
  private draining = false;
  /** Set by `kick` while a drain is running, so an enqueue that lands between the last claim and the loop exiting is not lost. */
  private wake = false;
  private current?: { jobId: string; documentId: string };
  private logger = coreLogger.child({ component: 'document-queue' });

  /**
   * Add a document to the processing queue. Resolves once the row exists —
   * from then on the upload survives a restart. Throws if the row could not
   * be written; the caller owns the document and decides what to tell the
   * user.
   */
  async enqueue(documentId: string, userId: string, hint: EnqueueHint = {}): Promise<void> {
    let title = hint.title;
    let workspaceId = hint.workspaceId;
    if (title === undefined || workspaceId === undefined) {
      const doc = await documentRepository.findById(documentId);
      title ??= doc?.originalName;
      workspaceId ??= doc?.workspaceId;
    }
    await backgroundJobRepository.create({
      kind: 'document',
      userId,
      workspaceId: workspaceId ?? null,
      title: title ?? documentId,
      payload: { documentId },
    });
    this.logger.info({ documentId }, 'Document enqueued');
    this.safeEmit('enqueued', documentId, userId);
    this.kick();
  }

  /**
   * Remove a queued document (not yet processing). Returns true if a queued
   * row was found and removed.
   */
  async removeFromQueue(documentId: string): Promise<boolean> {
    const removed = await backgroundJobRepository.dropQueued('document', { documentId });
    if (removed > 0) this.logger.info({ documentId }, 'Document removed from queue');
    return removed > 0;
  }

  /** Is this process working on the document right now. */
  isProcessingDocument(documentId: string): boolean {
    return this.current?.documentId === documentId;
  }

  /** Queue depth across every process; "processing" as seen from this one. */
  async getStatus(): Promise<QueueStatus> {
    const counts = await backgroundJobRepository.countByStatus('document');
    return {
      queueLength: counts.queued,
      isProcessing: this.current !== undefined,
      currentDocumentId: this.current?.documentId,
    };
  }

  /**
   * Start draining whatever is queued. Called at boot after the sweep, and
   * harmless at any other time: an idle queue returns at once.
   */
  resume(): void {
    this.kick();
  }

  private kick(): void {
    this.wake = true;
    if (this.draining) return;
    this.draining = true;
    void this.drain().finally(() => {
      this.draining = false;
    });
  }

  /**
   * Emit without letting a listener's bug become the queue's: a throwing
   * websocket or channel handler must not leave a job `running` and the
   * drain loop dead.
   */
  private safeEmit(event: keyof QueueEvents, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (err) {
      this.logger.error({ err, event }, 'Document queue listener threw');
    }
  }

  private async drain(): Promise<void> {
    while (this.wake) {
      this.wake = false;
      for (;;) {
        let job: BackgroundJob | null;
        try {
          job = await backgroundJobRepository.claimNext('document');
        } catch (err) {
          // The rows are still there; only this attempt failed. Come back
          // rather than leaving the queue to wait for the next upload.
          this.logger.error({ err, retryInMs: RETRY_AFTER_ERROR_MS }, 'Could not claim the next document job');
          setTimeout(() => this.kick(), RETRY_AFTER_ERROR_MS).unref();
          return;
        }
        if (!job) break;
        await this.run(job);
      }
    }
  }

  /** Process one claimed job (concurrency=1 in this process). */
  private async run(job: BackgroundJob): Promise<void> {
    const documentId = typeof job.payload.documentId === 'string' ? job.payload.documentId : '';
    const userId = job.userId;
    this.current = { jobId: job.id, documentId };
    try {
      this.logger.info({ documentId, jobId: job.id }, 'Processing document');
      this.safeEmit('processing', documentId, userId);
      if (!documentId) throw new Error('document job has no documentId');
      await documentProcessor.process(documentId);
      // The processor records its own outcome on the document and does not
      // throw; read it back so a failed extraction is a failed job, not a
      // completed one with a red document behind it.
      const doc = await documentRepository.findById(documentId);
      if (!doc) {
        // Deleted while it ran: the user's doing, not a failure to report.
        await backgroundJobRepository.finish(job.id, { status: 'cancelled', error: 'Document deleted during processing' });
        this.logger.info({ documentId }, 'Document deleted during processing');
        return;
      }
      if (doc.status === 'failed') {
        throw new Error(String((doc.metadata as { error?: unknown } | null)?.error ?? 'Document processing failed'));
      }
      const closed = await backgroundJobRepository.finish(job.id, { status: 'done', resultRef: documentId });
      if (!closed) this.logger.warn({ documentId, jobId: job.id }, 'Document finished but its job was no longer running (swept by a restart?)');
      this.safeEmit('completed', documentId, userId);
      this.logger.info({ documentId }, 'Document processing completed');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await backgroundJobRepository
        .finish(job.id, { status: 'error', error: errorMsg })
        .catch((e: unknown) => this.logger.error({ err: e, jobId: job.id }, 'Could not record document job failure'));
      this.safeEmit('failed', documentId, errorMsg, userId);
      this.logger.error({ err, documentId }, 'Document processing failed');
    } finally {
      this.current = undefined;
    }
  }
}

// Singleton instance
let documentQueue: DocumentQueue | null = null;

export function getDocumentQueue(): DocumentQueue {
  if (!documentQueue) {
    documentQueue = new DocumentQueue();
  }
  return documentQueue;
}
