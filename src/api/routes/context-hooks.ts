import { capabilityRefused } from '@/api/capability-guard';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import {
  BUILTIN_HOOKS,
  ContextHookError,
  contextHookStats,
  createContextHook,
  deleteContextHook,
  evaluateRecall,
  listContextHooks,
  MAX_SWEEP_THRESHOLDS,
  sweepRecall,
  updateContextHook,
} from '@/core/context-hooks';
import { getConfig } from '@/config';
import type { ContextHooksResponse } from '@/shared/context-hooks';
import { isAuthenticated } from '@/security/principal';
import { apiLogger } from '@/utils/logger';

const evalCases = t.Array(t.Object({
  question: t.String({ minLength: 1, maxLength: 2000 }),
  expect: t.Optional(t.Array(t.String({ maxLength: 300 }), { maxItems: 10 })),
}), { minItems: 1, maxItems: 100 });

const asCases = (cases: Array<{ question: string; expect?: string[] }>) => cases.map((c) => ({ question: c.question, expect: c.expect ?? [] }));

/** The personal knowledge base of the caller's workspace; a space's is not evaluated here. */
const evalWorkspace = (principal: { workspaceKind?: string; workspaceId?: string | null }) =>
  principal.workspaceKind === 'shared' ? null : principal.workspaceId ?? null;

const EVAL_FAILED = 'The knowledge base could not be searched. Check that an embedding model is set up (Settings → Models).';

const hookBody = t.Object({
  name: t.Optional(t.String({ maxLength: 120 })),
  kind: t.Optional(t.String({ maxLength: 40 })),
  events: t.Optional(t.Array(t.String({ maxLength: 40 }), { maxItems: 4 })),
  config: t.Optional(t.Record(t.String({ maxLength: 60 }), t.Unknown())),
  enabled: t.Optional(t.Boolean()),
});

function failed(err: unknown, set: { status?: number | string }) {
  if (err instanceof ContextHookError) { set.status = err.status; return { error: err.message }; }
  throw err;
}

/**
 * Context hooks (docs/CONTEXT-HOOKS.md): the caller's own hooks, the numbers
 * on what they injected and what agents did with it, and the recall eval.
 * Personal: every route reads and writes only the caller's rows.
 */
export const contextHookRoutes = new Elysia({ prefix: '/context-hooks' })
  .use(apiContext)

  .get('/', async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    const descriptions = Object.fromEntries(BUILTIN_HOOKS.map((b) => [`builtin:${b.builtin}`, b.description]));
    const settings = getConfig().contextHooks;
    const response: ContextHooksResponse = {
      enabled: settings.enabled,
      maxTokens: settings.maxTokens,
      hooks: (await listContextHooks(user.id)).map((h) => ({ ...h, description: descriptions[h.id] ?? null })),
    };
    return response;
  }, { detail: { tags: ['context-hooks'] } })

  .post('/', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    try {
      set.status = 201;
      return await createContextHook(user.id, body);
    } catch (err) { return failed(err, set); }
  }, { body: hookBody, detail: { tags: ['context-hooks'] } })

  .patch('/:id', async ({ user, principal, params, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    try {
      return await updateContextHook(user.id, params.id, body);
    } catch (err) { return failed(err, set); }
  }, { body: hookBody, detail: { tags: ['context-hooks'] } })

  .delete('/:id', async ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    if (!(await deleteContextHook(user.id, params.id))) { set.status = 404; return { error: 'No such hook' }; }
    return { ok: true };
  }, { detail: { tags: ['context-hooks'] } })

  .get('/stats', async ({ user, principal, query, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    // At most the log retention window (90 days by default): older rows are pruned.
    const days = Math.min(90, Math.max(1, Number(query.days) || 30));
    return contextHookStats(user.id, days);
  }, { query: t.Object({ days: t.Optional(t.String({ maxLength: 4 })) }), detail: { tags: ['context-hooks'] } })

  // Retrieval only, no model call: what the recall hook would inject for each
  // question, against the caller's own knowledge base and notes.
  .post('/eval', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    const notConfigured = capabilityRefused(set, 'embedding');
    if (notConfigured) return notConfigured;
    try {
      return await evaluateRecall(user.id, evalWorkspace(principal), asCases(body.cases), {
        ...(body.minSimilarity !== undefined ? { minSimilarity: body.minSimilarity } : {}),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
      });
    } catch (err) {
      apiLogger.warn({ err, userId: user.id }, 'context hooks: recall eval failed');
      set.status = 503;
      return { error: EVAL_FAILED };
    }
  }, {
    body: t.Object({
      cases: evalCases,
      minSimilarity: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
      limit: t.Optional(t.Integer({ minimum: 1, maximum: 10 })),
    }),
    detail: { tags: ['context-hooks'] },
  })

  // The same cases at a range of minSimilarity values (each question searched
  // once), with the value the sweep recommends for the Knowledge recall hook.
  .post('/eval/sweep', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    const notConfigured = capabilityRefused(set, 'embedding');
    if (notConfigured) return notConfigured;
    try {
      return await sweepRecall(user.id, evalWorkspace(principal), asCases(body.cases), {
        ...(body.thresholds ? { thresholds: body.thresholds } : {}),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
      });
    } catch (err) {
      apiLogger.warn({ err, userId: user.id }, 'context hooks: recall sweep failed');
      set.status = 503;
      return { error: EVAL_FAILED };
    }
  }, {
    body: t.Object({
      cases: evalCases,
      thresholds: t.Optional(t.Array(t.Number({ minimum: 0, maximum: 1 }), { minItems: 1, maxItems: MAX_SWEEP_THRESHOLDS })),
      limit: t.Optional(t.Integer({ minimum: 1, maximum: 10 })),
    }),
    detail: { tags: ['context-hooks'] },
  });
