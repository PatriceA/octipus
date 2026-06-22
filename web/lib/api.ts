import { getDesktopApiUrl, getDesktopWsBase, isDesktop } from './tauri-backend';

const API_PORT = process.env.NEXT_PUBLIC_API_PORT || '3005';

/**
 * Get the API URL. Resolution order:
 *   1. Tauri desktop: the sidecar's loopback port (resolved at runtime — see
 *      tauri-backend.ts). There is no same-origin proxy in the packaged app.
 *   2. NEXT_PUBLIC_API_URL env var (explicit full URL, build-time)
 *   3. Same-origin /api proxy (works in Docker and reverse-proxy setups)
 *   4. Auto-detect from browser hostname + API_PORT (direct access, LAN-friendly)
 *
 * The Next.js rewrite in next.config.mjs proxies /api/* to the backend,
 * so browser requests stay on the same origin — no cross-port issues.
 */
export function getApiUrl(): string {
  // Desktop (Tauri) talks directly to the sidecar on its loopback port.
  // `ensureBackendReady()` runs before any request, so the port is cached.
  if (isDesktop()) {
    const desktopUrl = getDesktopApiUrl();
    if (desktopUrl) return desktopUrl;
  }
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

/**
 * HTTP methods we can safely re-send after a transient transport failure.
 *
 * The backend's Bun/Elysia HTTP listener can briefly drop and self-heal (see the
 * watchdog in src/api/server.ts), leaving a ~sub-second window where a request
 * either never connects or — worse — IS processed server-side but its response
 * is lost (the "Topics save: backend applied it, frontend showed 'Request
 * failed'" bug). Re-sending only makes sense for idempotent operations, where
 * replaying the same call reaches the same end state:
 *   - GET / HEAD / DELETE / PUT — idempotent by HTTP semantics.
 *   - PATCH — every PATCH endpoint in this app is a full-state field setter /
 *     upsert (topic config, model fields, skill fields), so replay is safe here.
 * POST is intentionally excluded — it creates, so a lost response must surface
 * rather than risk a duplicate.
 */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']);
/** Gateway statuses the Next proxy returns while the backend listener rebinds. */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const MAX_TRANSIENT_RETRIES = 3;
/** Backoff per retry attempt (ms) — totals ~2.1s, outlasting a ~1s rebind. */
const RETRY_BACKOFF_MS = [300, 600, 1200];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const retryable = RETRYABLE_METHODS.has(method);

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${apiUrl}${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          credentials: 'include',
        });
      } catch (err) {
        // Network-level failure (connection refused/reset) — typically the
        // listener-drop window. Retry idempotent calls; otherwise surface it.
        if (retryable && attempt < MAX_TRANSIENT_RETRIES) {
          await delay(RETRY_BACKOFF_MS[attempt]);
          continue;
        }
        throw err instanceof Error ? err : new Error('Network request failed');
      }

      // The proxy returns 502/503/504 while the backend listener is rebinding.
      // For idempotent methods the call may have already committed (lost
      // response) or never ran — replaying reaches the same state either way.
      if (retryable && TRANSIENT_STATUSES.has(response.status) && attempt < MAX_TRANSIENT_RETRIES) {
        await delay(RETRY_BACKOFF_MS[attempt]);
        continue;
      }

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
  // Desktop (Tauri): WS goes straight to the sidecar's loopback port.
  if (isDesktop()) {
    const desktopWs = getDesktopWsBase();
    if (desktopWs) return desktopWs;
  }
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
