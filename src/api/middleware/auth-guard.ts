import { Elysia } from 'elysia';

const PUBLIC_PATH_PREFIXES = [
  '/api/auth/login',
  '/api/auth/login-mobile',
  '/api/auth/register',
  '/api/auth/passkey/',
  '/api/health/live',
  '/api/health/ready',
];

function isPublicPath(path: string): boolean {
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
  return PUBLIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Auth guard middleware — rejects unauthenticated requests to protected routes.
 * Must be registered after .derive() (which populates `user`).
 */
export const authGuard = new Elysia({ name: 'auth-guard' })
  .onBeforeHandle({ as: 'global' }, (ctx) => {
    const url = new URL(ctx.request.url);

    // Skip guard for CORS preflight, non-API routes, and public paths
    if (ctx.request.method === 'OPTIONS' || !url.pathname.startsWith('/api/') || isPublicPath(url.pathname)) {
      return;
    }

    if (!(ctx as any).user) {
      ctx.set.status = 401;
      return { error: 'Authentication required' };
    }
  });
