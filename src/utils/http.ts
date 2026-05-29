/**
 * HTTP helpers for outbound requests.
 */

/**
 * Timeout-only fetch for calls to trusted, known external endpoints (Twilio,
 * WhatsApp, Google/M365, provider STT, …) where SSRF validation isn't wanted
 * because the host may be operator-configured/internal. This does NOT validate
 * the URL — only use it with non-user-controlled URLs.
 *
 * Adds an AbortSignal timeout (default 30s). If the caller already passed a
 * `signal`, the two are combined so either can abort the request.
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 30_000, signal: callerSignal, ...init } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? (AbortSignal as unknown as { any(signals: AbortSignal[]): AbortSignal }).any([callerSignal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...init, signal });
}
