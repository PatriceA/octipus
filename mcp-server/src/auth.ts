/**
 * Auth helper — reads credentials from environment and provides headers for API calls.
 *
 * Supports two modes:
 *   1. API key via OCTIPUS_API_KEY env var (sent as Bearer token)
 *   2. Username/password via OCTIPUS_USER + OCTIPUS_PASSWORD (auto-login, caches JWT)
 */

export interface AuthConfig {
  apiKey?: string;
  username?: string;
  password?: string;
}

let cachedToken: string | null = null;
let tokenExpiry = 0;

export function getAuthConfig(): AuthConfig {
  return {
    apiKey: process.env.OCTIPUS_API_KEY,
    username: process.env.OCTIPUS_USER,
    password: process.env.OCTIPUS_PASSWORD,
  };
}

/**
 * Get authorization headers for API requests.
 * If an API key is set, use it directly as a Bearer token.
 * If username/password are set, login first and cache the JWT.
 */
export async function getAuthHeaders(baseUrl: string): Promise<Record<string, string>> {
  const config = getAuthConfig();

  // Direct API key — simplest mode
  if (config.apiKey) {
    return { Authorization: `Bearer ${config.apiKey}` };
  }

  // Username/password — login and cache JWT
  if (config.username && config.password) {
    if (cachedToken && Date.now() < tokenExpiry) {
      return { Authorization: `Bearer ${cachedToken}` };
    }

    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: config.username,
        password: config.password,
      }),
    });

    if (!res.ok) {
      throw new Error(`Login failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      throw new Error('Login response missing token');
    }

    cachedToken = data.token;
    // Cache for 23 hours (tokens typically expire in 24h)
    tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;

    return { Authorization: `Bearer ${cachedToken}` };
  }

  // No auth configured — requests will be unauthenticated
  return {};
}
