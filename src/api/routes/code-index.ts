/**
 * The optional CocoIndex Code index (`src/core/code-index/cocoindex.ts`): a
 * managed MCP server that finds code by meaning, set up from the Knowledge
 * page. Admins install, reconfigure and remove it; members read a redacted
 * status. `/:side/embeddings` is the OpenAI-compatible endpoint the managed
 * daemon embeds through when it uses the install's embedding topic.
 */
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { getCocoIndexService, redactCocoIndexStatus, resolveCocoIndexWorkspacePath } from '@/core/code-index/cocoindex';
import { embedCocoIndex } from '@/core/code-index/cocoindex-embedding';
import { coreLogger } from '@/utils/logger';

const COCOINDEX_EMBED_MAX_CHARS = 4_000;

export const codeIndexRoutes = new Elysia({ prefix: '/code-index' })
  .use(apiContext)

  .post('/cocoindex/:side/embeddings', async ({ user, body, params, set }) => {
    if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
    if (!user.isAdmin) { set.status = 403; return { error: 'Admin access required' }; }
    // ccc chunks are ~1k chars; a longer one is an unsplittable blob (base64
    // fonts, data URIs). Rejecting it fails the whole file, which ccc then
    // re-embeds on every run — truncate instead. 64 x 4k keeps a batch bounded.
    const raw: string[] = typeof body.input === 'string' ? [body.input] : body.input;
    // ponytail: total cap only; a batch of blobs over 8M chars still fails, raise it if one shows up.
    if (raw.reduce((size, text) => size + text.length, 0) > 8_000_000) {
      set.status = 413; return { error: 'Embedding batch too large' };
    }
    const inputs = raw.map(text => text.slice(0, COCOINDEX_EMBED_MAX_CHARS));
    try {
      // CocoIndex shares one API base; its supported per-side input_type
      // distinguishes retrieval queries from indexed documents.
      const side = body.input_type ?? (params.side === 'query' ? 'query' : 'document');
      const result = await embedCocoIndex(inputs, body.model, side, user.id);
      if (!result) { set.status = 429; return { error: 'Embedding request already active; retry shortly' }; }
      return result;
    } catch (error) {
      set.status = 503;
      return { error: error instanceof Error ? error.message : 'Embedding failed' };
    }
  }, { params: t.Object({ side: t.Union([t.Literal('document'), t.Literal('query')]) }), body: t.Object({
    model: t.String({ minLength: 1, maxLength: 200 }),
    input: t.Union([t.String({ maxLength: 8_000_000 }), t.Array(t.String({ maxLength: 8_000_000 }), { minItems: 1, maxItems: 64 })]),
    encoding_format: t.Optional(t.String()),
    input_type: t.Optional(t.Union([t.Literal('document'), t.Literal('query')])),
  }) })

  .get('/cocoindex', async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }
    try {
      const status = await getCocoIndexService().getStatus();
      return user.isAdmin ? status : redactCocoIndexStatus(status);
    } catch (error) {
      coreLogger.error({ err: error }, 'Could not inspect CocoIndex');
      set.status = 503;
      return { error: user.isAdmin && error instanceof Error ? error.message : 'Could not inspect CocoIndex' };
    }
  }, { detail: { tags: ['code-index'] } })

  .post('/cocoindex/install', async ({ user, principal, body, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }
    if (!user.isAdmin) {
      set.status = 403;
      return { error: 'Admin access required' };
    }
    try {
      const path = await resolveCocoIndexWorkspacePath(body.workspacePath, principal);
      const status = await getCocoIndexService().install(path, body.embeddingModel, body.embeddingSource);
      set.status = 202;
      return status;
    } catch (error) {
      coreLogger.warn({ err: error }, 'CocoIndex setup rejected');
      set.status = 400;
      return { error: error instanceof Error ? error.message : 'Could not start CocoIndex setup' };
    }
  }, {
    body: t.Object({
      workspacePath: t.String({ minLength: 1, maxLength: 4096 }),
      embeddingModel: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
      embeddingSource: t.Optional(t.Union([t.Literal('local'), t.Literal('octipus')])),
    }),
    detail: { tags: ['code-index'] },
  })

  .delete('/cocoindex', async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }
    if (!user.isAdmin) {
      set.status = 403;
      return { error: 'Admin access required' };
    }
    try {
      return await getCocoIndexService().remove();
    } catch (error) {
      coreLogger.error({ err: error }, 'Could not remove CocoIndex');
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'Could not remove CocoIndex' };
    }
  }, { detail: { tags: ['code-index'] } });
