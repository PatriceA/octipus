/**
 * One file into the documents of a scope: written under the scope's upload
 * directory, recorded through its document repository, and queued for
 * processing (OCR, category, summary). The way in for uploads, scan folders
 * (docs/SCAN-FOLDERS.md) and mail attachments filed by a mail account.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { getConfig } from '@/config';
import type { ContentRepos } from '@/db/repositories/content';
import { writeFileAt } from '@/utils/fs-file';
import { coreLogger } from '@/utils/logger';
import { getDocumentQueue } from './queue';

export interface IngestInput {
  buffer: Buffer;
  originalName: string;
  mimeType?: string;
  /** Where the file came from (`{ source: 'scan_folder', … }`), kept on the document. */
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  id: string;
  filename: string;
  status: 'queued' | 'failed';
  error?: string;
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestError';
  }
}

/** The largest file one document may be. */
export function maxDocumentSize(): number {
  return getConfig().workspace.maxUploadSize || 52428800;
}

/**
 * Store and queue one file. A write refused by the scope's role throws
 * (`SpaceError`); a file over the size limit throws `IngestError`. A file
 * stored but not queued comes back `failed` with why, on the document too.
 */
export async function ingestDocument(repos: ContentRepos, input: IngestInput): Promise<IngestResult> {
  repos.can('write');
  const maxSize = maxDocumentSize();
  if (input.buffer.length > maxSize) throw new IngestError(`File too large (max ${Math.round(maxSize / 1048576)}MB)`);
  const dir = repos.documents.uploadDirectory();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const originalName = input.originalName.replace(/[\u0000-\u001f/\\]+/g, '_').slice(0, 255) || 'upload';
  const uniqueFilename = `${randomUUID()}${extname(originalName).slice(0, 20)}`;
  const storagePath = join(dir, uniqueFilename);
  await writeFileAt(storagePath, input.buffer);

  const doc = await repos.documents.create({
    filename: uniqueFilename,
    originalName,
    mimeType: input.mimeType || 'application/octet-stream',
    size: input.buffer.length,
    storagePath,
    status: 'queued',
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });

  // Enqueue for processing: a row, so the file survives a restart. If the
  // row cannot be written the document would sit at `queued` with nothing to
  // pick it up, so say so on the document and to the caller.
  try {
    await getDocumentQueue().enqueue(doc.id, repos.principal.userId, { title: originalName, workspaceId: doc.workspaceId });
  } catch (err) {
    const reason = `Could not queue for processing: ${(err as Error).message}`;
    coreLogger.error({ err, documentId: doc.id }, 'Document stored but not queued');
    await repos.documents.updateStatus(doc.id, 'failed', reason).catch(() => undefined);
    return { id: doc.id, filename: originalName, status: 'failed', error: reason };
  }
  return { id: doc.id, filename: originalName, status: 'queued' };
}
