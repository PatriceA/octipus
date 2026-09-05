import { Elysia, t } from '@/api/http';
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
      const limit = Math.max(1, Math.min(200, parseInt(query.limit ?? '', 10) || 50));
      const offset = Math.max(0, parseInt(query.offset ?? '', 10) || 0);
      // `type` is a prefix (`agent`, `pipeline`, `approval`); anything outside
      // the producers' `[a-z_]` alphabet is rejected rather than passed to LIKE.
      if (query.type !== undefined && !/^[a-z_]{1,32}$/.test(query.type)) {
        return { error: `Invalid type filter "${query.type}"` };
      }
      const [notifications, unreadCount] = await Promise.all([
        repo.list(limit, offset, { unread: query.unread === '1' || query.unread === 'true', typePrefix: query.type }),
        repo.unreadCount(),
      ]);
      return { notifications, unreadCount };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
        unread: t.Optional(t.String()),
        type: t.Optional(t.String({ maxLength: 32 })),
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
