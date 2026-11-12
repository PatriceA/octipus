/**
 * The gate of the plugin package admin routes (src/api/routes/plugin-packages.ts):
 * an admin, with an API token's scope that covers the request, and, for a
 * change signed by the session cookie, a request from this site.
 *
 * - **Scopes** (src/security/scopes.ts): every change needs `api:admin`
 *   (installing, consenting, enabling, approving, secrets, settings,
 *   uninstalling, clearing a revocation, resetting a pin, an admin's cancel
 *   of another user's run); every read needs at least `api:read`. An
 *   unscoped token and a browser session have every scope, as elsewhere.
 * - **Cross-site** (CSRF): the session cookie is `SameSite=Strict`, so a
 *   cross-site form or fetch carries none. A sibling site (another
 *   subdomain of the same registrable domain) is "same-site" and would carry
 *   it, so a cookie-signed change must also come from this origin: its
 *   `Origin` is this host or a configured CORS origin (the desktop app's
 *   included), and its `Sec-Fetch-Site` is `same-origin` or `none`. A request
 *   signed with a bearer token carries no ambient credential and is not checked.
 */
import { DESKTOP_ORIGINS } from '@/api/desktop-origins';
import { adminDenied } from '@/api/admin-guard';
import { getConfig } from '@/config';
import { isAuthenticated, type Principal, requireScope } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';

type Ctx = { set: { status?: number | string }; user: { isAdmin?: boolean } | null; principal: Principal; request: Request };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Origins configured for CORS (never `*`), and the desktop app's. */
function allowedOrigins(): string[] {
  let configured: string[] = [];
  try {
    configured = getConfig().api.corsOrigins.filter((o) => o !== '*');
  } catch {
    configured = [];
  }
  return [...configured, ...DESKTOP_ORIGINS];
}

/** Whether `origin` names the host the request was sent to (scheme aside: a TLS-terminating proxy speaks http behind it). */
function sameHost(origin: string, request: Request): boolean {
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const own = [request.headers.get('host'), forwarded, (() => { try { return new URL(request.url).host; } catch { return null; } })()];
  return own.some((h) => !!h && h.toLowerCase() === host.toLowerCase());
}

/** A change signed by the session cookie from another site: the refusal, or null. */
export function crossSiteDenied(ctx: Pick<Ctx, 'set' | 'request'>): { error: string } | null {
  const { request } = ctx;
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  if ((request.headers.get('authorization') ?? '').startsWith('Bearer ')) return null;
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  const refuse = () => {
    ctx.set.status = 403;
    return { error: 'Cross-site request refused: a change signed by the session cookie must come from this site' };
  };
  if (origin !== null) {
    if (origin === 'null') return refuse();
    if (sameHost(origin, request) || allowedOrigins().includes(origin)) return null;
    return refuse();
  }
  if (site !== null && site !== 'same-origin' && site !== 'none') return refuse();
  return null;
}

/** An admin request: signed in as an admin, the token's scope (`read` or `admin`), and from this site when it changes something. */
export function pluginAdminDenied(ctx: Ctx, scope: 'read' | 'admin'): { error: string } | null {
  const denied = adminDenied(ctx);
  if (denied) return denied;
  const needed = scope === 'admin' ? API_SCOPES.ADMIN : API_SCOPES.READ;
  if (!requireScope(ctx.principal, needed)) {
    ctx.set.status = 403;
    return { error: `This API token lacks the ${needed} scope` };
  }
  return crossSiteDenied(ctx);
}

/** A signed-in user's own request: the token's scope (`read` or `write`), and from this site when it changes something. */
export function pluginUserDenied(ctx: Omit<Ctx, 'user'>, scope: 'read' | 'write'): { error: string } | null {
  if (!isAuthenticated(ctx.principal)) {
    ctx.set.status = 401;
    return { error: 'Authentication required' };
  }
  const needed = scope === 'write' ? API_SCOPES.WRITE : API_SCOPES.READ;
  if (!requireScope(ctx.principal, needed)) {
    ctx.set.status = 403;
    return { error: `This API token lacks the ${needed} scope` };
  }
  return crossSiteDenied(ctx);
}
