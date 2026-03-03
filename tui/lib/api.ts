const API_URL = process.env.API_URL || 'http://localhost:3005/api';

class ApiClient {
  private token: string | null = process.env.MASTER_KEY || null;

  setToken(token: string | null) {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      let errorMsg = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        errorMsg = parsed.error || errorMsg;
      } catch {
        // Not JSON (e.g. HTML error page)
      }
      throw new Error(errorMsg);
    }

    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error('Failed to parse response as JSON');
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

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async login(username: string, password: string): Promise<boolean> {
    try {
      const data = await this.request<{ token: string }>('POST', '/auth/login', { username, password });
      if (data.token) {
        this.token = data.token;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

export const api = new ApiClient();
