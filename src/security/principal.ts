/**
 * Principal — the canonical identity attached to every request,
 * WebSocket frame, channel message, and agent execution.
 *
 * Phase 0 introduces the type and the helpers that build it; the rest of
 * the codebase still passes raw `userId` strings around. Phase 1 refactors
 * repositories and the root agent to take a `Principal` instead.
 *
 * The `kind` discriminator lets the auth layer represent:
 *   - `user`         — a human authenticated via session cookie / bearer
 *   - `service`      — an API token bound to a service account
 *   - `system`       — background jobs (cron, compaction, reapers)
 *   - `anonymous`    — no credentials present; only public routes accept it
 */

import { scopesSatisfy } from './scopes';

export type PrincipalKind = 'user' | 'service' | 'system' | 'anonymous';

export interface Principal {
  readonly kind: PrincipalKind;
  /** UUID for `user`/`service`, sentinel string for `system`/`anonymous`. */
  readonly userId: string;
  readonly username: string;
  readonly isAdmin: boolean;
  /** Auth-session id (Redis) when applicable; null for stateless auth. */
  readonly sessionToken?: string | null;
  /** Future: roles array for RBAC. Phase 0 derives from `isAdmin` only. */
  readonly roles?: readonly string[];
  /**
   * Phase 3d — admin impersonation. When non-null, the request is
   * being acted on behalf of `userId` BY the admin whose UUID is
   * recorded here. Audit code tags both sides; the rest of the
   * application sees the principal as the target user. NULL during
   * normal auth (the principal is acting as themselves).
   */
  readonly actorUserId?: string | null;
  /** Display name of the impersonating admin. Convenience for
   *  audit + the web banner. */
  readonly actorUsername?: string | null;
  /**
   * Phase 4 — optional workspace scope. When set, scopedRepos
   * narrow reads/writes to rows whose `workspace_id` matches AND
   * stamp newly-created rows with this id. NULL/undefined means
   * "user-level": rows are visible across every workspace owned
   * by the user.
   *
   * Resolved by the auth-derive middleware from the
   * `X-Octipus-Workspace` request header (slug or uuid). Cross-
   * tenant headers are silently ignored — alice handing bob's
   * workspace UUID gets her own default workspace, not bob's row.
   *
   * Populated for any real user (`user` / `service`)
   * — the resolver lazily creates a default workspace if needed.
   * Anonymous / system principals leave it undefined. The
   * `multiuser.orgWorkspaces` flag only gates header-driven
   * switching between multiple workspaces, not workspace existence.
   */
  readonly workspaceId?: string | null;
  /**
   * WS6 — API-token scopes. Present (and non-empty) ONLY when the request was
   * authenticated by a scoped personal access token. Undefined for browser
   * sessions and unscoped tokens, both of which are full-access. Enforced via
   * `requireScope` / `scopesSatisfy` at guarded surfaces.
   */
  readonly scopes?: readonly string[];
}

/** Sentinel principal for anonymous/unauthenticated callers. */
export const ANONYMOUS_PRINCIPAL: Principal = Object.freeze({
  kind: 'anonymous',
  userId: 'anonymous',
  username: 'anonymous',
  isAdmin: false,
  sessionToken: null,
  roles: Object.freeze([] as string[]),
});

/** Sentinel principal for in-process system jobs (cron, reapers). */
export const SYSTEM_PRINCIPAL: Principal = Object.freeze({
  kind: 'system',
  userId: 'system',
  username: 'system',
  isAdmin: true,
  sessionToken: null,
  roles: Object.freeze(['system_admin'] as string[]),
});

export interface UserLike {
  id: string;
  username: string;
  isAdmin: boolean;
}

/** Build a principal from an authenticated user record + auth session token. */
export function principalFromUser(
  user: UserLike,
  sessionToken: string | null = null,
): Principal {
  return {
    kind: 'user',
    userId: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    sessionToken,
    roles: user.isAdmin ? ['system_admin', 'user'] : ['user'],
  };
}

/** True for any principal the rest of the system should consider authenticated. */
export function isAuthenticated(p: Principal | null | undefined): p is Principal {
  return !!p && p.kind !== 'anonymous';
}

/** True for principals with administrative privileges. */
export function isAdmin(p: Principal | null | undefined): boolean {
  return !!p && p.isAdmin;
}

/**
 * Whether `actor` is permitted to act on data owned by `targetUserId`.
 * Phase 0 keeps the rule simple: same user, or admin. Phase 1 layers
 * org-membership and explicit shares on top.
 */
export function canActOnUser(actor: Principal, targetUserId: string): boolean {
  if (!isAuthenticated(actor)) return false;
  if (actor.userId === targetUserId) return true;
  return isAdmin(actor);
}

/**
 * WS6 — whether `principal` carries the given API scope. Delegates to
 * `scopesSatisfy`, so unscoped principals (browser sessions, unscoped tokens)
 * pass everything and only explicitly-scoped tokens are restricted.
 */
export function requireScope(principal: Principal | null | undefined, scope: string): boolean {
  if (!isAuthenticated(principal)) return false;
  return scopesSatisfy(principal.scopes, scope);
}
