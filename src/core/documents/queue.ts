import { EventEmitter } from 'events';
import { documentProcessor } from './processor';
import { coreLogger } from '@/utils/logger';

export interface QueueEvents {
  enqueued: (documentId: string, userId?: string) => void;
  processing: (documentId: string, userId?: string) => void;
  completed: (documentId: string, userId?: string) => void;
  failed: (documentId: string, error: string, userId?: string) => void;
}

interface QueueItem {
  documentId: string;
  userId?: string;
}

export class DocumentQueue extends EventEmitter {
  private queue: QueueItem[] = [];
  private processing = false;
  private processingUserId?: string;
  private logger = coreLogger.child({ component: 'document-queue' });

  /**
   * Add a document to the processing queue.
   */
  enqueue(documentId: string, userId?: string): void {
    this.queue.push({ documentId, userId });
    this.logger.info({ documentId, queueLength: this.queue.length }, 'Document enqueued');
    this.emit('enqueued', documentId, userId);
    this.processNext();
  }

  /**
   * Get current queue status.
   */
  getStatus(): { queueLength: number; isProcessing: boolean } {
    return {
      queueLength: this.queue.length,
      isProcessing: this.processing,
    };
  }

  /**
   * Process the next item in the queue (concurrency=1).
   */
  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const item = this.queue.shift()!;
    const { documentId, userId } = item;
    this.processingUserId = userId;

    this.logger.info({ documentId, remaining: this.queue.length }, 'Processing document');
    this.emit('processing', documentId, userId);

    try {
      await documentProcessor.process(documentId);
      this.emit('completed', documentId, userId);
      this.logger.info({ documentId }, 'Document processing completed');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit('failed', documentId, errorMsg, userId);
      this.logger.error({ err, documentId }, 'Document processing failed');
    } finally {
      this.processing = false;
      this.processingUserId = undefined;
      // Process next item if queue is not empty
      if (this.queue.length > 0) {
        this.processNext();
      }
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
