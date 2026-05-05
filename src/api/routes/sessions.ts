import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { sessionRepository } from '@/db/repositories/session-repository';
import { scopedRepos } from '@/db/repositories/scoped';
import { isAuthenticated } from '@/security/principal';

/**
 * Session routes — Phase 1a multi-user conversion.
 *
 * Each handler now routes reads and writes through `scopedRepos(principal)`,
 * which makes "user A reads user B's session" structurally impossible at
 * the repository layer. The hand-rolled `if (!user.isAdmin && session.userId
 * !== user.id)` checks that lived in every handler before are gone — the
 * scope itself is the check.
 *
 * Cross-tenant lookups return `null` from the scoped repo, which the route
 * surfaces as the existing "Session not found" response so we don't change
 * the public contract. Admins continue to see other users' rows because
 * `isAdmin(principal)` widens the WHERE clause inside the scope.
 *
 * Aggregation across sibling channel sessions still uses the unscoped
 * `sessionRepository.findAllByUserAndChannel` — that's safe because we
 * pass `session.userId` which we just verified the principal is allowed
 * to see (the scoped session exists in the principal's tenant).
 */
export const sessionRoutes = new Elysia({ prefix: '/sessions' })
  .use(apiContext)
  // List sessions
  .get(
    '/',
    async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const limit = query.limit ? parseInt(query.limit, 10) : 50;
      const repos = scopedRepos(principal);

      const sessions = user.isAdmin && query.all === 'true'
        ? await repos.sessions.listAllAdmin(limit)
        : await repos.sessions.listOwn(limit);

      const { getConfig } = await import('@/config');
      const config = getConfig();
      return { sessions, maxTokenBudget: config.agent.maxTokenBudget };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        all: t.Optional(t.String()),
      }),
      detail: { tags: ['sessions'] },
    }
  )

  // Get session by ID
  .get(
    '/:id',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const session = await scopedRepos(principal).sessions.findById(params.id);
      if (!session) {
        set.status = 404;
        return { error: 'Session not found' };
      }
      return session;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['sessions'] },
    }
  )

  // Create new session
  .post(
    '/',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const session = await scopedRepos(principal).sessions.create({
        channelType: body.channelType || 'api',
        channelId: body.channelId || 'api',
        title: body.title,
        context: body.context || {},
        metadata: body.metadata || {},
      });

      return session;
    },
    {
      body: t.Object({
        channelType: t.Optional(t.String()),
        channelId: t.Optional(t.String()),
        title: t.Optional(t.String()),
        context: t.Optional(t.Any()),
        metadata: t.Optional(t.Any()),
      }),
      detail: { tags: ['sessions'] },
    }
  )

  // Update session
  .patch(
    '/:id',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const updated = await scopedRepos(principal).sessions.update(
        params.id,
        body as Partial<import('@/db/schema/sessions').NewSession>,
      );
      if (!updated) {
        set.status = 404;
        return { error: 'Session not found' };
      }
      return updated;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        title: t.Optional(t.String()),
        status: t.Optional(t.String()),
        context: t.Optional(t.Any()),
        metadata: t.Optional(t.Any()),
      }),
      detail: { tags: ['sessions'] },
    }
  )

  // Delete session
  .delete(
    '/:id',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      // Scoped delete returns false on miss / cross-tenant. We still need
      // the unscoped sessionRepository.delete to fan out the cascade
      // cleanup of messages/pipelines/agents — but only after confirming
      // the principal owns the row.
      const owned = await scopedRepos(principal).sessions.findById(params.id);
      if (!owned) {
        set.status = 404;
        return { error: 'Session not found' };
      }
      const deleted = await sessionRepository.delete(params.id);
      return { deleted };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['sessions'] },
    }
  )

  // Get session messages
  .get(
    '/:id/messages',
    async ({ user, principal, params, query, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const repos = scopedRepos(principal);
      const session = await repos.sessions.findById(params.id);
      if (!session) {
        set.status = 404;
        return { error: 'Session not found' };
      }

      const limit = query.limit ? parseInt(query.limit, 10) : 100;
      const offset = query.offset ? parseInt(query.offset, 10) : 0;
      const roles = query.roles ? query.roles.split(',') : undefined;

      // Aggregate messages across sibling sessions for long-lived channel chats.
      // Channel restarts or /clear can create new session rows for the same
      // (user, channelType, channelId); users expect one continuous transcript.
      const AGGREGATED_CHANNELS = new Set(['telegram', 'slack', 'whatsapp', 'teams', 'discord']);
      const aggregate = query.aggregate !== 'false' && AGGREGATED_CHANNELS.has(session.channelType);

      let messages;
      let total;
      if (aggregate) {
        // Sibling sessions are filtered by (userId, channelType, channelId);
        // since `session` is already scoped to the principal, session.userId
        // is the principal's id (or any user's id if admin).
        const siblings = await sessionRepository.findAllByUserAndChannel(
          session.userId,
          session.channelType,
          session.channelId,
        );
        const siblingIds = siblings.map((s) => s.id);
        messages = await repos.messages.findBySessions(siblingIds, limit, offset, roles);
        total = await repos.messages.countBySessions(siblingIds);
      } else {
        messages = await repos.messages.findBySession(params.id, limit, offset, roles);
        total = session.messageCount;
      }

      return { messages, total, aggregated: aggregate };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      query: t.Object({
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
        roles: t.Optional(t.String()),
        aggregate: t.Optional(t.String()),
      }),
      detail: { tags: ['sessions'] },
    }
  )

  // Complete session
  .post(
    '/:id/complete',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const updated = await scopedRepos(principal).sessions.update(params.id, {
        status: 'completed',
        completedAt: new Date(),
      });
      if (!updated) {
        set.status = 404;
        return { error: 'Session not found' };
      }
      return updated;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['sessions'] },
    }
  )

  // Get active session count
  .get(
    '/stats/active',
    async ({ user }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const count = await sessionRepository.countActive();

      return { activeCount: count };
    },
    { detail: { tags: ['sessions'] } }
  );
