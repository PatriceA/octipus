const DEFAULT_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3005/api';

/**
 * Get the current API URL. Checks localStorage first (user override),
 * then falls back to NEXT_PUBLIC_API_URL env var, then localhost default.
 */
export function getApiUrl(): string {
  if (typeof window !== 'undefined') {
    const override = localStorage.getItem('assistant_api_url');
    if (override) return override;
  }
  return DEFAULT_API_URL;
}

/**
 * Set a custom API URL (persisted in localStorage).
 * Pass null to reset to default.
 */
export function setApiUrl(url: string | null): void {
  if (typeof window === 'undefined') return;
  if (url) {
    // Normalize: ensure it ends with /api
    const normalized = url.replace(/\/+$/, '');
    localStorage.setItem('assistant_api_url', normalized.endsWith('/api') ? normalized : `${normalized}/api`);
  } else {
    localStorage.removeItem('assistant_api_url');
  }
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
