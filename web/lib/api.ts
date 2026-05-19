const API_PORT = process.env.NEXT_PUBLIC_API_PORT || '3005';

/**
 * Get the API URL. Resolution order:
 *   1. NEXT_PUBLIC_API_URL env var (explicit full URL, build-time)
 *   2. Same-origin /api proxy (works in Docker and reverse-proxy setups)
 *   3. Auto-detect from browser hostname + API_PORT (direct access, LAN-friendly)
 *
 * The Next.js rewrite in next.config.mjs proxies /api/* to the backend,
 * so browser requests stay on the same origin — no cross-port issues.
 */
export function getApiUrl(): string {
  // Explicit env override takes priority
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  // In browser: use same-origin proxy (Next.js rewrites handle routing)
  if (typeof window !== 'undefined') {
    return '/api';
  }
  // SSR fallback (direct internal access)
  return `http://localhost:${API_PORT}/api`;
}

class ApiClient {
  private token: string | null = null;
  private workspaceSlug: string | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('auth_token', token);
    } else {
      localStorage.removeItem('auth_token');
    }
  }

  getToken(): string | null {
    if (this.token) return this.token;
    if (typeof window !== 'undefined') {
      this.token = localStorage.getItem('auth_token');
    }
    return this.token;
  }

  setWorkspaceSlug(slug: string | null) {
    this.workspaceSlug = slug;
  }

  getWorkspaceSlug(): string | null {
    return this.workspaceSlug;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (this.workspaceSlug) {
      headers['X-Octipus-Workspace'] = this.workspaceSlug;
    }

    const apiUrl = getApiUrl();
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });

    if (!response.ok) {
      if (response.status === 401) {
        this.setToken(null);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('auth:expired'));
        }
      }
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

export const api = new ApiClient();

function buildWsBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL.replace(/^http/, 'ws').replace('/api', '');
  }
  if (typeof window !== 'undefined') {
    const { hostname } = window.location;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${hostname}:${API_PORT}`;
  }
  return `ws://localhost:${API_PORT}`;
}

/**
 * Get a token usable for the WebSocket handshake (`?token=` URL param).
 *
 * Two paths:
 *   1. `localStorage.auth_token` — populated when the login response echoes
 *      a bearer token. This codebase uses HttpOnly cookies and does NOT
 *      echo, so this is almost always empty in the browser.
 *   2. `/api/auth/ws-ticket` — exchanges the HttpOnly cookie session for a
 *      short-lived bearer ticket. This is the path that lets WS work in
 *      the cookie-only setup. The fetch goes through Next.js's same-origin
 *      proxy so the cookie travels even though the WS itself is cross-origin.
 */
async function getWsToken(): Promise<string | null> {
  const stored = api.getToken();
  if (stored) return stored;
  try {
    const res = await api.get<{ token?: string }>('/auth/ws-ticket');
    return res.token ?? null;
  } catch {
    return null;
  }
}

// WebSocket connection (direct to backend — can't be proxied through Next.js rewrites)
export function createWebSocket(path: string = '/ws'): WebSocket {
  const token = api.getToken();
  return new WebSocket(`${buildWsBase()}${path}?token=${token ?? ''}`);
}

/**
 * Like `createWebSocket` but fetches a fresh ticket when no long-lived
 * bearer is stored in localStorage. Use this everywhere the legacy
 * `createWebSocket` was used from the browser — call sites that ran in
 * Node (tests, SSR) keep the sync entry point.
 */
export async function createAuthenticatedWebSocket(path: string = '/ws'): Promise<WebSocket> {
  const token = await getWsToken();
  return new WebSocket(`${buildWsBase()}${path}?token=${token ?? ''}`);
}
