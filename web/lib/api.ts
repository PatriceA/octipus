const API_PORT = process.env.NEXT_PUBLIC_API_PORT || '3005';

/**
 * Get the API URL. Resolution order:
 *   1. NEXT_PUBLIC_API_URL env var (explicit full URL, build-time)
 *   2. Auto-detect from browser hostname + API_PORT (works across LAN)
 *
 * When accessing http://192.168.1.100:3007, the API URL becomes
 * http://192.168.1.100:3005/api automatically — no config needed.
 */
export function getApiUrl(): string {
  // Explicit env override takes priority
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  // In browser: derive from current hostname
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:${API_PORT}/api`;
  }
  // SSR fallback
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

// WebSocket connection
export function createWebSocket(path: string = '/ws'): WebSocket {
  const token = api.getToken();
  const apiUrl = getApiUrl();
  const wsUrl = apiUrl.replace(/^http/, 'ws').replace('/api', '');
  return new WebSocket(`${wsUrl}${path}?token=${token}`);
}
