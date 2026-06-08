/**
 * APIClient — thin wrapper around fetch for E2E tests.
 *
 * Transparently retries HTTP 429 (rate-limited) responses: the suite fires
 * 130+ sequential requests from a single user well inside the rate-limit
 * window, so without backoff the back half of the run gets throttled even
 * though nothing is wrong. We honor `Retry-After` when present and otherwise
 * fall back to capped exponential backoff.
 */

import { fixtures } from './fixtures';

/** Max 429 retries before giving up and surfacing the 429 to the test. */
const MAX_RETRIES = 5;
/** Cap on any single backoff wait, so a bogus Retry-After can't stall the run. */
const MAX_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms, or null. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

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

    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (response.status !== 429 || attempt >= MAX_RETRIES) break;

      // Drain the body so the connection can be reused before we wait.
      await response.text().catch(() => {});
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      // Fallback: exponential backoff (1s, 2s, 4s, …) jittered to spread retries.
      const backoff = 2 ** attempt * 1000 + Math.floor(attempt * 137);
      const wait = Math.min(retryAfter ?? backoff, MAX_WAIT_MS);
      await sleep(wait);
    }

    const data = await response.json().catch(() => ({}) as T);
    return { status: response.status, data: data as T };
  }
}
