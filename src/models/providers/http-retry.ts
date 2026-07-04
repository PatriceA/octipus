import { modelLogger } from '@/utils/logger';

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

const MAX_RETRY_AFTER_WAIT_MS = 10_000;

/**
 * fetch() with a single Retry-After-honoring retry on 429.
 * Any other status (including 429 without a Retry-After header) is returned
 * as-is so callers keep their existing classification behavior.
 */
export async function fetchWithRetryAfter(
  url: string | URL,
  init: RequestInit,
  providerName: string,
): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 429) return res;

  const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after') ?? null);
  if (retryAfterMs == null) return res;

  const waitMs = Math.min(retryAfterMs, MAX_RETRY_AFTER_WAIT_MS);
  modelLogger.warn(
    { provider: providerName, waitMs, retryAfterMs },
    '429 with Retry-After — retrying once after backoff',
  );
  // Drain the failed body so the connection can be reused.
  await res.body?.cancel().catch(() => {});
  await new Promise((r) => setTimeout(r, waitMs));
  return fetch(url, init);
}

/**
 * Idle (per-read) abort signal for streaming responses. Unlike
 * AbortSignal.timeout(), the clock resets on every touch(), so a healthy
 * long-running stream is never killed mid-tool-call while a hung one still
 * gets aborted after `idleMs` of silence.
 */
export function createIdleAbort(
  idleMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; touch: () => void; clear: () => void } {
  const ctrl = new AbortController();
  const onIdle = () => ctrl.abort(new Error(`stream idle timeout after ${idleMs}ms`));
  let timer = setTimeout(onIdle, idleMs);
  return {
    signal: external ? AbortSignal.any([ctrl.signal, external]) : ctrl.signal,
    touch: () => {
      clearTimeout(timer);
      timer = setTimeout(onIdle, idleMs);
    },
    clear: () => clearTimeout(timer),
  };
}

/** Combine an optional caller AbortSignal with a total-duration timeout. */
export function withTimeoutSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}
