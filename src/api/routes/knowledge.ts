import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { type getKBReadiness, isKBReady, kbNotReadyResponse, runKBSelfCheck } from '@/core/rag/health';
import { getFileIndexer } from '@/core/rag/indexer';
import { apiLogger } from '@/utils/logger';

const logger = apiLogger.child({ component: 'knowledge-route' });

/**
 * Guard used on any endpoint that needs a functioning embedding+vector path.
 * Returns a 503 body if KB is not ready. Listing/stats/delete/read do NOT
 * need this — they only touch the DB and should keep working so the user can
 * see what's there and clean up.
 *
 * `set` is the Elysia set object; we only assign its `status`. Typed loosely
 * because Elysia's status type is a union with string literals.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureKBReady(set: any): { error: string; kb: ReturnType<typeof getKBReadiness> } | null {
  if (isKBReady()) return null;
  set.status = 503;
  const body = kbNotReadyResponse();
  logger.warn({ kb: body.kb }, 'KB endpoint rejected with 503 — KB not ready');
  return body;
}

export const knowledgeRoutes = new Elysia({ prefix: '/knowledge' })
  .use(apiContext)

  // Readiness endpoint — lets the web UI show a clear banner
  .get('/readiness', async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    // Re-run the self-check on demand so the UI sees fresh state after
    // the user fixes model mapping or starts Ollama.
    const report = await runKBSelfCheck();
    if (!report.ready) set.status = 503;
    return report;
  }, {
    detail: { tags: ['knowledge'] },
  })

  // List / browse knowledge entries (lightweight — no vectors or full content)
  .get('/', async ({ user, query, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    const sourceType = query.sourceType || undefined;

    try {
      const service = getEmbeddingService();
      const result = await service.listAll(limit, offset, sourceType);
      return {
        entries: result.entries,
        total: result.total,
        limit,
        offset,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message, userId: user.id }, 'Knowledge list failed');
      set.status = 500;
      return { error: `Failed to list knowledge entries: ${message}` };
    }
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

    try {
      const service = getEmbeddingService();
      return await service.getStats();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message, userId: user.id }, 'Knowledge stats failed');
      set.status = 500;
      return { error: `Failed to compute knowledge stats: ${message}` };
    }
  }, {
    detail: { tags: ['knowledge'] },
  })

  // Search knowledge base
  .post('/search', async ({ user, body, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    // Search needs the embedding provider for semantic/hybrid modes.
    // For keyword-only search we could technically run without it, but we
    // still want a loud signal — gate all search behind the self-check.
    const notReady = ensureKBReady(set);
    if (notReady) return notReady;

    const { query, mode = 'hybrid', limit = 10, sourceType } = body;
    const service = getEmbeddingService();

    try {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message, mode, query, userId: user.id }, 'Knowledge search failed');
      set.status = 500;
      return { error: `Search failed: ${message}` };
    }
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

    try {
      const result = await service.cleanup({
        maxAgeDays: maxAgeDays ?? 30,
        minContentLength: minContentLength ?? 50,
        dryRun: dryRun ?? false,
      });
      logger.info({ userId: user.id, dryRun, ...result }, 'Knowledge cleanup triggered');
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message, userId: user.id }, 'Knowledge cleanup failed');
      set.status = 500;
      return { error: `Cleanup failed: ${message}` };
    }
  }, {
    body: t.Object({
      maxAgeDays: t.Optional(t.Number()),
      minContentLength: t.Optional(t.Number()),
      dryRun: t.Optional(t.Boolean()),
    }),
    detail: { tags: ['knowledge'] },
  })

  // Cleanup history
  .get('/cleanup-history', async ({ user, query, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const limit = query.limit ? parseInt(query.limit, 10) : 20;
    const service = getEmbeddingService();
    const history = await service.getCleanupHistory(limit);

    return { history };
  }, {
    query: t.Object({
      limit: t.Optional(t.String()),
    }),
    detail: { tags: ['knowledge'] },
  })

  // Index file or directory — THE WRITE PATH. Gate on KB readiness + 5xx on failure.
  .post('/index', async ({ user, body, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }

    const notReady = ensureKBReady(set);
    if (notReady) return notReady;

    const { path, type = 'file', sourceType = 'document', patterns } = body;
    const indexer = getFileIndexer();
    const validSourceType = (sourceType === 'code' ? 'code' : 'document') as 'document' | 'code';

    try {
      if (type === 'directory') {
        const globPatterns = patterns ? patterns.split(',').map(p => p.trim()) : undefined;
        const result = await indexer.indexDirectory(path, globPatterns);
        logger.info({ path, filesIndexed: result.filesIndexed, chunksStored: result.chunksStored, errors: result.errors.length, userId: user.id }, 'Directory indexed');
        // If every file failed, 5xx so the UI shows red, not a happy green check.
        if (result.filesIndexed === 0 && result.errors.length > 0) {
          set.status = 500;
          return {
            error: `Failed to index any files — ${result.errors.length} error(s). First: ${result.errors[0]}`,
            ...result,
          };
        }
        return result;
      } else {
        const chunks = await indexer.indexFile(path, validSourceType);
        logger.info({ path, chunks, userId: user.id }, 'File indexed');
        if (chunks === 0) {
          // indexText returns 0 either for empty content or every-chunk-failed
          // (which now throws, so we'd be in the catch). This branch is "empty content".
          logger.warn({ path, userId: user.id }, 'File indexed with 0 chunks — file is empty or whitespace');
        }
        return { filesIndexed: 1, chunksStored: chunks, errors: [] };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error({ err, message, stack, path, type, userId: user.id }, 'Index request failed');
      // 500 for genuine server/provider failures. "file not found" is user error — 400.
      const isUserError = /file not found|ENOENT/i.test(message);
      set.status = isUserError ? 400 : 500;
      return { error: message };
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
