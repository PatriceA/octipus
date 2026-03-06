import { Elysia } from 'elysia';

const PUBLIC_PATH_PREFIXES = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/passkey/',
  '/api/health/live',
  '/api/health/ready',
];

function isPublicPath(path: string): boolean {
  // OAuth callbacks are public (state-based auth)
  if (path.match(/^\/api\/auth\/oauth\/\w+\/callback/)) return true;
  // Exact match for basic health endpoint (blocks /api/health/detailed, /api/health/database, etc.)
  if (path === '/api/health') return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Auth guard middleware — rejects unauthenticated requests to protected routes.
 * Must be registered after .derive() (which populates `user`).
 */
export const authGuard = new Elysia({ name: 'auth-guard' })
  .onBeforeHandle({ as: 'global' }, (ctx) => {
    const url = new URL(ctx.request.url);

    // Skip guard for non-API routes and public paths
    if (!url.pathname.startsWith('/api/') || isPublicPath(url.pathname)) {
      return;
    }

    if (!(ctx as any).user) {
      ctx.set.status = 401;
      return { error: 'Authentication required' };
    }
  });
