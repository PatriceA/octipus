import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { getOAuthManager, normalizeAccount } from '@/security/oauth';
import { bindBrowser, callbackBrowser } from '@/api/oauth-browser';
import { sendPopupCallback } from '@/api/popup-callback';

const SUPPORTED_PROVIDERS = ['google', 'microsoft'];

export const oauthRoutes = new Elysia({ prefix: '/auth/oauth' })
  .use(apiContext)
  // Generate authorization URL — requires authenticated user
  .get(
    '/:provider/authorize',
    async ({ user, params, query, set, request }) => {
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
        // `addAccount`: connect a further account next to the ones connected, instead of reconnecting the default.
        const result = await manager.generateAuthorizationUrl(user.id, params.provider, { browserBinding: browser.binding, addAccount: query.addAccount === 'true' });
        set.headers['Set-Cookie'] = browser.setCookie;
        return result;
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    {
      params: t.Object({ provider: t.String() }),
      query: t.Object({ addAccount: t.Optional(t.String({ maxLength: 5 })) }),
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

  // The connected accounts of a provider, the default first — requires authenticated user
  .get(
    '/:provider/accounts',
    async ({ user, params, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      if (!SUPPORTED_PROVIDERS.includes(params.provider)) {
        set.status = 400;
        return { error: `Unsupported provider: ${params.provider}` };
      }
      const accounts = await getOAuthManager().listAccounts(user.id, params.provider);
      // Scopes and expiry are the connection's business, not the page's.
      return { provider: params.provider, accounts: accounts.map(({ account, isDefault }) => ({ ...(account ? { account } : {}), isDefault })) };
    },
    {
      params: t.Object({ provider: t.String() }),
      detail: { tags: ['auth'] },
    }
  )

  // Make one connected account the provider's default — requires authenticated user
  .post(
    '/:provider/accounts/default',
    async ({ user, params, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      if (!SUPPORTED_PROVIDERS.includes(params.provider)) {
        set.status = 400;
        return { error: `Unsupported provider: ${params.provider}` };
      }
      const account = normalizeAccount(body.account);
      if (!account) {
        set.status = 400;
        return { error: 'account must be an email address' };
      }
      try {
        await getOAuthManager().setDefaultAccount(user.id, params.provider, account);
        return { success: true, provider: params.provider, account };
      } catch (err) {
        set.status = 404;
        return { error: (err as Error).message };
      }
    },
    {
      params: t.Object({ provider: t.String() }),
      body: t.Object({ account: t.String({ minLength: 3, maxLength: 320 }) }),
      detail: { tags: ['auth'] },
    }
  )

  // Disconnect — requires authenticated user. With `account`, that account only; without, every account of the provider.
  .post(
    '/:provider/disconnect',
    async ({ user, params, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      if (!SUPPORTED_PROVIDERS.includes(params.provider)) {
        set.status = 400;
        return { error: `Unsupported provider: ${params.provider}` };
      }

      const account = body?.account === undefined ? undefined : normalizeAccount(body.account);
      if (account === null) {
        set.status = 400;
        return { error: 'account must be an email address' };
      }
      try {
        await getOAuthManager().revokeToken(user.id, params.provider, account);
      } catch (err) {
        set.status = 404;
        return { error: (err as Error).message };
      }
      return { success: true, provider: params.provider, ...(account ? { account } : {}) };
    },
    {
      params: t.Object({ provider: t.String() }),
      body: t.Optional(t.Object({ account: t.Optional(t.String({ maxLength: 320 })) })),
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
