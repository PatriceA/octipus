import { Elysia, t } from 'elysia';
import { trajectoryRepository } from '@/db/repositories/trajectory-repository';
import { coreLogger } from '@/utils/logger';

export const trajectoryRoutes = new Elysia({ prefix: '/trajectories' })
  .get('/', async ({ query, set }) => {
    try {
      const outcome = query.outcome as 'success' | 'failure' | 'partial' | 'cancelled' | undefined;
      const limit = query.limit ? Math.min(parseInt(query.limit, 10) || 100, 1000) : 100;
      const from = query.from ? new Date(query.from) : undefined;
      const to = query.to ? new Date(query.to) : undefined;

      const rows = await trajectoryRepository.list({ outcome, from, to, limit });
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
  .get('/:id', async ({ params, set }) => {
    try {
      const row = await trajectoryRepository.findById(params.id);
      if (!row) { set.status = 404; return { error: 'not found' }; }
      return row;
    } catch (err) {
      set.status = 500;
      return { error: (err as Error).message };
    }
  });
