import { Elysia } from '@/api/http';
import { apiContext } from '@/api/context';
import { myWork } from '@/core/tasks/team';
import { isAuthenticated } from '@/security/principal';

/**
 * "My work" (coworking spec §9.3), mounted at `/api/me/work`: the caller's
 * open tasks assigned to them, across the spaces they belong to and their
 * personal workspaces, grouped by space. An impersonating admin sees the
 * impersonated user's.
 */
export const meWorkRoutes = new Elysia({ prefix: '/me/work' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, principal, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      return { groups: await myWork(principal.userId) };
    },
    { detail: { tags: ['tasks'] } },
  );
