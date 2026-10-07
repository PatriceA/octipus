import { Elysia } from '@/api/http';

const PUBLIC_PATH_PREFIXES = [
  '/api/auth/login',
  '/api/auth/login-mobile',
  '/api/auth/register',
  '/api/auth/passkey/',
  '/api/health/live',
  '/api/health/ready',
  // Setup status — read-only boolean. Lets the web /setup page decide
  // whether to redirect to /chat before the user is authenticated, and
  // lets the CLI wizard probe state without first logging in.
  '/api/settings/setup-status',
];

/** Exact health paths that stay public; the rest of `/api/health` does not. */
const PUBLIC_HEALTH_PATHS: ReadonlySet<string> = new Set([
  '/api/health',
  '/api/health/',
  '/api/health/database',
  '/api/health/storage',
]);

/**
 * Public routes matched by method AND exact shape — unlike the path-prefix
 * list above, which ignores the method. `GET /api/invites/<token>` previews an
 * invite before sign-in; `POST /api/invites/<token>/accept` is NOT public.
 */
const PUBLIC_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/api\/invites\/[^/]+$/ },
  // The registration mode (`security.registration`): the sign-in page reads it before anyone signs in.
  { method: 'GET', pattern: /^\/api\/auth\/registration$/ },
];

export function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.some((route) => route.method === method && route.pattern.test(path));
}

export function isPublicPath(path: string): boolean {
  // OAuth callbacks are public (state-based auth, bound to the starting
  // browser's cookie): the provider's redirect is a cross-site navigation,
  // which the SameSite=Strict session cookie does not survive.
  if (path.match(/^\/api\/auth\/oauth\/\w+\/callback/)) return true;
  if (/^\/api\/connectors\/[a-z0-9-]+\/callback$/.test(path)) return true;
  // The probes monitoring, load balancers and k8s use are public (`/live` and
  // `/ready` are in the prefix list below). The rest of /api/health is install
  // state and needs a sign-in (routes/health.ts gates it further).
  if (PUBLIC_HEALTH_PATHS.has(path)) return true;
  // Webhook endpoints use HMAC signature verification instead of bearer auth
  if (path.startsWith('/api/webhooks/')) return true;
  // Incoming webhooks use per-hook webhookSecret for authentication
  if (path.startsWith('/api/hooks/incoming/')) return true;
  // Voice telephony webhooks use provider-specific signature verification (Twilio HMAC, Telnyx Ed25519, Plivo HMAC)
  if (path.startsWith('/api/voice/webhook/')) return true;
  // WhatsApp webhook — Meta calls directly with signature verification
  if (path.startsWith('/api/channels/whatsapp/webhook')) return true;
  // Mobile device pairing — code-based auth
  if (path === '/api/devices/pair/redeem') return true;
  // SCIM 2.0 — per-org Bearer token, validated inside the route
  if (path.startsWith('/api/scim/')) return true;
  // SAML SP routes — IdP-initiated, signature-validated inside the route
  if (path.startsWith('/api/saml/')) return true;
  // Prometheus scrape — a scraper cannot do the login flow. The route itself
  // is 404 unless METRICS_TOKEN is set and 401 without it, so "public" here
  // means "authenticated by its own token", not "open".
  // Exact route (plus any sub-path), never a bare prefix: `startsWith` would
  // also make a future `/api/metrics-admin` public, and unlike this route those
  // would have no second gate of their own.
  if (path === '/api/metrics' || path.startsWith('/api/metrics/')) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Auth guard middleware — rejects unauthenticated requests to protected routes.
 * Must be registered after .derive() (which populates `user`).
 */
export const authGuard = new Elysia({ name: 'auth-guard' })
  .onBeforeHandle({ as: 'global' }, (ctx) => {
    const url = new URL(ctx.request.url);

    // Guarded surfaces: the `/api/` group and the OpenAI-compatible `/v1/`
    // group. Everything else (static assets, the WS upgrade, etc.) is handled
    // elsewhere. `/v1` is NOT public — it carries the same auth as `/api`.
    const isGuarded = url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/');

    // Skip guard for CORS preflight, non-guarded routes, and public paths.
    if (
      ctx.request.method === 'OPTIONS' ||
      !isGuarded ||
      isPublicPath(url.pathname) ||
      isPublicRoute(ctx.request.method, url.pathname)
    ) {
      return;
    }

    if (!(ctx as any).user) {
      ctx.set.status = 401;
      return { error: 'Authentication required' };
    }
  });
