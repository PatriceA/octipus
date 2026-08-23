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

export function isPublicPath(path: string): boolean {
  // OAuth callbacks are public (state-based auth)
  if (path.match(/^\/api\/auth\/oauth\/\w+\/callback/)) return true;
  // All health endpoints are public (used by monitoring, load balancers, k8s probes)
  if (path.startsWith('/api/health')) return true;
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
    if (ctx.request.method === 'OPTIONS' || !isGuarded || isPublicPath(url.pathname)) {
      return;
    }

    if (!(ctx as any).user) {
      ctx.set.status = 401;
      return { error: 'Authentication required' };
    }
  });
