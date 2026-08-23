import { and, asc, eq, gte } from 'drizzle-orm';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { readRunEvents } from '@/core/run-log';
import { buildTrace } from '@/core/run-trace';
import { getDb } from '@/db/postgres';
import { costLog } from '@/db/schema/models';
import { scopedRepos } from '@/db/repositories/scoped';
import { isAuthenticated } from '@/security/principal';
import { coreLogger } from '@/utils/logger';

/**
 * Run log — read-only view of what actually happened during a run: swarm node
 * lifecycle, pipeline graph transitions, plan item progress and tool dispatch,
 * in one `seq`-ordered stream.
 *
 * A run is a root session, so ownership is enforced through the scoped session
 * lookup — you can only read a run you own, and a session that is not yours is
 * a 404 rather than a 403 so the route does not confirm it exists.
 */
export const runRoutes = new Elysia({ prefix: '/runs' })
  .use(apiContext)
  .get(
    '/:sessionId/events',
    async ({ user, principal, params, query, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      try {
        const session = await scopedRepos(principal).sessions.findById(params.sessionId);
        if (!session) {
          set.status = 404;
          return { error: 'Session not found' };
        }
        const events = await readRunEvents(params.sessionId, {
          subject: query.subject,
          limit: query.limit,
        });
        return { runId: params.sessionId, events };
      } catch (err) {
        coreLogger.error({ err, sessionId: params.sessionId }, 'Failed to read the run log');
        set.status = 500;
        return { error: (err as Error).message };
      }
    },
    {
      params: t.Object({ sessionId: t.String() }),
      query: t.Object({
        subject: t.Optional(
          t.Union([
            t.Literal('swarm_node'),
            t.Literal('pipeline_node'),
            t.Literal('plan_item'),
            t.Literal('tool'),
          ]),
        ),
        limit: t.Optional(t.Number()),
      }),
      detail: { tags: ['runs'] },
    },
  )

  /**
   * The same stream, folded into spans: what ran, nested, for how long, and at
   * what cost. Cost comes from `cost_log` rows inside each span's window — a
   * model call already records its session and its price, so the trace does not
   * need a second accounting path that could disagree with the bill.
   */
  .get(
    '/:sessionId/trace',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      try {
        const session = await scopedRepos(principal).sessions.findById(params.sessionId);
        if (!session) {
          set.status = 404;
          return { error: 'Session not found' };
        }
        // Bounded: one `tool_call` row lands per dispatch, so a long run has
        // thousands. The newest slice is what a trace view can render anyway.
        const TRACE_EVENT_CAP = 5000;
        const events = await readRunEvents(params.sessionId, { limit: TRACE_EVENT_CAP });
        const since = events.length ? events[0].createdAt : new Date(0);
        const costs = await getDb()
          .select({
            createdAt: costLog.createdAt,
            modelName: costLog.modelName,
            inputTokens: costLog.inputTokens,
            outputTokens: costLog.outputTokens,
            totalCost: costLog.totalCost,
          })
          .from(costLog)
          .where(and(eq(costLog.sessionId, params.sessionId), gte(costLog.createdAt, since)))
          .orderBy(asc(costLog.createdAt));

        return {
          ...buildTrace(params.sessionId, events, costs),
          truncated: events.length === TRACE_EVENT_CAP,
        };
      } catch (err) {
        coreLogger.error({ err, sessionId: params.sessionId }, 'Failed to build the run trace');
        set.status = 500;
        return { error: (err as Error).message };
      }
    },
    {
      params: t.Object({ sessionId: t.String() }),
      detail: { tags: ['runs'] },
    },
  );
