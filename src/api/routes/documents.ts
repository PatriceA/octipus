import { Elysia, t } from '@/api/http';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { apiContext } from '@/api/context';
import { ingestDocument, maxDocumentSize } from '@/core/documents/ingest';
import { getDocumentQueue } from '@/core/documents/queue';
import { contentRepos } from '@/db/repositories/content';
import { isAuthenticated } from '@/security/principal';
import { isProtectionLevel } from '@/shared/protection';
import { apiLogger } from '@/utils/logger';
import { fileAt } from '@/utils/fs-file';

const logger = apiLogger.child({ component: 'documents-route' });

/**
 * Documents — Phase 1a multi-user conversion.
 *
 * Reads/writes go through `contentRepos(principal).documents`. Cross-tenant
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

    const repos = contentRepos(principal);
    // In a space, uploading is a write; refuse before anything reaches disk.
    repos.can('write');
    const maxSize = maxDocumentSize();
    const files = Array.isArray(body.files) ? body.files : [body.files];
    // A level for the whole upload (docs/PROTECTION-LEVELS.md); absent: unclear.
    const level = body.protectionLevel ? Number(body.protectionLevel) : null;
    if (level !== null && !isProtectionLevel(level)) { set.status = 400; return { error: 'protectionLevel is 1, 2, 3 or 4' }; }
    const results: Array<{ id: string; filename: string; status: string; error?: string }> = [];

    for (const file of files) {
      if (!file || !(file instanceof Blob)) {
        continue;
      }

      // Check file size before reading it
      if (file.size > maxSize) {
        results.push({ id: '', filename: (file as File).name || 'unknown', status: `File too large (max ${Math.round(maxSize / 1048576)}MB)` });
        continue;
      }

      const originalName = (file as File).name || 'upload';
      const result = await ingestDocument(repos, {
        buffer: Buffer.from(await file.arrayBuffer()),
        originalName,
        mimeType: file.type || 'application/octet-stream',
        protectionLevel: level,
      });
      results.push(result.error ? result : { id: result.id, filename: result.filename, status: result.status });
      if (!result.error) logger.info({ documentId: result.id, filename: originalName, size: file.size }, 'Document uploaded');
    }

    return { uploaded: results };
  }, {
    body: t.Object({
      files: t.Union([t.File(), t.Array(t.File())]),
      protectionLevel: t.Optional(t.String({ pattern: '^[1-4]$' })),
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
    const docs = contentRepos(principal).documents;

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
        protectionLevel: d.protectionLevel,
        summary: d.summary,
        createdAt: d.createdAt,
        processedAt: d.processedAt,
      })),
      queue: await getDocumentQueue().getStatus(),
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

    const doc = await contentRepos(principal).documents.findById(params.id);
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

  // Stream the original uploaded file (for in-browser preview / download).
  // Uses scopedRepos so cross-tenant access surfaces as 404, matching the
  // rest of this route file.
  .get('/:id/raw', async ({ user, principal, params, query, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const doc = await contentRepos(principal).documents.findById(params.id);
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    if (!doc.storagePath || !existsSync(doc.storagePath)) {
      set.status = 410;
      return { error: 'File no longer available on disk' };
    }

    const file = fileAt(doc.storagePath);
    const disposition = query.download === '1' ? 'attachment' : 'inline';
    // Filename* uses RFC 5987 encoding so non-ASCII filenames survive
    const encoded = encodeURIComponent(doc.originalName);
    set.headers['Content-Type'] = doc.mimeType || 'application/octet-stream';
    set.headers['Content-Disposition'] = `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`;
    set.headers['Cache-Control'] = 'private, max-age=60';
    return file;
  }, {
    params: t.Object({ id: t.String() }),
    query: t.Object({ download: t.Optional(t.String()) }),
    detail: { tags: ['documents'] },
  })

  // Delete a document
  .delete('/:id', async ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const repo = contentRepos(principal).documents;
    const doc = await repo.findById(params.id);
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    // Remove from queue if still queued
    await getDocumentQueue().removeFromQueue(params.id);

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

    const repo = contentRepos(principal).documents;
    const doc = await repo.findById(params.id);
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    const queue = getDocumentQueue();

    if (doc.status === 'queued') {
      // Remove from queue and mark as failed/cancelled
      await queue.removeFromQueue(params.id);
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
