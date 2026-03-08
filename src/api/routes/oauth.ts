import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getOAuthManager } from '@/security/oauth';

const SUPPORTED_PROVIDERS = ['google', 'microsoft'];

export const oauthRoutes = new Elysia({ prefix: '/auth/oauth' })
  .use(apiContext)
  // Generate authorization URL — requires authenticated user
  .get(
    '/:provider/authorize',
    async ({ user, params, set }) => {
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
        const result = await manager.generateAuthorizationUrl(user.id, params.provider);
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
    async ({ params, query, set }) => {
      if (!SUPPORTED_PROVIDERS.includes(params.provider)) {
        set.status = 400;
        set.headers['content-type'] = 'text/html';
        return errorPage(`Unsupported provider: ${params.provider}`);
      }

      if (query.error) {
        set.headers['content-type'] = 'text/html';
        return errorPage(`Authorization denied: ${query.error_description || query.error}`);
      }

      if (!query.code || !query.state) {
        set.status = 400;
        set.headers['content-type'] = 'text/html';
        return errorPage('Missing authorization code or state');
      }

      try {
        const manager = getOAuthManager();
        await manager.exchangeCode(params.provider, query.code, query.state);

        set.headers['content-type'] = 'text/html';
        return successPage(params.provider);
      } catch (err) {
        set.status = 400;
        set.headers['content-type'] = 'text/html';
        return errorPage((err as Error).message);
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
    async ({ user, params, set }) => {
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
    async ({ user, params, set }) => {
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

// --- HTML templates for OAuth popup callback ---

function successPage(provider: string): string {
  // Sanitize provider — only allow alpha chars
  const safeProvider = provider.replace(/[^a-zA-Z]/g, '');
  const displayName = safeProvider.charAt(0).toUpperCase() + safeProvider.slice(1);
  const jsData = JSON.stringify({ type: 'oauth_callback', provider: safeProvider, success: true });

  return `<!DOCTYPE html>
<html>
<head><title>Connected</title><style>
body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f9fafb; }
.card { text-align: center; padding: 2rem; background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.icon { font-size: 3rem; margin-bottom: 1rem; }
h2 { margin: 0 0 0.5rem; color: #111827; }
p { color: #6b7280; margin: 0; }
</style></head>
<body>
<div class="card">
  <div class="icon">&#10004;</div>
  <h2>${displayName} Connected</h2>
  <p>You can close this window.</p>
</div>
<script>
  if (window.opener) { window.opener.postMessage(${jsData}, window.location.origin); }
  setTimeout(function() { window.close(); }, 2000);
</script>
</body></html>`;
}

function errorPage(message: string): string {
  // Sanitize for HTML context
  const safeHtml = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Use JSON.stringify for safe JS interpolation (escapes all special chars)
  const jsData = JSON.stringify({ type: 'oauth_callback', success: false, error: message });

  return `<!DOCTYPE html>
<html>
<head><title>Error</title><style>
body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f9fafb; }
.card { text-align: center; padding: 2rem; background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); max-width: 400px; }
.icon { font-size: 3rem; margin-bottom: 1rem; }
h2 { margin: 0 0 0.5rem; color: #111827; }
p { color: #dc2626; margin: 0; word-break: break-word; }
</style></head>
<body>
<div class="card">
  <div class="icon">&#10008;</div>
  <h2>Connection Failed</h2>
  <p>${safeHtml}</p>
</div>
<script>
  if (window.opener) { window.opener.postMessage(${jsData}, window.location.origin); }
</script>
</body></html>`;
}
