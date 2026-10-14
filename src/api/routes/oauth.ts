import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { getOAuthManager } from '@/security/oauth';
import { bindBrowser, callbackBrowser } from '@/api/oauth-browser';
import { sendPopupCallback } from '@/api/popup-callback';

const SUPPORTED_PROVIDERS = ['google', 'microsoft'];

export const oauthRoutes = new Elysia({ prefix: '/auth/oauth' })
  .use(apiContext)
  // Generate authorization URL — requires authenticated user
  .get(
    '/:provider/authorize',
    async ({ user, params, set, request }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      if (!SUPPORTED_PROVIDERS.includes(params.provider)) {
        set.status = 400;
        return { error: `Unsupported provider: ${params.provider}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}` };
      }

      try {
        const manager = getOAuthManager();
        // Bound to this browser: the callback checks the cookie.
        const browser = bindBrowser(request);
        const result = await manager.generateAuthorizationUrl(user.id, params.provider, { browserBinding: browser.binding });
        set.headers['Set-Cookie'] = browser.setCookie;
        return result;
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    {
      params: t.Object({ provider: t.String() }),
      detail: { tags: ['auth'] },
    }
  )

  // OAuth callback — public endpoint (state-based auth)
  .get(
    '/:provider/callback',
    async ({ params, query, set, request }) => {
      if (!SUPPORTED_PROVIDERS.includes(params.provider)) {
        set.status = 400;
        return errorPage(set, `Unsupported provider: ${params.provider}`);
      }

      if (query.error) {
        return errorPage(set, `Authorization denied: ${query.error_description || query.error}`);
      }

      if (!query.code || !query.state) {
        set.status = 400;
        return errorPage(set, 'Missing authorization code or state');
      }

      try {
        const manager = getOAuthManager();
        await manager.exchangeCode(params.provider, query.code, query.state, callbackBrowser(request));

        return successPage(set, params.provider);
      } catch (err) {
        set.status = 400;
        return errorPage(set, (err as Error).message);
      }
    },
    {
      params: t.Object({ provider: t.String() }),
      query: t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        error: t.Optional(t.String()),
        error_description: t.Optional(t.String()),
      }),
      detail: { tags: ['auth'] },
    }
  )

  // Connection status — requires authenticated user
  .get(
    '/:provider/status',
    async ({ user, params, set, request }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      if (!SUPPORTED_PROVIDERS.includes(params.provider)) {
        set.status = 400;
        return { error: `Unsupported provider: ${params.provider}` };
      }

      const manager = getOAuthManager();
      return manager.getConnectionStatus(user.id, params.provider);
    },
    {
      params: t.Object({ provider: t.String() }),
      detail: { tags: ['auth'] },
    }
  )

  // Disconnect — requires authenticated user
  .post(
    '/:provider/disconnect',
    async ({ user, params, set, request }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      if (!SUPPORTED_PROVIDERS.includes(params.provider)) {
        set.status = 400;
        return { error: `Unsupported provider: ${params.provider}` };
      }

      const manager = getOAuthManager();
      await manager.revokeToken(user.id, params.provider);
      return { success: true, provider: params.provider };
    },
    {
      params: t.Object({ provider: t.String() }),
      detail: { tags: ['auth'] },
    }
  );

// --- The popup's callback page ---

function successPage(set: { headers: Record<string, string> }, provider: string): string {
  const safeProvider = provider.replace(/[^a-zA-Z]/g, '');
  const displayName = safeProvider.charAt(0).toUpperCase() + safeProvider.slice(1);
  return sendPopupCallback(set, {
    ok: true,
    heading: `${displayName} Connected`,
    detail: 'You can close this window.',
    message: { type: 'oauth_callback', provider: safeProvider, success: true },
    closeAfterMs: 2000,
  });
}

function errorPage(set: { headers: Record<string, string> }, message: string): string {
  return sendPopupCallback(set, {
    ok: false,
    heading: 'Connection Failed',
    detail: message,
    message: { type: 'oauth_callback', success: false, error: message },
  });
}
