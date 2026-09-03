/**
 * API token scopes (WS6, item 1 — scope enforcement).
 *
 * Personal access tokens (`octi_…`) carry an optional list of scopes. Until now
 * the column was stored but never *enforced* — a token minted with
 * `scopes: ['api:read']` could still drive the full chat surface. This module
 * defines the vocabulary and the single decision function used at every guarded
 * surface.
 *
 * Backwards-compat rule (load-bearing): an **empty** scope set means
 * "unscoped" = full access. Every token issued before enforcement — and every
 * token minted through the web UI, which doesn't expose a scope picker — has an
 * empty set, so enforcement is a no-op for them. Only a token that *explicitly*
 * requests scopes is restricted to them. Browser-session principals have no
 * scopes concept and are always full-access.
 */

export const API_SCOPES = {
  /** Drive the chat/root agent surface (`POST /api/chat`, `/v1/chat/completions`). */
  CHAT: 'api:chat',
  /** Read-only data access (list sessions, read notes, etc.). */
  READ: 'api:read',
  /** Mutating data access (create/update/delete resources). */
  WRITE: 'api:write',
  /** Full access — implies every other scope. */
  ADMIN: 'api:admin',
} as const;

export type ApiScope = (typeof API_SCOPES)[keyof typeof API_SCOPES];

/** Every scope string the server recognizes. */
export const KNOWN_API_SCOPES: readonly string[] = Object.values(API_SCOPES);

/** True when `scope` is a scope the server knows how to enforce. */
export function isKnownScope(scope: string): boolean {
  return KNOWN_API_SCOPES.includes(scope);
}

/**
 * Decide whether a granted scope set satisfies a required scope.
 *
 *   - empty / null / undefined granted set ⇒ unscoped ⇒ **allowed** (compat)
 *   - `api:admin` present ⇒ allowed for anything
 *   - otherwise the required scope must be explicitly present
 */
export function scopesSatisfy(
  granted: readonly string[] | null | undefined,
  required: string,
): boolean {
  if (!granted || granted.length === 0) return true;
  if (granted.includes(API_SCOPES.ADMIN)) return true;
  return granted.includes(required);
}

/**
 * Validate a requested scope list at issuance time. Returns the deduped list on
 * success, or an `{ error }` describing the first unknown scope. Rejecting typos
 * at issuance prevents a token from silently locking itself out (a token asking
 * for `api:cht` would satisfy nothing).
 */
export function validateRequestedScopes(
  scopes: readonly string[] | undefined,
): { ok: true; scopes: string[] } | { ok: false; error: string } {
  if (!scopes || scopes.length === 0) return { ok: true, scopes: [] };
  const seen = new Set<string>();
  for (const s of scopes) {
    if (!isKnownScope(s)) {
      return { ok: false, error: `Unknown scope "${s}". Known scopes: ${KNOWN_API_SCOPES.join(', ')}` };
    }
    seen.add(s);
  }
  return { ok: true, scopes: [...seen] };
}
