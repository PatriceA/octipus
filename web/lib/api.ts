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

    const apiUrl = getApiUrl();
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
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

// WebSocket connection (direct to backend — can't be proxied through Next.js rewrites)
export function createWebSocket(path: string = '/ws'): WebSocket {
  const token = api.getToken();
  let wsUrl: string;
  if (process.env.NEXT_PUBLIC_API_URL) {
    wsUrl = process.env.NEXT_PUBLIC_API_URL.replace(/^http/, 'ws').replace('/api', '');
  } else if (typeof window !== 'undefined') {
    const { hostname } = window.location;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${wsProtocol}//${hostname}:${API_PORT}`;
  } else {
    wsUrl = `ws://localhost:${API_PORT}`;
  }
  return new WebSocket(`${wsUrl}${path}?token=${token}`);
}
