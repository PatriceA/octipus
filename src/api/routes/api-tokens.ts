import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getApiTokenManager } from '@/security/api-tokens';
import { isAuthenticated } from '@/security/principal';

/**
 * Personal access tokens — Phase 2a multi-user.
 *
 * Routes are mounted under `/api/auth/api-tokens` so they live next
 * to the rest of the auth surface. Every endpoint requires an
 * authenticated principal; admins act on their own tokens by default
 * (the `{ admin: true }` override on the manager is reserved for the
 * future admin console, NOT exposed via these routes).
 *
 * Status code conventions match the rest of Phase 1a/2a:
 *   - 401 for unauthenticated
 *   - 404 for cross-tenant or missing rows (collapses with "doesn't
 *     exist" so attackers can't enumerate token ids)
 *   - 200 / 201 on success
 *
 * The plaintext `token` field appears ONLY in the POST response —
 * never in GET or any subsequent read. The client must capture it
 * immediately.
 */
export const apiTokenRoutes = new Elysia({ prefix: '/auth/api-tokens' })
  .use(apiContext)

  // List the principal's own tokens (no plaintext, no hash).
  .get(
    '/',
    async ({ user, principal, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const tokens = await getApiTokenManager().listForUser(principal.userId);
      return { tokens };
    },
    { detail: { tags: ['auth'] } },
  )

  // Issue a new token. The plaintext is returned exactly once.
  .post(
    '/',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      if (body.expiresAt && (expiresAt === null || Number.isNaN(expiresAt.getTime()))) {
        set.status = 400;
        return { error: 'Invalid expiresAt — must be ISO-8601' };
      }

      const result = await getApiTokenManager().issue(principal.userId, {
        name: body.name,
        scopes: body.scopes,
        expiresAt,
      });

      set.status = 201;
      // The plaintext is keyed `token` so callers can copy it into
      // their secret store without parsing nested fields.
      return {
        token: result.plaintext,
        ...result.summary,
      };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        scopes: t.Optional(t.Array(t.String())),
        expiresAt: t.Optional(t.String()),
      }),
      detail: { tags: ['auth'] },
    },
  )

  // Revoke a token. Cross-tenant attempts collapse to 404 so the
  // route can't be used to probe for token IDs the caller doesn't own.
  .delete(
    '/:id',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      const ok = await getApiTokenManager().revoke(principal.userId, params.id);
      if (!ok) {
        set.status = 404;
        return { error: 'Token not found' };
      }
      return { revoked: true };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['auth'] },
    },
  );
