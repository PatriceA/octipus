import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getChannelBindingManager } from '@/security/channel-bindings';
import { isAuthenticated } from '@/security/principal';

/**
 * Channel bindings — Phase 2d multi-user.
 *
 * Mounted at `/api/auth/channel-bindings`. Authenticated users can
 * list, redeem (link a channel external_id), and unbind. Admins can
 * unbind any user's binding via the same endpoint by passing
 * `{ admin: true }` is reserved for the admin console — not exposed
 * here. Cross-tenant unbind attempts return 404 (collapses with
 * "doesn't exist" so attackers can't enumerate binding ids).
 */
export const channelBindingRoutes = new Elysia({ prefix: '/auth/channel-bindings' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, principal, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const bindings = await getChannelBindingManager().listForUser(principal.userId);
      return { bindings };
    },
    { detail: { tags: ['auth'] } },
  )

  .post(
    '/redeem',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      const result = await getChannelBindingManager().redeem(principal.userId, body.code);
      if (!result.ok) {
        // Distinguish reasons for the UI but keep status codes
        // narrow: 400 for client-side fixable issues, 409 for
        // collision with another user's binding.
        switch (result.reason) {
          case 'unknown_code':
          case 'expired':
          case 'already_redeemed':
            set.status = 400;
            return { error: result.reason };
          case 'already_bound_to_another_user':
            set.status = 409;
            return { error: 'already_bound_to_another_user' };
          default:
            set.status = 400;
            return { error: 'invalid_request' };
        }
      }
      set.status = 201;
      return result.binding;
    },
    {
      body: t.Object({
        code: t.String({ minLength: 6, maxLength: 12 }),
      }),
      detail: { tags: ['auth'] },
    },
  )

  .delete(
    '/:channelType/:externalId',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const ok = await getChannelBindingManager().unbind(
        principal.userId,
        params.channelType,
        decodeURIComponent(params.externalId),
      );
      if (!ok) {
        set.status = 404;
        return { error: 'Binding not found' };
      }
      return { unbound: true };
    },
    {
      params: t.Object({
        channelType: t.String(),
        externalId: t.String(),
      }),
      detail: { tags: ['auth'] },
    },
  );
