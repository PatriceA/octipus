import { Elysia } from 'elysia';
import { getRateLimiter } from '@/security/rate-limiter';
import { apiLogger } from '@/utils/logger';

const AUTH_RATE_LIMIT = 20; // requests per window
const AUTH_RATE_WINDOW_SECS = 60; // 1 minute

/**
 * Rate-limiting middleware for auth endpoints.
 * Applies a per-IP sliding window (20 req/min) to /api/auth/ routes.
 */
export const rateLimitMiddleware = new Elysia({ name: 'rate-limit' }).onBeforeHandle(
  { as: 'global' },
  async ({ request, set }) => {
    const url = new URL(request.url);

    // Only rate-limit auth endpoints
    if (!url.pathname.startsWith('/api/auth')) {
      return;
    }

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown';

    const rateLimiter = getRateLimiter();
    const result = await rateLimiter.check(`auth:ip:${ip}`, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_SECS);

    // Always set rate-limit headers
    set.headers['X-RateLimit-Limit'] = String(AUTH_RATE_LIMIT);
    set.headers['X-RateLimit-Remaining'] = String(result.remaining);

    if (!result.allowed) {
      apiLogger.warn({ ip, retryAfter: result.retryAfter }, 'Rate limit exceeded on auth endpoint');
      set.status = 429;
      set.headers['Retry-After'] = String(result.retryAfter);
      return { error: 'Too many requests. Please try again later.', retryAfter: result.retryAfter };
    }
  }
);
