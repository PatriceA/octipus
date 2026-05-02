import { randomUUID } from 'crypto';
import { Elysia, t } from 'elysia';
import { existsSync } from 'fs';
import { mkdir, unlink } from 'fs/promises';
import { extname, join, resolve } from 'path';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { getDocumentQueue } from '@/core/documents/queue';
import { scopedRepos } from '@/db/repositories/scoped';
import { isAuthenticated } from '@/security/principal';
import { apiLogger } from '@/utils/logger';

const logger = apiLogger.child({ component: 'documents-route' });

/**
 * Documents — Phase 1a multi-user conversion.
 *
 * Reads/writes go through `scopedRepos(principal).documents`. Cross-tenant
 * access is silently surfaced as 404 instead of the previous 403, which
 * stops UUID enumeration: an attacker can no longer tell whether a
 * document exists by probing IDs they don't own.
 */
export const documentRoutes = new Elysia({ prefix: '/documents' })
  .use(apiContext)

  // Upload documents
  .post('/upload', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const config = getConfig();
    const maxSize = config.workspace.maxUploadSize || 52428800;
    const documentsPath = resolve(config.workspace.documentsPath || './workspace/documents');
    const uncategorizedDir = join(documentsPath, 'uncategorized');

    // Ensure upload directory exists
    if (!existsSync(uncategorizedDir)) {
      await mkdir(uncategorizedDir, { recursive: true });
    }

    const files = Array.isArray(body.files) ? body.files : [body.files];
    const results: Array<{ id: string; filename: string; status: string }> = [];
    const docs = scopedRepos(principal).documents;

    for (const file of files) {
      if (!file || !(file instanceof Blob)) {
        continue;
      }

      // Check file size
      if (file.size > maxSize) {
        results.push({ id: '', filename: (file as File).name || 'unknown', status: `File too large (max ${Math.round(maxSize / 1048576)}MB)` });
        continue;
      }

      const originalName = (file as File).name || 'upload';
      const ext = extname(originalName) || '';
      const uniqueFilename = `${randomUUID()}${ext}`;
      const storagePath = join(uncategorizedDir, uniqueFilename);

      // Write file to disk
      const buffer = Buffer.from(await file.arrayBuffer());
      await Bun.write(storagePath, buffer);

      // Create DB record — scoped repo pins the doc to the principal.
      const doc = await docs.create({
        filename: uniqueFilename,
        originalName,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        storagePath,
        status: 'queued',
      });

      // Enqueue for processing
      getDocumentQueue().enqueue(doc.id, user.id);

      results.push({ id: doc.id, filename: originalName, status: 'queued' });
      logger.info({ documentId: doc.id, filename: originalName, size: file.size }, 'Document uploaded');
    }

    return { uploaded: results };
  }, {
    body: t.Object({
      files: t.Union([t.File(), t.Array(t.File())]),
    }),
    detail: { tags: ['documents'] },
  })

  // List documents for authenticated user
  .get('/', async ({ user, principal, query, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const category = query.category;
    const status = query.status;
    const docs = scopedRepos(principal).documents;

    let rows = category
      ? await docs.listOwnByCategory(category, limit)
      : await docs.listOwn(limit);

    // Filter by status if provided
    if (status) {
      rows = rows.filter(d => d.status === status);
    }

    return {
      documents: rows.map(d => ({
        id: d.id,
        originalName: d.originalName,
        mimeType: d.mimeType,
        size: d.size,
        category: d.category,
        status: d.status,
        summary: d.summary,
        createdAt: d.createdAt,
        processedAt: d.processedAt,
      })),
      queue: getDocumentQueue().getStatus(),
    };
  }, {
    query: t.Object({
      limit: t.Optional(t.String()),
      category: t.Optional(t.String()),
      status: t.Optional(t.String()),
    }),
    detail: { tags: ['documents'] },
  })

  // Get document details
  .get('/:id', async ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const doc = await scopedRepos(principal).documents.findById(params.id);
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    return {
      id: doc.id,
      originalName: doc.originalName,
      filename: doc.filename,
      mimeType: doc.mimeType,
      size: doc.size,
      category: doc.category,
      status: doc.status,
      ocrText: doc.ocrText,
      summary: doc.summary,
      storagePath: doc.storagePath,
      metadata: doc.metadata,
      createdAt: doc.createdAt,
      processedAt: doc.processedAt,
    };
  }, {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['documents'] },
  })

  // Delete a document
  .delete('/:id', async ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const repo = scopedRepos(principal).documents;
    const doc = await repo.findById(params.id);
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    // Remove from queue if still queued
    const queue = getDocumentQueue();
    queue.removeFromQueue(params.id);

    // Delete the file from disk
    if (doc.storagePath && existsSync(doc.storagePath)) {
      try {
        await unlink(doc.storagePath);
      } catch (err) {
        logger.warn({ err, storagePath: doc.storagePath }, 'Failed to delete file from disk');
      }
    }

    // Delete from DB — repo enforces ownership a second time.
    await repo.delete(params.id);
    logger.info({ documentId: params.id, filename: doc.originalName }, 'Document deleted');

    return { success: true };
  }, {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['documents'] },
  })

  // Cancel processing of a document
  .post('/:id/cancel', async ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const repo = scopedRepos(principal).documents;
    const doc = await repo.findById(params.id);
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    const queue = getDocumentQueue();

    if (doc.status === 'queued') {
      // Remove from queue and mark as failed/cancelled
      queue.removeFromQueue(params.id);
      await repo.updateStatus(params.id, 'failed', 'Cancelled by user');
      logger.info({ documentId: params.id }, 'Queued document cancelled');
      return { success: true, action: 'removed_from_queue' };
    }

    if (doc.status === 'processing') {
      // Can't abort mid-processing, but mark it so the user knows
      await repo.updateStatus(params.id, 'failed', 'Cancelled by user');
      logger.info({ documentId: params.id }, 'Processing document marked as cancelled');
      return { success: true, action: 'marked_cancelled' };
    }

    return { success: false, error: `Document is already ${doc.status}` };
  }, {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['documents'] },
  });
