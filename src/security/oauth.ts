import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { getConfig } from '@/config';
import { rawStore } from '@/db/cache';
import { getDb } from '@/db/postgres';
import { vault, type VaultEntry } from '@/db/schema/vault';
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

/**
 * What the provider says it granted. The configured list is what was asked
 * for: after a scope is added there, an older connection has not been given
 * it, and recording the configured list would claim it had.
 */
function grantedScopes(tokens: OAuthTokenResponse, asked: string[]): string[] {
  const granted = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [];
  return granted.length ? granted : asked;
}

interface OAuthState {
  userId: string;
  provider: string;
  codeVerifier: string;
  createdAt: number;
  /**
   * The hash of the nonce the starting browser holds in a cookie
   * (`src/api/oauth-browser.ts`): the callback must come from that browser,
   * so an authorization URL handed to someone else cannot connect their
   * account as the user's.
   */
  browserBinding: string;
  /**
   * Connect a further account of this provider next to the ones already
   * connected, instead of reconnecting the default one.
   */
  addAccount?: boolean;
}

/** Same binding, in constant time. */
function sameBrowser(expected: string, actual: string | null): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export interface ConnectionStatus {
  connected: boolean;
  provider: string;
  scopes?: string[];
  expiresAt?: string;
  email?: string;
  /** How many accounts of this provider are connected. */
  accounts?: number;
}

/** One connected account of a provider. */
export interface OAuthAccount {
  provider: string;
  /** The account's address, lowercased. Absent while the provider has not told it. */
  account?: string;
  /** The account agents, the heartbeat and every request without an `account` use. */
  isDefault: boolean;
  scopes?: string[];
  expiresAt?: string;
}

/** How many accounts of one provider a user may connect. */
export const MAX_ACCOUNTS_PER_PROVIDER = 5;

/** An account address as stored and compared: trimmed and lowercased. Null when it is not an address. */
export function normalizeAccount(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(v) ? v : null;
}

type OAuthEntry = Pick<VaultEntry, 'id' | 'createdAt' | 'metadata'>;
const accountOf = (entry: OAuthEntry): string | undefined => normalizeAccount(entry.metadata?.oauthConfig?.account) ?? undefined;

/**
 * A provider's token entries, the default first: the one marked default,
 * else the one connected first. An entry from before several accounts were
 * possible carries no mark and is the only one, so it stays the default. Pure.
 */
export function orderAccounts<T extends OAuthEntry>(entries: T[], provider: string): T[] {
  const rank = (e: T) => (e.metadata?.oauthConfig?.isDefault === true ? 0 : e.metadata?.oauthConfig?.isDefault === false ? 2 : 1);
  return entries
    .filter((e) => e.metadata?.oauthConfig?.provider === provider)
    .sort((a, b) => rank(a) - rank(b) || new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
}

/** The entry a request means: the named account, else the default. Never another entry. Pure. */
export function pickAccount<T extends OAuthEntry>(ordered: T[], account?: string | null): T | null {
  if (!account) return ordered[0] ?? null;
  const wanted = normalizeAccount(account);
  return (wanted && ordered.find((e) => accountOf(e) === wanted)) || null;
}

/**
 * The address of the account a token belongs to, asked of the provider with
 * that token. Undefined when the provider does not say.
 */
async function fetchAccountAddress(provider: string, accessToken: string): Promise<string | undefined> {
  const url = provider === 'google'
    ? 'https://openidconnect.googleapis.com/v1/userinfo'
    : provider === 'microsoft' ? 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName' : null;
  if (!url) return undefined;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) { await res.body?.cancel(); return undefined; }
  const body = (await res.json().catch(() => null)) as { email?: unknown; mail?: unknown; userPrincipalName?: unknown } | null;
  return normalizeAccount(body?.email ?? body?.mail ?? body?.userPrincipalName) ?? undefined;
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
          // Calendars other people shared with the user. Asked for at connect
          // time only: an account connected earlier keeps its consent (and its
          // own calendars) until the user connects it again.
          'Calendars.ReadWrite.Shared',
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
  private store = rawStore();

  /**
   * Generate an authorization URL for the given provider.
   * Returns { url, state } — the frontend should redirect or open the URL.
   */
  async generateAuthorizationUrl(userId: string, provider: string, opts: { browserBinding: string; addAccount?: boolean }): Promise<{ url: string }> {
    if (!/^[0-9a-f]{64}$/.test(opts.browserBinding)) throw new Error('OAuth: the flow must be bound to the browser that starts it');
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
      browserBinding: opts.browserBinding,
      ...(opts.addAccount ? { addAccount: true } : {}),
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
      // A further account: let the person pick which one, not the one already signed in.
      ...(opts.addAccount ? { prompt: provider === 'google' ? 'select_account consent' : 'select_account' } : {}),
    });

    const url = `${providerConfig.authorizationUrl}?${params.toString()}`;

    securityLogger.info({ userId, provider, addAccount: opts.addAccount === true }, 'OAuth authorization URL generated');
    return { url };
  }

  /**
   * Exchange an authorization code for tokens.
   * Called by the callback endpoint after the provider redirects back.
   */
  async exchangeCode(provider: string, code: string, state: string, browserBinding: string | null): Promise<{ userId: string }> {
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
    // Completed in another browser than the one that started it: refused
    // before the code is redeemed (a state from before the binding has none).
    if (!stateData.browserBinding || !sameBrowser(stateData.browserBinding, browserBinding)) {
      securityLogger.warn({ provider, userId: stateData.userId }, 'OAuth callback from another browser than the one that started the flow');
      throw new Error('This sign-in was finished in a different browser than the one that started it. Start the connection again from Octipus, in this browser.');
    }

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

    // Which account this is: asked of the provider with the new token itself.
    const account = await fetchAccountAddress(provider, tokens.access_token).catch(() => undefined);

    // Store tokens in vault.
    await this.storeTokens(stateData.userId, provider, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      scopes: grantedScopes(tokens, providerConfig.scopes),
    }, { account, addAccount: stateData.addAccount === true });

    securityLogger.info({ userId: stateData.userId, provider }, 'OAuth tokens stored');
    return { userId: stateData.userId };
  }

  /** The user's own OAuth entries for a provider, the default first. */
  private async providerEntries(userId: string, provider: string): Promise<VaultEntry[]> {
    const entries = await getDb()
      .select()
      .from(vault)
      .where(
        and(
          eq(vault.userId, userId),
          // The user's own tokens only: a space secret this user stored
          // (scope 'space') is the space's, never theirs (§9.5).
          eq(vault.scope, 'user'),
          eq(vault.credentialType, 'oauth_token'),
          eq(vault.isActive, true)
        )
      );
    return orderAccounts(entries, provider);
  }

  /**
   * Get a valid access token, refreshing if necessary. Without `account` the
   * provider's default account (agents and the heartbeat only ever use this);
   * with it that account of this user, or null when the user has not
   * connected it.
   */
  async getValidToken(userId: string, provider: string, account?: string | null): Promise<string | null> {
    const entry = pickAccount(await this.providerEntries(userId, provider), account);
    if (!entry) return null;
    return this.tokenOf(userId, provider, entry);
  }

  /** One entry's access token, refreshed when it is about to expire. */
  private async tokenOf(userId: string, provider: string, entry: VaultEntry): Promise<string | null> {
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
            return await this.refreshToken(userId, provider, entry.id, oauthConfig.refreshToken, oauthConfig);
          } catch (err) {
            securityLogger.error({ userId, provider, error: (err as Error).message }, 'Token refresh failed');
            return null;
          }
        }
        return null; // Expired and no refresh token
      }
    }

    // Return current access token
    return getVault().get(userId, entry.id);
  }

  /**
   * Refresh an expired access token.
   */
  private async refreshToken(
    userId: string,
    provider: string,
    credentialId: string,
    refreshToken: string,
    previous?: NonNullable<VaultEntry['metadata']>['oauthConfig']
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
        // Which account this is, and whether it is the default, stay as they were.
        ...(previous?.account ? { account: previous.account } : {}),
        ...(typeof previous?.isDefault === 'boolean' ? { isDefault: previous.isDefault } : {}),
        provider,
        scopes: grantedScopes(tokens, providerConfig.scopes),
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
    },
    options: { account?: string; addAccount?: boolean } = {}
  ): Promise<void> {
    const v = getVault();
    const entries = await this.providerEntries(userId, provider);
    const account = options.account ? normalizeAccount(options.account) ?? undefined : undefined;

    // The same account connected again updates its own entry; never a second copy.
    const same = account ? entries.find((e) => accountOf(e) === account) : undefined;
    let target: VaultEntry | undefined;
    if (same) target = same;
    else if (options.addAccount && entries.length > 0) {
      // Accounts are told apart by their address: without it a second one cannot be kept apart from the first.
      if (!account) throw new Error('The provider did not say which account was connected, so it was not added. Try again.');
      if (entries.length >= MAX_ACCOUNTS_PER_PROVIDER) throw new Error(`At most ${MAX_ACCOUNTS_PER_PROVIDER} accounts of one provider can be connected.`);
      target = undefined; // a new entry, next to the default
    } else target = entries[0]; // connecting (again) without "add": the default account, as before

    const keepAccount = account ?? (target ? accountOf(target) : undefined);
    const keepDefault = target?.metadata?.oauthConfig?.isDefault;
    const metadata: Record<string, unknown> = {
      oauthConfig: {
        provider,
        ...(keepAccount ? { account: keepAccount } : {}),
        ...(typeof keepDefault === 'boolean' ? { isDefault: keepDefault } : {}),
        scopes: tokens.scopes,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      },
    };

    if (target) {
      // Update existing credential
      await v.update(userId, target.id, {
        value: tokens.accessToken,
        metadata,
      });
    } else {
      // A further account gets a name of its own; the first keeps the one it always had.
      const first = entries.length === 0;
      const name = first ? `oauth_${provider}` : `oauth_${provider}_${createHash('sha256').update(account ?? '').digest('hex').slice(0, 8)}`;
      await v.store(userId, name, tokens.accessToken, {
        credentialType: 'oauth_token',
        description: first ? `OAuth access token for ${provider}` : `OAuth access token for ${provider} (${account})`,
        tags: ['oauth', provider],
        allowedTools: provider === 'google' ? ['google-workspace'] : ['microsoft365'],
        metadata,
      });
    }
  }

  /**
   * The connected accounts of a provider, the default first. An account
   * connected before addresses were kept is asked for its address once.
   */
  async listAccounts(userId: string, provider: string): Promise<OAuthAccount[]> {
    const entries = await this.providerEntries(userId, provider);
    const known = new Set(entries.map(accountOf).filter(Boolean));
    const out: OAuthAccount[] = [];
    for (const [index, entry] of entries.entries()) {
      let account = accountOf(entry);
      if (!account) {
        const token = await this.tokenOf(userId, provider, entry).catch(() => null);
        const found = token ? await fetchAccountAddress(provider, token).catch(() => undefined) : undefined;
        if (found && !known.has(found)) {
          account = found;
          known.add(found);
          const current = entry.metadata?.oauthConfig;
          if (current) await getVault().update(userId, entry.id, { metadata: { ...entry.metadata, oauthConfig: { ...current, account: found } } }).catch(() => null);
        }
      }
      const config = entry.metadata?.oauthConfig;
      out.push({ provider, ...(account ? { account } : {}), isDefault: index === 0, scopes: config?.scopes, expiresAt: config?.expiresAt });
    }
    return out;
  }

  /**
   * Whether `account` is one of the user's connected accounts of the
   * provider, and whether it is the default. Reads only what is stored.
   */
  async accountRole(userId: string, provider: string, account: string): Promise<'default' | 'other' | null> {
    const entries = await this.providerEntries(userId, provider);
    const entry = pickAccount(entries, account);
    if (!entry) return null;
    return entry === entries[0] ? 'default' : 'other';
  }

  /** Make one of the user's connected accounts the provider's default. */
  async setDefaultAccount(userId: string, provider: string, account: string): Promise<void> {
    const entries = await this.providerEntries(userId, provider);
    const target = account ? pickAccount(entries, account) : null;
    if (!target) throw new Error('That account is not connected.');
    for (const entry of entries) {
      const config = entry.metadata?.oauthConfig;
      if (!config) continue;
      await getVault().update(userId, entry.id, { metadata: { ...entry.metadata, oauthConfig: { ...config, isDefault: entry.id === target.id } } });
    }
    securityLogger.info({ userId, provider }, 'OAuth default account changed');
    // The index held the previous default's headers.
    if (entries[0]?.id !== target.id) await this.forgetMailIndex(userId, provider);
  }

  /**
   * Revoke and remove OAuth tokens for a provider.
   */
  async revokeToken(userId: string, provider: string, account?: string | null): Promise<void> {
    const v = getVault();
    const entries = await this.providerEntries(userId, provider);
    // Without an account: the provider is disconnected, every account of it.
    const picked = account ? pickAccount(entries, account) : null;
    if (account && !picked) throw new Error('That account is not connected.');
    const doomed = picked ? [picked] : entries;

    for (const entry of doomed) {
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
    }
    // The default went: the account connected next becomes it, said explicitly.
    const rest = entries.filter((e) => !doomed.includes(e));
    if (entries[0] && doomed.includes(entries[0]) && rest.length > 0) {
      const next = rest[0];
      for (const entry of rest) {
        const config = entry.metadata?.oauthConfig;
        if (config) await v.update(userId, entry.id, { metadata: { ...entry.metadata, oauthConfig: { ...config, isDefault: entry.id === next.id } } });
      }
    }
    if (doomed.length) securityLogger.info({ userId, provider, accounts: doomed.length }, 'OAuth token revoked');
    // The local mail index holds the default account's headers: gone, or now another account's default, it goes too.
    if (entries[0] && doomed.includes(entries[0])) await this.forgetMailIndex(userId, provider);
  }

  /** Drop the local index of a provider's default mailbox (core/email/mail-index.ts). Best effort; the index sweep retries. */
  private async forgetMailIndex(userId: string, provider: string): Promise<void> {
    if (provider !== 'google' && provider !== 'microsoft') return;
    await import('@/core/email/mail-index')
      .then(({ forgetMailIndex }) => forgetMailIndex(userId, provider))
      .catch((err: unknown) => securityLogger.warn({ userId, provider, err: String((err as Error)?.message ?? err).slice(0, 120) }, 'Mail index not deleted; the next index sweep deletes it'));
  }

  /**
   * Get connection status for a provider.
   */
  async getConnectionStatus(userId: string, provider: string): Promise<ConnectionStatus> {
    const entries = await this.providerEntries(userId, provider);
    const entry = entries[0];
    if (!entry) {
      return { connected: false, provider };
    }

    const oauthConfig = entry.metadata?.oauthConfig;
    const email = accountOf(entry);
    return {
      connected: true,
      provider,
      scopes: oauthConfig?.scopes,
      expiresAt: oauthConfig?.expiresAt,
      ...(email ? { email } : {}),
      accounts: entries.length,
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
