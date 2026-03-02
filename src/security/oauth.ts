import { randomBytes, createHash } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { getRedis } from '@/db/redis';
import { getDb } from '@/db/postgres';
import { vault } from '@/db/schema/vault';
import { getVault } from './vault';
import { getConfig } from '@/config';
import { securityLogger } from '@/utils/logger';

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

// --- Provider Configs ---

function getProviderConfig(provider: string): OAuthProviderConfig | null {
  const config = getConfig();
  const oauth = (config as any).oauth;
  if (!oauth) return null;

  const publicUrl = oauth.publicUrl || `http://localhost:${config.api.port}`;

  switch (provider) {
    case 'google': {
      if (!oauth.google?.clientId || !oauth.google?.clientSecret) return null;
      return {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientId: oauth.google.clientId,
        clientSecret: oauth.google.clientSecret,
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
      if (!oauth.microsoft?.clientId || !oauth.microsoft?.clientSecret) return null;
      const tenantId = oauth.microsoft.tenantId || 'common';
      return {
        authorizationUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        clientId: oauth.microsoft.clientId,
        clientSecret: oauth.microsoft.clientSecret,
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
    default:
      return null;
  }
}

// --- OAuth Manager ---

export class OAuthManager {
  private redis = getRedis();

  /**
   * Generate an authorization URL for the given provider.
   * Returns { url, state } — the frontend should redirect or open the URL.
   */
  async generateAuthorizationUrl(userId: string, provider: string): Promise<{ url: string }> {
    const providerConfig = getProviderConfig(provider);
    if (!providerConfig) {
      throw new Error(`OAuth provider '${provider}' is not configured. Set ${provider.toUpperCase()}_OAUTH_CLIENT_ID and ${provider.toUpperCase()}_OAUTH_CLIENT_SECRET in .env`);
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
    await this.redis.setex(`oauth:state:${state}`, 600, JSON.stringify(stateData));

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
    const stateJson = await this.redis.get(`oauth:state:${state}`);
    if (!stateJson) {
      throw new Error('Invalid or expired OAuth state');
    }

    const stateData: OAuthState = JSON.parse(stateJson);
    if (stateData.provider !== provider) {
      throw new Error('OAuth state provider mismatch');
    }

    // Delete state (one-time use)
    await this.redis.del(`oauth:state:${state}`);

    const providerConfig = getProviderConfig(provider);
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
      throw new Error(`OAuth token exchange failed: ${error}`);
    }

    const tokens: OAuthTokenResponse = await tokenResponse.json();

    // Calculate expiry
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;

    // Store tokens in vault
    await this.storeTokens(stateData.userId, provider, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      scopes: providerConfig.scopes,
    });

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
      (e) => (e.metadata as any)?.oauthConfig?.provider === provider
    );

    if (!entry) return null;

    const oauthConfig = (entry.metadata as any)?.oauthConfig;
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
    const providerConfig = getProviderConfig(provider);
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
      (e) => (e.metadata as any)?.oauthConfig?.provider === provider
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
        allowedSkills: provider === 'google' ? ['google-workspace'] : ['microsoft365'],
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
      (e) => (e.metadata as any)?.oauthConfig?.provider === provider
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
      (e) => (e.metadata as any)?.oauthConfig?.provider === provider
    );

    if (!entry) {
      return { connected: false, provider };
    }

    const oauthConfig = (entry.metadata as any)?.oauthConfig;
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
