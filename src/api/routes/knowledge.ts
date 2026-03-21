import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getFileIndexer } from '@/core/rag/indexer';
import { apiLogger } from '@/utils/logger';

const logger = apiLogger.child({ component: 'knowledge-route' });

export const knowledgeRoutes = new Elysia({ prefix: '/knowledge' })
  .use(apiContext)

  // List / browse knowledge entries (lightweight — no vectors or full content)
  .get('/', async ({ user, query, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    const sourceType = query.sourceType || undefined;

    const service = getEmbeddingService();
    const result = await service.listAll(limit, offset, sourceType);

    return {
      entries: result.entries,
      total: result.total,
      limit,
      offset,
    };
  }, {
    query: t.Object({
      limit: t.Optional(t.String()),
      offset: t.Optional(t.String()),
      sourceType: t.Optional(t.String()),
    }),
    detail: { tags: ['knowledge'] },
  })

  // Get stats
  .get('/stats', async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const service = getEmbeddingService();
    return await service.getStats();
  }, {
    detail: { tags: ['knowledge'] },
  })

  // Search knowledge base
  .post('/search', async ({ user, body, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const { query, mode = 'hybrid', limit = 10, sourceType } = body;
    const service = getEmbeddingService();

    let results;
    switch (mode) {
      case 'semantic':
        results = await service.search(query, limit, sourceType);
        break;
      case 'keyword':
        results = await service.ftsSearch(query, limit, sourceType);
        break;
      case 'hybrid':
      default:
        results = await service.hybridSearch(query, limit, sourceType);
        break;
    }

    return { results, mode, query };
  }, {
    body: t.Object({
      query: t.String(),
      mode: t.Optional(t.Union([t.Literal('hybrid'), t.Literal('semantic'), t.Literal('keyword')])),
      limit: t.Optional(t.Number()),
      sourceType: t.Optional(t.String()),
    }),
    detail: { tags: ['knowledge'] },
  })

  // Get single entry (full content)
  .get('/:id', async ({ user, params, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const service = getEmbeddingService();
    const entry = await service.readById(params.id);

    if (!entry) {
      set.status = 404;
      return { error: 'Knowledge entry not found' };
    }

    return entry;
  }, {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['knowledge'] },
  })

  // Delete single entry
  .delete('/:id', async ({ user, params, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const service = getEmbeddingService();
    const deleted = await service.deleteById(params.id);

    if (!deleted) {
      set.status = 404;
      return { error: 'Knowledge entry not found' };
    }

    logger.info({ id: params.id, userId: user.id }, 'Knowledge entry deleted');
    return { deleted: true };
  }, {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['knowledge'] },
  })

  // Cleanup stale/orphaned/duplicate entries
  .post('/cleanup', async ({ user, body, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const { maxAgeDays, minContentLength, dryRun } = body;
    const service = getEmbeddingService();

    const result = await service.cleanup({
      maxAgeDays: maxAgeDays ?? 30,
      minContentLength: minContentLength ?? 50,
      dryRun: dryRun ?? false,
    });

    logger.info({ userId: user.id, dryRun, ...result }, 'Knowledge cleanup triggered');
    return result;
  }, {
    body: t.Object({
      maxAgeDays: t.Optional(t.Number()),
      minContentLength: t.Optional(t.Number()),
      dryRun: t.Optional(t.Boolean()),
    }),
    detail: { tags: ['knowledge'] },
  })

  // Index file or directory
  .post('/index', async ({ user, body, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const { path, type = 'file', sourceType = 'document', patterns } = body;
    const indexer = getFileIndexer();
    const validSourceType = (sourceType === 'code' ? 'code' : 'document') as 'document' | 'code';

    try {
      if (type === 'directory') {
        const globPatterns = patterns ? patterns.split(',').map(p => p.trim()) : undefined;
        const result = await indexer.indexDirectory(path, globPatterns);
        logger.info({ path, filesIndexed: result.filesIndexed, userId: user.id }, 'Directory indexed');
        return result;
      } else {
        const chunks = await indexer.indexFile(path, validSourceType);
        logger.info({ path, chunks, userId: user.id }, 'File indexed');
        return { filesIndexed: 1, chunksStored: chunks, errors: [] };
      }
    } catch (err) {
      set.status = 400;
      return { error: (err as Error).message };
    }
  }, {
    body: t.Object({
      path: t.String(),
      type: t.Optional(t.Union([t.Literal('file'), t.Literal('directory')])),
      sourceType: t.Optional(t.String()),
      patterns: t.Optional(t.String()),
    }),
    detail: { tags: ['knowledge'] },
  });
