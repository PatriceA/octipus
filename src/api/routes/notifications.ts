import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { scopedRepos } from '@/db/repositories/scoped';
import { isAuthenticated } from '@/security/principal';

/**
 * Notifications — Phase 1a multi-user conversion.
 *
 * Listing and counting were already user-scoped in the service. The
 * gap was `markRead`: the service accepted a notification id without
 * verifying ownership, so any authenticated user could mark any
 * notification read by guessing UUIDs. The scoped repo's `markRead`
 * applies the user filter in the WHERE clause; cross-tenant attempts
 * become silent no-ops.
 */
export const notificationRoutes = new Elysia({ prefix: '/notifications' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, principal, query }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };

      const repo = scopedRepos(principal).notifications;
      const limit = query.limit ? parseInt(query.limit, 10) : 50;
      const offset = query.offset ? parseInt(query.offset, 10) : 0;
      const notifications = await repo.list(limit, offset);
      const unreadCount = await repo.unreadCount();
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
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };

      const ok = await scopedRepos(principal).notifications.markRead(params.id);
      // Silent no-op for cross-tenant — same response shape so attackers
      // can't enumerate notification ids by probing markRead.
      return { success: ok };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['notifications'] },
    }
  )

  .post(
    '/read-all',
    async ({ user, principal }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };

      await scopedRepos(principal).notifications.markAllRead();
      return { success: true };
    },
    { detail: { tags: ['notifications'] } }
  );
