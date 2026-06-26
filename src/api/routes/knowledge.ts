import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { CODE_NOT_INDEXED_MESSAGE, isCodeFile } from '@/core/rag/code-detection';
import { type EmbeddingPurpose, getEmbeddingService } from '@/core/rag/embeddings';
import { type getKBReadiness, isKBReady, kbNotReadyResponse, runKBSelfCheck } from '@/core/rag/health';
import { getFileIndexer } from '@/core/rag/indexer';
import { WorkspaceFS, WorkspaceFsError } from '@/security/workspace-fs';
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
    const purpose = (query.purpose || undefined) as EmbeddingPurpose | undefined;

    try {
      const service = getEmbeddingService();
      const result = await service.listAll(limit, offset, purpose);
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
      purpose: t.Optional(t.String()),
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

    const { query, mode = 'hybrid', limit = 10, purpose, minSimilarity, repoIds } = body;
    const purposeTyped = purpose as EmbeddingPurpose | undefined;
    const service = getEmbeddingService();
    // Optional multi-repo scope (repoIds are workspace_repos.id values).
    const scope = repoIds && repoIds.length > 0 ? { repoIds } : undefined;
    // Apply the same defaults as the MCP tool so REST callers get useful
    // results instead of "everything in the KB at ~0.01 similarity".
    const threshold = typeof minSimilarity === 'number'
      ? minSimilarity
      : mode === 'semantic' ? 0.35 : mode === 'keyword' ? 0 : 0.3;

    try {
      let results;
      switch (mode) {
        case 'semantic':
          results = await service.search(query, limit, purposeTyped, threshold, undefined, scope);
          break;
        case 'keyword':
          results = await service.ftsSearch(query, limit, purposeTyped, undefined, scope);
          break;
        case 'hybrid':
        default:
          results = await service.hybridSearch(query, limit, purposeTyped, undefined, threshold, undefined, scope);
          break;
      }
      return { results, mode, query, minSimilarity: threshold };
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
      purpose: t.Optional(t.String()),
      minSimilarity: t.Optional(t.Number()),
      repoIds: t.Optional(t.Array(t.String())),
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

    const { path, type = 'file', purpose, patterns } = body;
    const indexer = getFileIndexer();
    // The 'code' purpose is retired — raw code is never indexed. Reject it at the
    // boundary (fail loud) rather than silently coercing to 'document'.
    if (purpose === 'code') {
      set.status = 400;
      return { error: CODE_NOT_INDEXED_MESSAGE };
    }
    // Everything indexable lands as 'document'.
    const validPurpose = 'document' as const;

    // Sandbox the caller-supplied path BEFORE anything else touches it.
    // Without this, `indexer.indexFile` does `Bun.file(path).text()` on ANY
    // absolute path the request names — an authenticated user could index
    // `/etc/passwd`, app secrets, or another tenant's workspace into their
    // own KB and read it back via search. `WorkspaceFS.forAgent` pins
    // resolution to the caller's workspace root (per-user under multiuser;
    // flat single-user root otherwise) plus the operator-configured
    // `additionalPaths` escape hatch. Mirrors the session-file routes and the
    // filesystem tool. Runs before the KB-readiness gate so a hostile path is
    // rejected regardless of embedding-service state.
    //
    // For a directory we validate the root here AND pass a per-file guard to
    // `indexDirectory` (below), so a symlinked leaf inside the tree that points
    // outward is rejected too. The file branch is covered by `fs.resolve`'s
    // realpath check.
    let safePath: string;
    const fs = WorkspaceFS.forAgent({ userId: user.id });
    try {
      safePath = fs.resolve(path);
    } catch (err) {
      if (err instanceof WorkspaceFsError) {
        set.status = 400;
        logger.warn({ path, code: err.code, userId: user.id }, 'Index request rejected — path outside workspace');
        return { error: `Path '${path}' is outside allowed workspace directories` };
      }
      throw err;
    }

    const notReady = ensureKBReady(set);
    if (notReady) return notReady;

    try {
      if (type === 'directory') {
        const globPatterns = patterns ? patterns.split(',').map(p => p.trim()) : undefined;
        // Per-file guard: a globbed leaf that realpath-resolves outside the
        // workspace (e.g. a symlink to /etc) is skipped, not indexed.
        const result = await indexer.indexDirectory(safePath, globPatterns, {
          isAllowed: (p) => fs.resolveOptional(p) !== null,
        });
        logger.info({ path: safePath, filesIndexed: result.filesIndexed, chunksStored: result.chunksStored, errors: result.errors.length, userId: user.id }, 'Directory indexed');
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
        // Raw code files are not indexed by design — reject cleanly (400)
        // rather than letting the indexer throw into the 500 path.
        if (isCodeFile(safePath)) {
          set.status = 400;
          logger.info({ path: safePath, userId: user.id }, 'Index request rejected — raw code file');
          return { error: CODE_NOT_INDEXED_MESSAGE };
        }
        const chunks = await indexer.indexFile(safePath, validPurpose);
        logger.info({ path: safePath, chunks, userId: user.id }, 'File indexed');
        if (chunks === 0) {
          // indexText returns 0 either for empty content or every-chunk-failed
          // (which now throws, so we'd be in the catch). This branch is "empty content".
          logger.warn({ path: safePath, userId: user.id }, 'File indexed with 0 chunks — file is empty or whitespace');
        }
        return { filesIndexed: 1, chunksStored: chunks, errors: [] };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error({ err, message, stack, path: safePath, type, userId: user.id }, 'Index request failed');
      // 500 for genuine server/provider failures. "file not found" is user error — 400.
      const isUserError = /file not found|ENOENT/i.test(message);
      set.status = isUserError ? 400 : 500;
      return { error: message };
    }
  }, {
    body: t.Object({
      path: t.String(),
      type: t.Optional(t.Union([t.Literal('file'), t.Literal('directory')])),
      purpose: t.Optional(t.String()),
      patterns: t.Optional(t.String()),
    }),
    detail: { tags: ['knowledge'] },
  });
