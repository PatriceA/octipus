import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getNotificationService } from '@/core/notification-service';

export const notificationRoutes = new Elysia({ prefix: '/notifications' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, query }) => {
      if (!user) return { error: 'Not authenticated' };

      const service = getNotificationService();
      const limit = query.limit ? parseInt(query.limit, 10) : 50;
      const offset = query.offset ? parseInt(query.offset, 10) : 0;
      const notifications = await service.getAll(user.id, limit, offset);
      const unreadCount = await service.getUnreadCount(user.id);

      return { notifications, unreadCount };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
      detail: { tags: ['notifications'] },
    }
  )

  .post(
    '/:id/read',
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };

      const service = getNotificationService();
      await service.markRead(params.id);
      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['notifications'] },
    }
  )

  .post(
    '/read-all',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };

      const service = getNotificationService();
      await service.markAllRead(user.id);
      return { success: true };
    },
    { detail: { tags: ['notifications'] } }
  );
