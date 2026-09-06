import { createHash, randomBytes } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { getConfig } from '@/config';
import { rawStore } from '@/db/cache';
import { getDb } from '@/db/postgres';
import { vault } from '@/db/schema/vault';
import { securityLogger } from '@/utils/logger';
import { getVault } from './vault';

// --- Types ---

interface OAuthProviderConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  redirectUri: string;
  additionalParams?: Record<string, string>;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
  scope?: string;
}

interface OAuthState {
  userId: string;
  provider: string;
  codeVerifier: string;
  createdAt: number;
}

export interface ConnectionStatus {
  connected: boolean;
  provider: string;
  scopes?: string[];
  expiresAt?: string;
  email?: string;
}

// --- PKCE Helpers ---

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// --- Vault credential names for OAuth ---

export const OAUTH_VAULT_NAMES = {
  google: {
    clientId: 'google_oauth_client_id',
    clientSecret: 'google_oauth_client_secret',
  },
  microsoft: {
    clientId: 'microsoft_oauth_client_id',
    clientSecret: 'microsoft_oauth_client_secret',
    tenantId: 'microsoft_oauth_tenant_id',
  },
} as const;

// --- Connector OAuth vault keys ---

/**
 * Vault entry names for one connector's OAuth material.
 *
 * The first three are system-scoped (the dynamically registered client and the
 * endpoints it was registered against); the last three are per-user. The
 * `connector_<id>_*` shape is the same one Atlassian already used, so
 * generalising it left every existing row where it was.
 */
export function connectorVaultKeys(connectorId: string): {
  clientId: string;
  authEndpoint: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: string;
} {
  return {
    clientId: `connector_${connectorId}_client_id`,
    authEndpoint: `connector_${connectorId}_auth_endpoint`,
    tokenEndpoint: `connector_${connectorId}_token_endpoint`,
    accessToken: `connector_${connectorId}_access_token`,
    refreshToken: `connector_${connectorId}_refresh_token`,
    tokenExpiry: `connector_${connectorId}_token_expiry`,
  };
}

const ATLASSIAN_KEYS = connectorVaultKeys('atlassian');

export const ATLASSIAN_USER_ACCESS_TOKEN_KEY = ATLASSIAN_KEYS.accessToken;
export const ATLASSIAN_USER_REFRESH_TOKEN_KEY = ATLASSIAN_KEYS.refreshToken;
export const ATLASSIAN_USER_TOKEN_EXPIRY_KEY = ATLASSIAN_KEYS.tokenExpiry;

// --- Provider Configs ---

async function getProviderConfig(provider: string): Promise<OAuthProviderConfig | null> {
  const config = getConfig();
  const publicUrl = config.oauth?.publicUrl || `http://localhost:${config.api.port}`;
  const v = getVault();

  switch (provider) {
    case 'google': {
      const clientId = await v.getByName('system', OAUTH_VAULT_NAMES.google.clientId);
      const clientSecret = await v.getByName('system', OAUTH_VAULT_NAMES.google.clientSecret);
      if (!clientId || !clientSecret) return null;
      return {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientId,
        clientSecret,
        scopes: [
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/documents',
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/contacts',
          'https://www.googleapis.com/auth/tasks',
          'openid',
          'email',
          'profile',
        ],
        redirectUri: `${publicUrl}/api/auth/oauth/google/callback`,
        additionalParams: { access_type: 'offline', prompt: 'consent' },
      };
    }
    case 'microsoft': {
      const clientId = await v.getByName('system', OAUTH_VAULT_NAMES.microsoft.clientId);
      const clientSecret = await v.getByName('system', OAUTH_VAULT_NAMES.microsoft.clientSecret);
      if (!clientId || !clientSecret) return null;
      const tenantId = await v.getByName('system', OAUTH_VAULT_NAMES.microsoft.tenantId) || 'common';
      return {
        authorizationUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        clientId,
        clientSecret,
        scopes: [
          'Mail.ReadWrite',
          'Mail.Send',
          'Calendars.ReadWrite',
          'Files.ReadWrite.All',
          'Tasks.ReadWrite',
          'Contacts.ReadWrite',
          'User.Read',
          'offline_access',
        ],
        redirectUri: `${publicUrl}/api/auth/oauth/microsoft/callback`,
      };
    }
    default: {
      // Every remaining provider is a built-in connector: a public OAuth 2.1
      // client registered dynamically against the connector's own discovery
      // document. Nothing here is connector-specific except the id.
      const { findConnector } = await import('@/connectors/definitions');
      const connector = findConnector(provider);
      if (!connector) return null;

      const keys = connectorVaultKeys(connector.id);
      const clientId = await v.getSystemSecret(keys.clientId);
      const authorizationUrl = await v.getSystemSecret(keys.authEndpoint);
      const tokenUrl = await v.getSystemSecret(keys.tokenEndpoint);
      if (!clientId || !authorizationUrl || !tokenUrl) return null;

      return {
        authorizationUrl,
        tokenUrl,
        clientId,
        // A public client: PKCE is the proof, there is no secret to keep.
        clientSecret: '',
        scopes: connector.oauthScopes,
        redirectUri: `${publicUrl}/api/connectors/${connector.id}/callback`,
        additionalParams: {},
      };
    }
  }
}

// --- OAuth Manager ---

export class OAuthManager {
  private store = rawStore();

  /**
   * Generate an authorization URL for the given provider.
   * Returns { url, state } — the frontend should redirect or open the URL.
   */
  async generateAuthorizationUrl(userId: string, provider: string): Promise<{ url: string }> {
    const providerConfig = await getProviderConfig(provider);
    if (!providerConfig) {
      throw new Error(`OAuth credentials not configured for ${provider}. Add your Client ID and Client Secret under Settings > General.`);
    }

    // PKCE
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // State (CSRF protection + links back to userId)
    const state = randomBytes(16).toString('hex');
    const stateData: OAuthState = {
      userId,
      provider,
      codeVerifier,
      createdAt: Date.now(),
    };

    // Store state in Redis with 10-minute TTL
    await this.store.setex(`oauth:state:${state}`, 600, JSON.stringify(stateData));

    // Build authorization URL
    const params = new URLSearchParams({
      client_id: providerConfig.clientId,
      redirect_uri: providerConfig.redirectUri,
      response_type: 'code',
      scope: providerConfig.scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...providerConfig.additionalParams,
    });

    const url = `${providerConfig.authorizationUrl}?${params.toString()}`;

    securityLogger.info({ userId, provider }, 'OAuth authorization URL generated');
    return { url };
  }

  /**
   * Exchange an authorization code for tokens.
   * Called by the callback endpoint after the provider redirects back.
   */
  async exchangeCode(provider: string, code: string, state: string): Promise<{ userId: string }> {
    // Validate state
    const stateJson = await this.store.get(`oauth:state:${state}`);
    if (!stateJson) {
      throw new Error('Invalid or expired OAuth state');
    }

    const stateData: OAuthState = JSON.parse(stateJson);
    if (stateData.provider !== provider) {
      throw new Error('OAuth state provider mismatch');
    }

    // Delete state (one-time use)
    await this.store.del(`oauth:state:${state}`);

    const providerConfig = await getProviderConfig(provider);
    if (!providerConfig) {
      throw new Error(`OAuth provider '${provider}' is not configured`);
    }

    // Exchange code for tokens
    const tokenResponse = await fetch(providerConfig.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: providerConfig.redirectUri,
        client_id: providerConfig.clientId,
        client_secret: providerConfig.clientSecret,
        code_verifier: stateData.codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      securityLogger.error({ provider, error }, 'OAuth token exchange failed');
      throw new Error('OAuth token exchange failed');
    }

    const tokens: OAuthTokenResponse = await tokenResponse.json();

    // Calculate expiry
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;

    // Store tokens in vault.
    // A connector uses dedicated per-key vault entries (connector_<id>_*)
    // consumed by getConnectorAccessToken; the generic storage path is skipped
    // to avoid maintaining two writers that can drift out of sync.
    const { isConnectorId } = await import('@/connectors/definitions');
    if (isConnectorId(provider)) {
      await storeConnectorUserTokens(
        provider,
        stateData.userId,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_in,
      );
    } else {
      await this.storeTokens(stateData.userId, provider, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        scopes: providerConfig.scopes,
      });
    }

    securityLogger.info({ userId: stateData.userId, provider }, 'OAuth tokens stored');
    return { userId: stateData.userId };
  }

  /**
   * Get a valid access token, refreshing if necessary.
   */
  async getValidToken(userId: string, provider: string): Promise<string | null> {
    const db = getDb();
    const v = getVault();

    // Find the OAuth credential for this user + provider
    const entries = await db
      .select()
      .from(vault)
      .where(
        and(
          eq(vault.userId, userId),
          eq(vault.credentialType, 'oauth_token'),
          eq(vault.isActive, true)
        )
      );

    const entry = entries.find(
      (e) => e.metadata?.oauthConfig?.provider === provider
    );

    if (!entry) return null;

    const oauthConfig = entry.metadata?.oauthConfig;
    if (!oauthConfig) return null;

    // Check if token is expired or about to expire (5 min buffer)
    if (oauthConfig.expiresAt) {
      const expiresAt = new Date(oauthConfig.expiresAt);
      const bufferMs = 5 * 60 * 1000;
      if (expiresAt.getTime() - Date.now() < bufferMs) {
        // Try to refresh
        if (oauthConfig.refreshToken) {
          try {
            return await this.refreshToken(userId, provider, entry.id, oauthConfig.refreshToken);
          } catch (err) {
            securityLogger.error({ userId, provider, error: (err as Error).message }, 'Token refresh failed');
            return null;
          }
        }
        return null; // Expired and no refresh token
      }
    }

    // Return current access token
    return v.get(userId, entry.id);
  }

  /**
   * Refresh an expired access token.
   */
  private async refreshToken(
    userId: string,
    provider: string,
    credentialId: string,
    refreshToken: string
  ): Promise<string> {
    const providerConfig = await getProviderConfig(provider);
    if (!providerConfig) {
      throw new Error(`OAuth provider '${provider}' is not configured`);
    }

    const tokenResponse = await fetch(providerConfig.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: providerConfig.clientId,
        client_secret: providerConfig.clientSecret,
      }),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      securityLogger.error({ provider, error }, 'OAuth token refresh failed');
      // Deactivate the stored credential since refresh failed
      const v = getVault();
      await v.delete(userId, credentialId);
      throw new Error(`Token refresh failed for ${provider}. Please reconnect.`);
    }

    const tokens: OAuthTokenResponse = await tokenResponse.json();

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;

    // Update stored tokens
    const v = getVault();
    const metadata: Record<string, unknown> = {
      oauthConfig: {
        provider,
        scopes: providerConfig.scopes,
        refreshToken: tokens.refresh_token || refreshToken, // Some providers rotate refresh tokens
        expiresAt,
      },
    };

    await v.update(userId, credentialId, {
      value: tokens.access_token,
      metadata,
    });

    securityLogger.info({ userId, provider }, 'OAuth token refreshed');
    return tokens.access_token;
  }

  /**
   * Store OAuth tokens in the vault.
   */
  private async storeTokens(
    userId: string,
    provider: string,
    tokens: {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: string;
      scopes: string[];
    }
  ): Promise<void> {
    const v = getVault();
    const db = getDb();

    // Check if we already have a credential for this provider
    const existing = await db
      .select()
      .from(vault)
      .where(
        and(
          eq(vault.userId, userId),
          eq(vault.credentialType, 'oauth_token'),
          eq(vault.isActive, true)
        )
      );

    const existingEntry = existing.find(
      (e) => e.metadata?.oauthConfig?.provider === provider
    );

    const metadata: Record<string, unknown> = {
      oauthConfig: {
        provider,
        scopes: tokens.scopes,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      },
    };

    if (existingEntry) {
      // Update existing credential
      await v.update(userId, existingEntry.id, {
        value: tokens.accessToken,
        metadata,
      });
    } else {
      // Create new credential
      await v.store(userId, `oauth_${provider}`, tokens.accessToken, {
        credentialType: 'oauth_token',
        description: `OAuth access token for ${provider}`,
        tags: ['oauth', provider],
        allowedTools: provider === 'google' ? ['google-workspace'] : ['microsoft365'],
        metadata,
      });
    }
  }

  /**
   * Revoke and remove OAuth tokens for a provider.
   */
  async revokeToken(userId: string, provider: string): Promise<void> {
    const db = getDb();
    const v = getVault();

    const entries = await db
      .select()
      .from(vault)
      .where(
        and(
          eq(vault.userId, userId),
          eq(vault.credentialType, 'oauth_token'),
          eq(vault.isActive, true)
        )
      );

    const entry = entries.find(
      (e) => e.metadata?.oauthConfig?.provider === provider
    );

    if (entry) {
      // Try to revoke the token with the provider
      try {
        const accessToken = await v.get(userId, entry.id);
        if (accessToken && provider === 'google') {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, {
            method: 'POST',
          });
        }
        // Microsoft doesn't have a simple revoke endpoint
      } catch {
        // Best effort — continue with local deletion
      }

      await v.delete(userId, entry.id);
      securityLogger.info({ userId, provider }, 'OAuth token revoked');
    }
  }

  /**
   * Get connection status for a provider.
   */
  async getConnectionStatus(userId: string, provider: string): Promise<ConnectionStatus> {
    const db = getDb();

    const entries = await db
      .select()
      .from(vault)
      .where(
        and(
          eq(vault.userId, userId),
          eq(vault.credentialType, 'oauth_token'),
          eq(vault.isActive, true)
        )
      );

    const entry = entries.find(
      (e) => e.metadata?.oauthConfig?.provider === provider
    );

    if (!entry) {
      return { connected: false, provider };
    }

    const oauthConfig = entry.metadata?.oauthConfig;
    return {
      connected: true,
      provider,
      scopes: oauthConfig?.scopes,
      expiresAt: oauthConfig?.expiresAt,
    };
  }
}

// Singleton
let oauthManagerInstance: OAuthManager | null = null;

export function getOAuthManager(): OAuthManager {
  if (!oauthManagerInstance) {
    oauthManagerInstance = new OAuthManager();
  }
  return oauthManagerInstance;
}

// --- Connector Dynamic Client Registration ---

interface ConnectorOAuthMetadata {
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/**
 * Register Octipus as a public OAuth client with a connector's authorization
 * server, using the RFC 7591 dynamic registration endpoint its discovery
 * document advertises.
 *
 * This is what makes a connector a definition rather than a code path: the
 * server tells us where to send the user and where to redeem the code, and we
 * tell it where to send them back.
 */
export async function discoverAndRegisterConnector(
  connectorId: string,
  publicUrl: string,
): Promise<ConnectorOAuthMetadata> {
  const { findConnector } = await import('@/connectors/definitions');
  const connector = findConnector(connectorId);
  if (!connector) throw new Error(`Unknown connector: ${connectorId}`);

  const discoveryRes = await fetch(connector.oauthDiscoveryUrl);
  if (!discoveryRes.ok) {
    throw new Error(`${connector.name} OAuth discovery failed (${discoveryRes.status})`);
  }
  const discovery = await discoveryRes.json() as {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
  };

  if (!discovery.registration_endpoint) {
    throw new Error(`${connector.name} OAuth discovery did not return a registration_endpoint`);
  }

  const registrationRes = await fetch(discovery.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Octipus',
      redirect_uris: [`${publicUrl}/api/connectors/${connector.id}/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });

  if (!registrationRes.ok) {
    const body = await registrationRes.text().catch(() => '');
    throw new Error(`${connector.name} client registration failed (${registrationRes.status}): ${body}`);
  }

  const registration = await registrationRes.json() as { client_id: string };
  if (!registration.client_id) {
    throw new Error(`${connector.name} registration response missing client_id`);
  }

  return {
    clientId: registration.client_id,
    authorizationEndpoint: discovery.authorization_endpoint,
    tokenEndpoint: discovery.token_endpoint,
  };
}

/** @deprecated Use `discoverAndRegisterConnector('atlassian', publicUrl)`. */
export function discoverAndRegisterAtlassian(publicUrl: string): Promise<ConnectorOAuthMetadata> {
  return discoverAndRegisterConnector('atlassian', publicUrl);
}

// --- Connector User Token Storage ---

export async function storeConnectorUserTokens(
  connectorId: string,
  userId: string,
  accessToken: string,
  refreshToken: string | undefined,
  expiresInSeconds: number | undefined,
): Promise<void> {
  const v = getVault();
  const keys = connectorVaultKeys(connectorId);
  const expiresAt = expiresInSeconds
    ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
    : '';

  // Delete existing tokens to avoid accumulation
  const existing = await v.list(userId);
  const tokenNames = [keys.accessToken, keys.refreshToken, keys.tokenExpiry];
  for (const entry of existing) {
    if (tokenNames.includes(entry.name ?? '')) {
      await v.delete(userId, entry.id);
    }
  }

  await v.store(userId, keys.accessToken, accessToken, { credentialType: 'oauth_token' });
  if (refreshToken) {
    await v.store(userId, keys.refreshToken, refreshToken, { credentialType: 'oauth_token' });
  }
  if (expiresAt) {
    await v.store(userId, keys.tokenExpiry, expiresAt, { credentialType: 'other' });
  }
}

/** @deprecated Use `storeConnectorUserTokens('atlassian', ...)`. */
export function storeAtlassianUserTokens(
  userId: string,
  accessToken: string,
  refreshToken: string | undefined,
  expiresInSeconds: number | undefined,
): Promise<void> {
  return storeConnectorUserTokens('atlassian', userId, accessToken, refreshToken, expiresInSeconds);
}

// --- Connector Access Token Retrieval (with refresh) ---

// Refresh buffer matches OAuthManager.getValidToken (5 minutes) so all
// providers refresh on the same cadence.
const CONNECTOR_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Per-(connector, user) in-flight refresh promises. Concurrent callers during
// expiry share a single token-endpoint round-trip instead of stampeding.
const connectorRefreshInFlight = new Map<string, Promise<string | null>>();

async function refreshConnectorAccessToken(
  connectorId: string,
  userId: string,
): Promise<string | null> {
  const v = getVault();
  const keys = connectorVaultKeys(connectorId);
  const refreshToken = await v.getByName(userId, keys.refreshToken);
  if (!refreshToken) return null;

  const tokenEndpoint = await v.getSystemSecret(keys.tokenEndpoint);
  const clientId = await v.getSystemSecret(keys.clientId);
  if (!tokenEndpoint || !clientId) return null;

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });

  if (!res.ok) {
    securityLogger.warn({ userId, connectorId, status: res.status }, 'Connector token refresh failed');
    return null;
  }

  const tokens = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  await storeConnectorUserTokens(
    connectorId,
    userId,
    tokens.access_token,
    tokens.refresh_token,
    tokens.expires_in,
  );
  return tokens.access_token;
}

export async function getConnectorAccessToken(
  connectorId: string,
  userId: string,
): Promise<string | null> {
  const v = getVault();
  const keys = connectorVaultKeys(connectorId);
  const accessToken = await v.getByName(userId, keys.accessToken);
  if (!accessToken) return null;

  const expiryStr = await v.getByName(userId, keys.tokenExpiry);
  const isExpired = expiryStr
    ? new Date(expiryStr).getTime() - CONNECTOR_REFRESH_BUFFER_MS < Date.now()
    : false;

  if (!isExpired) return accessToken;

  const inFlightKey = `${connectorId}:${userId}`;
  const existing = connectorRefreshInFlight.get(inFlightKey);
  if (existing) return existing;

  const refreshPromise = refreshConnectorAccessToken(connectorId, userId).finally(() => {
    connectorRefreshInFlight.delete(inFlightKey);
  });
  connectorRefreshInFlight.set(inFlightKey, refreshPromise);
  return refreshPromise;
}

/** @deprecated Use `getConnectorAccessToken('atlassian', userId)`. */
export function getAtlassianAccessToken(userId: string): Promise<string | null> {
  return getConnectorAccessToken('atlassian', userId);
}
