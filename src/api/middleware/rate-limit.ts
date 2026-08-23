import { Elysia } from 'elysia';
import type { Principal } from '@/security/principal';
import { isAuthenticated } from '@/security/principal';
import { getRateLimiter } from '@/security/rate-limiter';
import { apiLogger } from '@/utils/logger';

const AUTH_RATE_LIMIT = 20; // requests per window
const AUTH_RATE_WINDOW_SECS = 60; // 1 minute

/**
 * The auth endpoints that TAKE a credential, and so are worth a tight per-IP
 * window: each one is an attempt an attacker can repeat.
 *
 * Deliberately not "everything under /api/auth". The web app reads
 * `/api/auth/me` on every page mount and takes a `ws-ticket` per socket, so a
 * user simply clicking through the navigation spent the 20/min budget meant
 * for credential stuffing — and a 429 on `me` reads to the front-end as
 * "not logged in", which is how a normal session degrades into a half-broken
 * page. Session reads fall through to the baseline per-IP and per-user layers
 * below, which is where ordinary traffic belongs.
 */
export function isCredentialAttempt(path: string): boolean {
  return (
    path.startsWith('/api/auth/login') ||
    path.startsWith('/api/auth/register') ||
    path.startsWith('/api/auth/passkey') ||
    path.startsWith('/api/auth/oauth') ||
    path.startsWith('/api/auth/password') ||
    path.startsWith('/api/auth/totp') ||
    path.startsWith('/api/auth/2fa') ||
    // Redeeming a channel-binding code takes a 6-to-12-character secret and,
    // on a hit, attaches someone else's pending channel identity to the
    // caller's account. That is a credential attempt whatever it is called, and
    // narrowing this list from all of `/api/auth/*` to a keyword set dropped
    // it — leaving only the loose baseline layers between a caller and that
    // code space.
    path.startsWith('/api/auth/channel-bindings/redeem')
  );
}
const USER_QUOTA_WINDOW_SECS = 60;

// Baseline per-IP ceiling on all /api/* traffic, applied in EVERY deployment
// mode. (The per-user quota layer below also fires for every authenticated
// user — Octipus is always multi-user — so the two stack.)
// Generous enough not to bother a real interactive user (~10 req/s) while
// still capping a runaway client or scripted abuse of expensive model routes.
// Override with API_RATE_LIMIT_PER_MINUTE (0 disables the baseline).
const BASELINE_IP_LIMIT = (() => {
  const raw = Number(process.env.API_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(raw) && raw >= 0 ? raw : 600;
})();
const BASELINE_IP_WINDOW_SECS = 60;

// A rejected client retries hard, so logging every 429 floods the log with
// near-identical lines. Throttle each distinct key (IP or user) to one warn
// per window — the operator still sees that throttling is happening without
// the spam.
const lastWarnAt = new Map<string, number>();
// Hard cap so a flood of distinct keys (e.g. a spoofed-IP storm where every
// entry is still in-window) can't grow the map without bound. Map preserves
// insertion order, so the first key is the oldest-inserted — evict it.
const WARN_MAP_MAX = 5000;
function shouldWarn(key: string, windowSecs: number): boolean {
  const now = Date.now();
  const prev = lastWarnAt.get(key);
  if (prev !== undefined && now - prev < windowSecs * 1000) return false;
  // Drop expired entries first; if still over the cap, evict oldest-inserted.
  if (lastWarnAt.size >= WARN_MAP_MAX) {
    for (const [k, t] of lastWarnAt) {
      if (now - t >= windowSecs * 1000) lastWarnAt.delete(k);
    }
    while (lastWarnAt.size >= WARN_MAP_MAX) {
      const oldest = lastWarnAt.keys().next().value;
      if (oldest === undefined) break;
      lastWarnAt.delete(oldest);
    }
  }
  lastWarnAt.set(key, now);
  return true;
}

function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

/**
 * Rate-limiting middleware.
 *
 * Two layers:
 *
 *   1. Per-IP sliding window on the auth endpoints that TAKE a credential
 *      (20 req/min) — login, register, passkey, oauth, password/2FA. Session
 *      reads like `/api/auth/me` are deliberately NOT in it; see
 *      `isCredentialAttempt`.
 *
 *   2. (Phase 3c-2) Per-user sliding window on `/api/*`, fed by
 *      `quotaManager.getEffectiveQuota(userId).maxApiCallsPerMinute`.
 *      Octipus is always multi-user, so this fires for ANY request
 *      carrying an authenticated Principal — including the lone operator
 *      of a single-user install. Anonymous traffic and the legacy
 *      `system`/`local` sentinels fall through. The window is reused from
 *      `getRateLimiter()` so the storage backend (Redis or in-memory) is
 *      shared with layer 1. The default cap (`api.rateLimitMax`) is kept
 *      in line with the per-IP baseline so it doesn't throttle normal
 *      dashboard polling; tighten it per-user via /admin/quotas.
 *
 * The two layers are independent: a request could be IP-limited AND
 * user-limited; the first one to fire returns the 429.
 */
export const rateLimitMiddleware = new Elysia({ name: 'rate-limit' }).onBeforeHandle(
  { as: 'global' },
  // The Elysia derive() that produces `principal` runs before this
  // hook, but Elysia's typed context here is narrower than what we
  // actually receive at runtime. Cast to any for the principal lookup.
  async (ctx: any) => {
    const { request, set } = ctx;
    const url = new URL(request.url);

    // ── Layer 1: per-IP on CREDENTIAL endpoints ────────────────────
    if (isCredentialAttempt(url.pathname)) {
      const ip = clientIp(request);

      const rateLimiter = getRateLimiter();
      const result = await rateLimiter.check(`auth:ip:${ip}`, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_SECS);

      set.headers['X-RateLimit-Limit'] = String(AUTH_RATE_LIMIT);
      set.headers['X-RateLimit-Remaining'] = String(result.remaining);

      if (!result.allowed) {
        if (shouldWarn(`auth:ip:${ip}`, AUTH_RATE_WINDOW_SECS)) {
          apiLogger.warn({ ip, retryAfter: result.retryAfter }, 'Rate limit exceeded on auth endpoint');
        }
        set.status = 429;
        set.headers['Retry-After'] = String(result.retryAfter);
        return { error: 'Too many requests. Please try again later.', retryAfter: result.retryAfter };
      }
      return;
    }

    // Only /api/* below this point. Health probes are never limited so
    // liveness/readiness checks can't be starved by a noisy neighbour.
    if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/health') || url.pathname.startsWith('/api/metrics')) return;

    // ── Layer 1b: baseline per-IP cap on all /api/* (any mode) ──────
    if (BASELINE_IP_LIMIT > 0) {
      const ip = clientIp(request);
      const rateLimiter = getRateLimiter();
      const result = await rateLimiter.check(`api:ip:${ip}`, BASELINE_IP_LIMIT, BASELINE_IP_WINDOW_SECS);
      if (!result.allowed) {
        if (shouldWarn(`api:ip:${ip}`, BASELINE_IP_WINDOW_SECS)) {
          apiLogger.warn({ ip, path: url.pathname, retryAfter: result.retryAfter }, 'Baseline per-IP API rate limit exceeded');
        }
        set.status = 429;
        set.headers['Retry-After'] = String(result.retryAfter);
        return { error: 'Too many requests. Please try again later.', retryAfter: result.retryAfter };
      }
    }

    // ── Layer 2: per-user (Phase 3c-2) ─────────────────────────────
    const principal = (ctx as { principal?: Principal }).principal;
    if (!principal || !isAuthenticated(principal)) return;
    if (principal.userId === 'system' || principal.userId === 'local') return;

    try {
      const { getQuotaManager } = await import('@/security/quotas');
      const quota = await getQuotaManager().getEffectiveQuota(principal.userId);
      const max = quota.maxApiCallsPerMinute;
      if (!Number.isFinite(max) || max <= 0) return;

      const rateLimiter = getRateLimiter();
      const result = await rateLimiter.check(
        `user:rl:${principal.userId}`, max, USER_QUOTA_WINDOW_SECS,
      );

      set.headers['X-RateLimit-Limit'] = String(max);
      set.headers['X-RateLimit-Remaining'] = String(result.remaining);

      if (!result.allowed) {
        if (shouldWarn(`user:rl:${principal.userId}`, USER_QUOTA_WINDOW_SECS)) {
          apiLogger.warn(
            { userId: principal.userId, max, retryAfter: result.retryAfter },
            'Per-user API quota exceeded',
          );
        }
        set.status = 429;
        set.headers['Retry-After'] = String(result.retryAfter);
        return {
          error: 'API request quota exceeded. Try again shortly.',
          retryAfter: result.retryAfter,
          quota: { kind: 'apiCallsPerMinute', max },
        };
      }
    } catch (err) {
      // Quota lookup failure shouldn't break the request — the
      // application-layer scope is the primary protection.
      apiLogger.debug({ err }, 'Per-user rate-limit lookup failed; allowing request');
    }
  }
);
