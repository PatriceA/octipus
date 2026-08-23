import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { scopedRepos } from '@/db/repositories/scoped';
import { isAuthenticated } from '@/security/principal';
import { coreLogger } from '@/utils/logger';

/**
 * Trajectories — Phase 1a multi-user conversion.
 *
 * The unscoped `trajectoryRepository.list` accepted an optional userId
 * filter but the route never set it, so any authenticated caller could
 * see every user's trajectory runs. The scoped repo enforces ownership
 * by default; admins keep cross-user visibility for operational triage.
 */
export const trajectoryRoutes = new Elysia({ prefix: '/trajectories' })
  .use(apiContext)
  .get('/', async ({ user, principal, query, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }
    try {
      const outcome = query.outcome as 'success' | 'failure' | 'partial' | 'cancelled' | undefined;
      const limit = query.limit ? Math.min(parseInt(query.limit, 10) || 100, 1000) : 100;
      const from = query.from ? new Date(query.from) : undefined;
      const to = query.to ? new Date(query.to) : undefined;

      const rows = await scopedRepos(principal).trajectories.list({ outcome, from, to, limit });
      return { trajectories: rows };
    } catch (err) {
      coreLogger.error({ err }, 'Trajectory list failed');
      set.status = 500;
      return { error: (err as Error).message };
    }
  }, {
    query: t.Object({
      outcome: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
    }),
  })
  .get('/:id', async ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }
    try {
      const row = await scopedRepos(principal).trajectories.findById(params.id);
      if (!row) { set.status = 404; return { error: 'not found' }; }
      return row;
    } catch (err) {
      set.status = 500;
      return { error: (err as Error).message };
    }
  });
