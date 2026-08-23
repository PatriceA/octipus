import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { ATLASSIAN_CONNECTOR } from '@/connectors/atlassian/definition';
import type { ConnectorDefinition } from '@/connectors/types';
import {
  ATLASSIAN_USER_ACCESS_TOKEN_KEY,
  ATLASSIAN_USER_REFRESH_TOKEN_KEY,
  ATLASSIAN_USER_TOKEN_EXPIRY_KEY,
  OAuthManager,
  discoverAndRegisterAtlassian,
} from '@/security/oauth';
import { getVault } from '@/security/vault';

/** All available connectors. */
const ALL_CONNECTORS: ConnectorDefinition[] = [ATLASSIAN_CONNECTOR];

/** Vault key names for Atlassian user tokens. */
const ATLASSIAN_TOKEN_KEY_NAMES = [
  ATLASSIAN_USER_ACCESS_TOKEN_KEY,
  ATLASSIAN_USER_REFRESH_TOKEN_KEY,
  ATLASSIAN_USER_TOKEN_EXPIRY_KEY,
];

/** Derive the public URL used for OAuth redirect URIs. */
function getPublicUrl(): string {
  const config = getConfig();
  const oauthConfig = (config as any).oauth;
  return oauthConfig?.publicUrl ?? `http://localhost:${config.api.port}`;
}

/** HTML-escape a string to prevent XSS when interpolating into HTML. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Build HTML that closes the OAuth popup and posts a postMessage to opener. */
function buildCallbackHtml(opts: { success: boolean; connectorId: string; error?: string }): string {
  // Issue 3 fix: use JSON.stringify consistently for both connectorId and error
  const message = opts.success
    ? `{ type: 'connector:connected', connectorId: ${JSON.stringify(opts.connectorId)} }`
    : `{ type: 'connector:error', connectorId: ${JSON.stringify(opts.connectorId)}, error: ${JSON.stringify(opts.error ?? 'Unknown error')} }`;

  // Issue 2 fix: HTML-escape the error message before interpolating into HTML
  const safeError = escapeHtml(opts.error ?? '');

  return `<!DOCTYPE html><html><head><title>Connecting...</title></head><body>
<script>
  try { window.opener?.postMessage(${message}, window.location.origin); } catch(_) {}
  window.close();
</script>
<p>${opts.success ? 'Connected! You can close this window.' : `Error: ${safeError}`}</p>
</body></html>`;
}

/** CSP header value that allows the OAuth callback's inline script (no external resources). */
const CALLBACK_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";

export const connectorRoutes = new Elysia({ prefix: '/connectors' })
  .use(apiContext)

  // GET /connectors — list connectors with per-user connection status
  .get(
    '/',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const vault = getVault();

      const connectors = await Promise.all(
        ALL_CONNECTORS.map(async (connector) => {
          let connected = false;
          let expiresAt: string | undefined;

          try {
            // Check if user has an access token stored for this connector
            if (connector.id === 'atlassian') {
              const accessToken = await vault.getByName(user.id, ATLASSIAN_USER_ACCESS_TOKEN_KEY);
              connected = !!accessToken;

              if (connected) {
                const expiry = await vault.getByName(user.id, ATLASSIAN_USER_TOKEN_EXPIRY_KEY);
                expiresAt = expiry ?? undefined;
              }
            }
          } catch {
            // If vault lookup fails, treat as not connected
            connected = false;
          }

          return {
            id: connector.id,
            name: connector.name,
            description: connector.description,
            logoUrl: connector.logoUrl,
            connected,
            ...(expiresAt ? { expiresAt } : {}),
          };
        })
      );

      return { connectors };
    },
    { detail: { tags: ['connectors'] } }
  )

  // POST /connectors/:id/authorize — start OAuth flow, returns { url }
  .post(
    '/:id/authorize',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const { id } = params;

      if (id !== 'atlassian') {
        return { error: `Unknown connector: ${id}` };
      }

      const vault = getVault();
      const publicUrl = getPublicUrl();

      // Check if client_id is already registered; if not, do dynamic registration
      const existingClientId = await vault.getSystemSecret('connector_atlassian_client_id');

      if (!existingClientId) {
        try {
          const metadata = await discoverAndRegisterAtlassian(publicUrl);
          await vault.setSystemSecret('connector_atlassian_client_id', metadata.clientId);
          await vault.setSystemSecret('connector_atlassian_auth_endpoint', metadata.authorizationEndpoint);
          await vault.setSystemSecret('connector_atlassian_token_endpoint', metadata.tokenEndpoint);
        } catch (err) {
          return { error: `Failed to register Atlassian OAuth client: ${(err as Error).message}` };
        }
      }

      try {
        const oauthManager = new OAuthManager();
        const { url } = await oauthManager.generateAuthorizationUrl(user.id, 'atlassian');
        return { url };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['connectors'] },
    }
  )

  // GET /connectors/:id/callback — OAuth redirect callback (no auth required)
  .get(
    '/:id/callback',
    async ({ params, query }) => {
      const { id } = params;
      const code = query.code as string | undefined;
      const state = query.state as string | undefined;
      const error = query.error as string | undefined;

      // Issue 1 fix: override CSP for callback responses to allow the inline script
      const callbackHeaders = { 'Content-Type': 'text/html', 'Content-Security-Policy': CALLBACK_CSP };

      if (error) {
        const html = buildCallbackHtml({ success: false, connectorId: id, error });
        return new Response(html, { headers: callbackHeaders });
      }

      if (!code || !state) {
        const html = buildCallbackHtml({
          success: false,
          connectorId: id,
          error: 'Missing code or state parameter',
        });
        return new Response(html, { headers: callbackHeaders });
      }

      try {
        const oauthManager = new OAuthManager();
        await oauthManager.exchangeCode(id, code, state);
        const html = buildCallbackHtml({ success: true, connectorId: id });
        return new Response(html, { headers: callbackHeaders });
      } catch (err) {
        const html = buildCallbackHtml({
          success: false,
          connectorId: id,
          error: (err as Error).message,
        });
        return new Response(html, { headers: callbackHeaders });
      }
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        error: t.Optional(t.String()),
      }),
      detail: { tags: ['connectors'] },
    }
  )

  // DELETE /connectors/:id — disconnect user (remove stored tokens)
  .delete(
    '/:id',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const { id } = params;

      if (id !== 'atlassian') {
        return { error: `Unknown connector: ${id}` };
      }

      const vault = getVault();

      try {
        // List all user vault entries and delete matching token keys
        const entries = await vault.list(user.id);
        const tokenKeyNames = ATLASSIAN_TOKEN_KEY_NAMES;

        for (const entry of entries) {
          if (tokenKeyNames.includes(entry.name ?? '')) {
            await vault.delete(user.id, entry.id);
          }
        }

        return { success: true };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['connectors'] },
    }
  );
