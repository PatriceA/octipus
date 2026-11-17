/**
 * A plugin may read only exact connection/path pairs set by its admin, using
 * the caller's existing vault grant. Never accepts URLs, headers or bodies.
 */
import { authenticatedFetch, connectionFor, readBoundedResponse, type ConnectionPrincipal } from '@/security/credential-connections';
import { userHeldScopes } from './host-api';

export function connectionGetAllowed(settings: Record<string, unknown>, connection: string, path: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(connection) || !path.startsWith('/') || path.startsWith('//') || /[\\\r\n\0#]/.test(path)) return false;
  if (typeof settings.connection_grants !== 'string' || settings.connection_grants.length > 20_000) return false;
  try {
    const grants: unknown = JSON.parse(settings.connection_grants);
    if (!grants || typeof grants !== 'object' || Array.isArray(grants) || !Object.hasOwn(grants, connection)) return false;
    const paths = (grants as Record<string, unknown>)[connection];
    return Array.isArray(paths) && paths.length <= 100 && paths.some(p => typeof p === 'string' && p === path);
  } catch { return false; }
}

export async function pluginConnectionGet(caller: ConnectionPrincipal, settings: Record<string, unknown>, input: { connection: string; path: string; expectedOrigin?: string }) {
  if (!connectionGetAllowed(settings, input.connection, input.path)) {
    return { error: 'Connection/path is not approved in this plugin’s connection_grants setting', code: 'connection_not_approved', status: 403 } as const;
  }
  const held = await userHeldScopes(caller.userId, ['connections:read'], { sessionId: '', workspaceId: caller.workspaceId ?? null });
  if (!held.includes('connections:read')) return { error: 'Connection reads denied by user policy', code: 'connection_denied', status: 403 } as const;
  try {
    const connection = await connectionFor(input.connection, caller);
    if (input.expectedOrigin !== undefined && input.expectedOrigin !== connection.http?.origin) {
      return { error: 'Saved engine URL does not match the approved connection origin', code: 'connection_origin_mismatch', status: 403 } as const;
    }
    const { response, mask } = await authenticatedFetch(connection, caller, input.path, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    const text = await readBoundedResponse(response, 1024 * 1024);
    let body: unknown = text;
    if (response.headers.get('content-type')?.includes('application/json')) {
      try { body = JSON.parse(text); } catch { /* retain masked text */ }
    }
    // Strip all headers, especially cookies and authentication metadata.
    return mask({ status: response.status, ok: response.ok, body }) as { status: number; ok: boolean; body: unknown };
  } catch {
    // Do not reflect credential/configuration/provider error values to package code.
    return { error: 'Approved connection request failed; check connection access, TLS and service availability', code: 'connection_failed', status: 502 } as const;
  }
}
