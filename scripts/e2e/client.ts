/**
 * APIClient — thin wrapper around fetch for E2E tests.
 */

import { fixtures } from './fixtures';

export class APIClient {
  constructor(public readonly baseUrl: string) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    token?: string | null,
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const t = token ?? fixtures.authToken;
    if (t) {
      headers['Authorization'] = `Bearer ${t}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json().catch(() => ({}) as T);
    return { status: response.status, data: data as T };
  }
}
