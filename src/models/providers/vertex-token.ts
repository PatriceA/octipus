import { createSign } from 'node:crypto';

/**
 * Minimal Google service-account OAuth2 for Vertex AI — mints a short-lived
 * access token via the JWT-bearer grant and caches it with refresh-before-
 * expiry. No `google-auth-library` dependency: the JWT is RS256-signed with
 * node:crypto (see DESIGN.md "no dependency for something doable in ~20 lines").
 *
 * The service-account JSON never leaves the vault as anything but this in-memory
 * object; only the derived bearer token is handed to the OpenAI client.
 */
export interface ServiceAccount {
  client_email: string;
  /** PEM-encoded RSA private key (the `private_key` field of the SA JSON). */
  private_key: string;
  /** Defaults to https://oauth2.googleapis.com/token. */
  token_uri?: string;
  /** Optional — used as the default GCP project when none is configured. */
  project_id?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Refresh this long before the token's real expiry so calls never race it. */
const REFRESH_SKEW_MS = 60_000;
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

/**
 * Caches one access token per service account. `getAccessToken()` returns the
 * cached token until it is within REFRESH_SKEW_MS of expiry, then mints a new
 * one. Concurrent callers during a refresh share a single in-flight mint.
 */
export class VertexTokenManager {
  private token: string | null = null;
  private expiresAtMs = 0;
  private inflight: Promise<string> | null = null;

  /** `now` is injectable so the refresh logic is unit-testable without waiting. */
  constructor(
    private readonly sa: ServiceAccount,
    private readonly now: () => number = Date.now,
  ) {
    if (!sa.client_email || !sa.private_key) {
      throw new Error('Vertex service account missing client_email or private_key');
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.now() < this.expiresAtMs - REFRESH_SKEW_MS) {
      return this.token;
    }
    // Coalesce concurrent refreshes so a burst of requests mints exactly once.
    if (this.inflight) return this.inflight;
    this.inflight = this.mint().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Build and RS256-sign the assertion JWT. Exposed for unit tests. */
  buildAssertion(): string {
    const tokenUri = this.sa.token_uri || DEFAULT_TOKEN_URI;
    const iat = Math.floor(this.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({ iss: this.sa.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(this.sa.private_key);
    return `${signingInput}.${base64url(signature)}`;
  }

  private async mint(): Promise<string> {
    const tokenUri = this.sa.token_uri || DEFAULT_TOKEN_URI;
    const body = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion: this.buildAssertion() });

    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Vertex token mint failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) throw new Error('Vertex token response missing access_token');

    this.token = json.access_token;
    this.expiresAtMs = this.now() + (json.expires_in ?? 3600) * 1000;
    return this.token;
  }
}

/** Parse a service-account JSON string, surfacing a clear error on bad input. */
export function parseServiceAccount(json: string): ServiceAccount {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    throw new Error(`Vertex service account is not valid JSON: ${(err as Error).message}`);
  }
  const sa = obj as ServiceAccount;
  if (!sa || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') {
    throw new Error('Vertex service account JSON missing client_email / private_key');
  }
  return sa;
}
