import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { readRunEvents } from '@/core/run-log';
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
  );
