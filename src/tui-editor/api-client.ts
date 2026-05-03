/**
 * Thin `fetch` wrapper that injects `X-Octipus-Workspace` from the
 * workspace store on every request.
 *
 * Used by the TUI editor for HTTP calls (workspace listing, future
 * agent / vault / sessions reads) so a workspace switch
 * automatically narrows the next request without manual header
 * plumbing at every call site.
 *
 * Returns null on network failure so call sites can `if (!data)
 * return;` without try/catch — the TUI is permitted to silently
 * skip an optional refresh; surface errors only when the data is
 * required.
 */
import type { WorkspaceStore } from './stores/workspace-store';

export interface ApiClientOptions {
  baseUrl: string;
  workspaceStore: WorkspaceStore;
}

export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  /**
   * GET request. Returns parsed JSON on success, `null` on any
   * failure (network error, non-2xx status). Caller checks for null.
   */
  async getJson<T>(path: string): Promise<T | null> {
    const url = path.startsWith('http') ? path : `${this.opts.baseUrl}${path}`;
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      const ws = this.opts.workspaceStore.get().activeSlug;
      if (ws) headers['x-octipus-workspace'] = ws;
      const r = await fetch(url, { headers });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  }

  /** POST JSON. Returns the parsed JSON response, or null on failure. */
  async postJson<T>(path: string, body: unknown): Promise<T | null> {
    const url = path.startsWith('http') ? path : `${this.opts.baseUrl}${path}`;
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
      };
      const ws = this.opts.workspaceStore.get().activeSlug;
      if (ws) headers['x-octipus-workspace'] = ws;
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  }
}
