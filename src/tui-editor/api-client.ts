/**
 * Thin `fetch` wrapper that injects `X-Octipus-Workspace` from the
 * workspace store on every request.
 *
 * Used by the TUI editor for HTTP calls (workspace listing, future
 * agent / vault / sessions reads) so a workspace switch
 * automatically narrows the next request without manual header
 * plumbing at every call site.
 *
 * Every request has a timeout (`timeoutMs`, 5 s by default): a server
 * that accepts the connection and never answers must not leave an overlay
 * waiting forever. A failure comes back as `{ ok: false, error }` with the
 * reason — network error, timeout, HTTP status, a body that is not JSON —
 * for the caller to show.
 */
import type { WorkspaceStore } from './stores/workspace-store';

export interface ApiClientOptions {
  baseUrl: string;
  workspaceStore: WorkspaceStore;
  timeoutMs?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const DEFAULT_TIMEOUT_MS = 5000;

export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  /** GET request. */
  getJson<T>(path: string): Promise<ApiResult<T>> {
    return this.request<T>(path, { method: 'GET', headers: this.headers() });
  }

  /** POST JSON. */
  postJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    return this.request<T>(path, { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const ws = this.opts.workspaceStore.get().activeSlug;
    if (ws) headers['x-octipus-workspace'] = ws;
    return headers;
  }

  private async request<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
    const url = path.startsWith('http') ? path : `${this.opts.baseUrl}${path}`;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const doFetch = this.opts.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return { ok: false, error: `${url} did not answer within ${timeoutMs / 1000} s` };
      }
      return { ok: false, error: `${url} could not be reached: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!response.ok) return { ok: false, error: `${url} answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}` };
    try {
      return { ok: true, data: (await response.json()) as T };
    } catch (error) {
      return { ok: false, error: `${url} did not return JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
