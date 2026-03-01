import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { sessionRepository } from '@/db/repositories/session-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { apiLogger } from '@/utils/logger';

export const sessionRoutes = new Elysia({ prefix: '/sessions' })
  .use(apiContext)
  // List sessions
  .get(
    '/',
    async ({ user, query }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const limit = query.limit ? parseInt(query.limit, 10) : 50;

      let sessions;
      if (user.isAdmin && query.all === 'true') {
        sessions = await sessionRepository.listRecent(limit);
      } else {
        sessions = await sessionRepository.listByUser(user.id, limit);
      }

      return { sessions };
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
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const session = await sessionRepository.findById(params.id);

      if (!session) {
        return { error: 'Session not found' };
      }

      if (!user.isAdmin && session.userId !== user.id) {
        return { error: 'Not authorized' };
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
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const session = await sessionRepository.create({
        userId: user.id,
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
    async ({ user, params, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const session = await sessionRepository.findById(params.id);

      if (!session) {
        return { error: 'Session not found' };
      }

      if (!user.isAdmin && session.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const updated = await sessionRepository.update(params.id, body as Partial<import('@/db/schema/sessions').NewSession>);

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
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const session = await sessionRepository.findById(params.id);

      if (!session) {
        return { error: 'Session not found' };
      }

      if (!user.isAdmin && session.userId !== user.id) {
        return { error: 'Not authorized' };
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
    async ({ user, params, query }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const session = await sessionRepository.findById(params.id);

      if (!session) {
        return { error: 'Session not found' };
      }

      if (!user.isAdmin && session.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const limit = query.limit ? parseInt(query.limit, 10) : 100;
      const offset = query.offset ? parseInt(query.offset, 10) : 0;

      const messages = await messageRepository.findBySession(params.id, limit, offset);

      return { messages, total: session.messageCount };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      query: t.Object({
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
      detail: { tags: ['sessions'] },
    }
  )

  // Complete session
  .post(
    '/:id/complete',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const session = await sessionRepository.findById(params.id);

      if (!session) {
        return { error: 'Session not found' };
      }

      if (!user.isAdmin && session.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const updated = await sessionRepository.complete(params.id);

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
