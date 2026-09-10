/** Authentication for requests from the MCP bridge to the Octipus backend. */

export interface AuthConfig {
  apiKey?: string;
  username?: string;
  password?: string;
}

interface LoginResponse {
  token?: unknown;
  expiresAt?: unknown;
}

const LOGIN_DEVICE_NAME = 'Octipus MCP server';

export function getAuthConfig(): AuthConfig {
  return {
    apiKey: process.env.OCTIPUS_API_KEY,
    username: process.env.OCTIPUS_USER,
    password: process.env.OCTIPUS_PASSWORD,
  };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Client-local authentication state, including one shared in-flight login. */
export class AuthSession {
  private cachedToken: string | null = null;
  private tokenRefreshAt = 0;
  private loginPromise: Promise<string> | null = null;

  constructor(private readonly config: AuthConfig = getAuthConfig()) {}

  get canRefresh(): boolean {
    return !this.config.apiKey && !!this.config.username && !!this.config.password;
  }

  async getHeaders(baseUrl: string): Promise<Record<string, string>> {
    if (this.config.apiKey) return bearer(this.config.apiKey);

    const { username, password } = this.config;
    if (!username && !password) return {};
    if (!username || !password) {
      throw new Error('Both OCTIPUS_USER and OCTIPUS_PASSWORD are required for credential login');
    }
    if (this.cachedToken && Date.now() < this.tokenRefreshAt) return bearer(this.cachedToken);
    return bearer(await this.login(baseUrl, username, password));
  }

  /** Refresh only if the rejected token is still this client's current token. */
  async refreshAfterUnauthorized(
    baseUrl: string,
    rejectedAuthorization: string | undefined,
  ): Promise<Record<string, string> | null> {
    if (!this.canRefresh) return null;
    const rejectedToken = rejectedAuthorization?.startsWith('Bearer ')
      ? rejectedAuthorization.slice('Bearer '.length)
      : null;
    if (!rejectedToken || rejectedToken === this.cachedToken) {
      this.cachedToken = null;
      this.tokenRefreshAt = 0;
    }
    return this.getHeaders(baseUrl);
  }

  private async login(baseUrl: string, username: string, password: string): Promise<string> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.performLogin(baseUrl, username, password);
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  private async performLogin(baseUrl: string, username: string, password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login-mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, deviceName: LOGIN_DEVICE_NAME }),
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { requiresTOTP?: unknown } | null;
      const reason = payload?.requiresTOTP === true ? ' (TOTP is required)' : '';
      throw new Error(`Login failed: ${res.status}${reason}`);
    }

    const data = await res.json() as unknown;
    if (!data || typeof data !== 'object') {
      throw new Error('Login response is not an object');
    }
    const login = data as LoginResponse;
    if (typeof login.token !== 'string' || login.token.length === 0) {
      throw new Error('Login response missing token');
    }
    if (typeof login.expiresAt !== 'string' && !(login.expiresAt instanceof Date)) {
      throw new Error('Login response missing expiresAt');
    }

    const expiresAt = new Date(login.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('Login response has invalid or expired expiresAt');
    }

    const lifetime = expiresAt - Date.now();
    this.cachedToken = login.token;
    this.tokenRefreshAt = expiresAt - Math.min(30_000, Math.floor(lifetime / 2));
    return login.token;
  }
}
