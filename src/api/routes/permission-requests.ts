import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { getPermissionManager } from '@/security/permissions';
import { isAuthenticated } from '@/security/principal';

/**
 * REST view of pending tool-permission requests for clients that cannot keep
 * the permission WebSocket open (a phone woken by a push notification).
 * Mirrors the `/ws/permissions` `pending_requests` / `respond` frames.
 */
export const permissionRequestRoutes = new Elysia({ prefix: '/permission-requests' })
  .use(apiContext)

  .get(
    '/pending',
    async ({ user, principal, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const requests = await getPermissionManager().getPendingRequests(user.id);
      return {
        requests: requests.map((r) => ({
          requestId: r.id,
          agentId: r.agentId,
          sessionId: r.sessionId,
          toolId: r.toolId,
          action: r.action,
          toolName: r.context?.toolName ?? r.action,
          args: r.context?.toolArguments ?? {},
          createdAt: r.createdAt,
        })),
      };
    },
    { detail: { tags: ['permissions'] } },
  )

  .post(
    '/:id/respond',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const pm = getPermissionManager();
      const recorded = body.approved
        ? await pm.approve(params.id, user.id, body.resolution)
        : await pm.deny(params.id, user.id, body.resolution);
      if (!recorded) {
        // Already answered elsewhere, expired, or not this user's request —
        // one response shape so ids cannot be probed.
        return { error: 'Permission request not found or already resolved' };
      }
      return { resolved: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        approved: t.Boolean(),
        resolution: t.Optional(t.String()),
      }),
      detail: { tags: ['permissions'] },
    },
  );
