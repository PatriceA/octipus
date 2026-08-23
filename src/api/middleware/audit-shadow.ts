/**
 * Audit middleware (shadow mode) — Phase 0 multi-user foundation.
 *
 * For every state-changing API request we write one `audit_log` row with
 * action='api_request'. The middleware NEVER blocks a request: any error
 * inside it is swallowed and logged, because audit must not become a new
 * source of 5xx. It is gated on `config.multiuser.auditShadow` so an
 * operator can disable it cleanly.
 *
 * Scope (kept narrow on purpose):
 *   - Methods: POST, PUT, PATCH, DELETE (reads aren't logged in shadow mode)
 *   - Paths:   anything starting with /api/, except OPTIONS preflight,
 *              health endpoints, and webhook receivers (already attested
 *              by HMAC).
 *
 * Phase 1 layers per-resource enrichment (resource_type / resource_id from
 * the path) and writes a row for reads as well.
 */
import { Elysia } from '@/api/http';
import { getConfig } from '@/config';
import { auditRepository } from '@/db/repositories/audit-repository';
import type { Principal } from '@/security/principal';
import { apiLogger } from '@/utils/logger';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Paths skipped even for state-changing methods. Webhooks authenticate via
 * HMAC (handled by the route itself); health endpoints are noisy and
 * uninteresting; auth endpoints already produce dedicated audit rows
 * (login / logout / login_failed) so logging them generically would
 * double-count.
 */
const SKIP_PREFIXES = [
  '/api/health',
  '/api/webhooks/',
  '/api/hooks/incoming/',
  '/api/voice/webhook/',
  '/api/channels/whatsapp/webhook',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/register',
];

function shouldAudit(method: string, pathname: string): boolean {
  if (!STATE_CHANGING_METHODS.has(method)) return false;
  if (!pathname.startsWith('/api/')) return false;
  if (SKIP_PREFIXES.some((p) => pathname.startsWith(p))) return false;
  return true;
}

/** Map an HTTP path to a coarse resource_type for filtering. */
export function resourceTypeFromPath(pathname: string): string | undefined {
  // /api/<resource>/... → <resource>
  const m = pathname.match(/^\/api\/([^/?]+)/);
  return m?.[1];
}

/**
 * Extract the principal from the Elysia context. We can't import the
 * server's exact derive() return type without creating a cycle, so we
 * accept `unknown` and narrow.
 */
function getPrincipal(ctx: unknown): Principal | null {
  const p = (ctx as { principal?: Principal }).principal;
  return p ?? null;
}

function getClientIp(headers: Headers): string | undefined {
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim();
  return headers.get('x-real-ip') ?? undefined;
}

/**
 * Insert an audit row. Public for testing; the middleware below calls it
 * after the response is decided.
 */
export async function writeApiAudit(args: {
  principal: Principal | null;
  method: string;
  pathname: string;
  status: number;
  durationMs: number;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  const { principal, method, pathname, status, durationMs, ipAddress, userAgent } = args;

  // Anonymous requests get null userId — the field is `text` so it
  // accepts both UUIDs and 'system' / null.
  const userId = principal && principal.kind !== 'anonymous' ? principal.userId : null;

  // Phase 3d — when an admin is impersonating, record the entry under
  // BOTH the actor (admin) and the target (the user being acted as)
  // so an investigator searching by either user id finds the action.
  // The shared `details.impersonate` block carries the other party's
  // identity so the entries are joinable.
  const impersonating = !!principal?.actorUserId;
  const baseDetails: Record<string, unknown> = {
    method,
    path: pathname,
    status,
    duration: durationMs,
    principalKind: principal?.kind ?? 'anonymous',
  };
  if (impersonating) {
    baseDetails.impersonate = {
      actorUserId: principal!.actorUserId,
      actorUsername: principal!.actorUsername,
      targetUserId: principal!.userId,
      targetUsername: principal!.username,
    };
  }

  await auditRepository.log({
    userId,
    action: 'api_request',
    resourceType: resourceTypeFromPath(pathname),
    ipAddress,
    userAgent,
    details: baseDetails,
  });

  // Mirror the entry under the actor when impersonating — the
  // primary entry is filed under the target (so target-side audit
  // searches find it); the mirror lets actor-side searches find it.
  if (impersonating && principal?.actorUserId && principal.actorUserId !== userId) {
    await auditRepository.log({
      userId: principal.actorUserId,
      action: 'api_request',
      resourceType: resourceTypeFromPath(pathname),
      ipAddress,
      userAgent,
      details: { ...baseDetails, mirroredFromTarget: true },
    });
  }
}

export const auditShadowMiddleware = new Elysia({ name: 'audit-shadow' })
  .onRequest(({ request }) => {
    // Tag the request with a start timestamp; onAfterHandle reads it.
    (request as unknown as { _auditStart?: number })._auditStart = Date.now();
  })
  .onAfterHandle({ as: 'global' }, async (ctx) => {
    try {
      if (!getConfig().multiuser?.auditShadow) return;

      const url = new URL(ctx.request.url);
      if (!shouldAudit(ctx.request.method, url.pathname)) return;

      const start = (ctx.request as unknown as { _auditStart?: number })._auditStart;
      const durationMs = start ? Date.now() - start : 0;
      const status = (ctx.set?.status as number | undefined) ?? 200;

      await writeApiAudit({
        principal: getPrincipal(ctx),
        method: ctx.request.method,
        pathname: url.pathname,
        status,
        durationMs,
        ipAddress: getClientIp(ctx.request.headers),
        userAgent: ctx.request.headers.get('user-agent') ?? undefined,
      });
    } catch (err) {
      // Audit must never break a request — log and continue.
      apiLogger.warn({ err }, 'audit-shadow: failed to record api_request');
    }
  });
