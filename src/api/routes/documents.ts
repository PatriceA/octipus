import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { documentRepository } from '@/db/repositories/document-repository';
import { getDocumentQueue } from '@/core/documents/queue';
import { getConfig } from '@/config';
import { resolve, join, extname } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { apiLogger } from '@/utils/logger';

const logger = apiLogger.child({ component: 'documents-route' });

export const documentRoutes = new Elysia({ prefix: '/documents' })
  .use(apiContext)

  // Upload documents
  .post('/upload', async ({ user, body, set }) => {
    if (!user) {
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

      // Create DB record
      const doc = await documentRepository.create({
        userId: user.id,
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
  .get('/', async ({ user, query, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const category = query.category;
    const status = query.status;

    let docs;
    if (category) {
      docs = await documentRepository.findByUserAndCategory(user.id, category, limit);
    } else {
      docs = await documentRepository.findByUser(user.id, limit);
    }

    // Filter by status if provided
    if (status) {
      docs = docs.filter(d => d.status === status);
    }

    return {
      documents: docs.map(d => ({
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
  .get('/:id', async ({ user, params, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const doc = await documentRepository.findById(params.id);
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    // Ensure user owns the document (or is admin)
    if (doc.userId !== user.id && !user.isAdmin) {
      set.status = 403;
      return { error: 'Access denied' };
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
  });
