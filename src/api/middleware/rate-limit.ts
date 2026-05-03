import { Elysia } from 'elysia';
import { getConfig } from '@/config';
import type { Principal } from '@/security/principal';
import { isAuthenticated } from '@/security/principal';
import { getRateLimiter } from '@/security/rate-limiter';
import { apiLogger } from '@/utils/logger';

const AUTH_RATE_LIMIT = 20; // requests per window
const AUTH_RATE_WINDOW_SECS = 60; // 1 minute
const USER_QUOTA_WINDOW_SECS = 60;

/**
 * Rate-limiting middleware.
 *
 * Two layers:
 *
 *   1. Per-IP sliding window on `/api/auth/*` (20 req/min). Pre-existing
 *      protection against credential-stuffing — kept exactly as before.
 *
 *   2. (Phase 3c-2) Per-user sliding window on `/api/*`, fed by
 *      `quotaManager.getEffectiveQuota(userId).maxApiCallsPerMinute`.
 *      Only fires when `multiuser.enabled` is true and the request
 *      carries an authenticated Principal. Anonymous traffic and the
 *      legacy `system`/`local` sentinels fall through. The window is
 *      reused from `getRateLimiter()` so the storage backend (Redis
 *      or in-memory) is shared with layer 1.
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

    // ── Layer 1: per-IP on auth endpoints ──────────────────────────
    if (url.pathname.startsWith('/api/auth')) {
      const ip =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        'unknown';

      const rateLimiter = getRateLimiter();
      const result = await rateLimiter.check(`auth:ip:${ip}`, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_SECS);

      set.headers['X-RateLimit-Limit'] = String(AUTH_RATE_LIMIT);
      set.headers['X-RateLimit-Remaining'] = String(result.remaining);

      if (!result.allowed) {
        apiLogger.warn({ ip, retryAfter: result.retryAfter }, 'Rate limit exceeded on auth endpoint');
        set.status = 429;
        set.headers['Retry-After'] = String(result.retryAfter);
        return { error: 'Too many requests. Please try again later.', retryAfter: result.retryAfter };
      }
      return;
    }

    // ── Layer 2: per-user (Phase 3c-2) ─────────────────────────────
    if (!url.pathname.startsWith('/api/')) return;
    let multiuser = false;
    try { multiuser = !!getConfig().multiuser?.enabled; } catch { /* config not loaded */ }
    if (!multiuser) return;

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
        apiLogger.warn(
          { userId: principal.userId, max, retryAfter: result.retryAfter },
          'Per-user API quota exceeded',
        );
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
