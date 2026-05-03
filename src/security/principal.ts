/**
 * Principal — the canonical identity attached to every request,
 * WebSocket frame, channel message, and agent execution.
 *
 * Phase 0 introduces the type and the helpers that build it; the rest of
 * the codebase still passes raw `userId` strings around. Phase 1 refactors
 * repositories and the orchestrator to take a `Principal` instead.
 *
 * The `kind` discriminator lets the auth layer represent:
 *   - `user`         — a human authenticated via session cookie / bearer
 *   - `service`      — an API token bound to a service account (Phase 1+)
 *   - `system`       — background jobs (cron, compaction, reapers)
 *   - `master_key`   — legacy MASTER_KEY Bearer fallback, resolved to the
 *                      first admin user. Only valid when
 *                      `config.multiuser.enabled === false`. Phase 1
 *                      removes this variant entirely.
 *   - `anonymous`    — no credentials present; only public routes accept it
 */

export type PrincipalKind = 'user' | 'service' | 'system' | 'master_key' | 'anonymous';

export interface Principal {
  readonly kind: PrincipalKind;
  /** UUID for `user`/`service`/`master_key`, sentinel string for `system`/`anonymous`. */
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

/**
 * Build a principal for the legacy MASTER_KEY Bearer fallback.
 *
 * Phase 0: emitted only when `multiuser.enabled === false` and the request
 * presented the master key. Carries `kind: 'master_key'` so audit and
 * downstream code can distinguish it from a real session login.
 *
 * Phase 1: this constructor is removed and the fallback is replaced with
 * a printed bootstrap-admin token on first run.
 */
export function principalFromMasterKey(adminUser: UserLike): Principal {
  return {
    kind: 'master_key',
    userId: adminUser.id,
    username: adminUser.username,
    isAdmin: true,
    sessionToken: null,
    roles: ['system_admin', 'user'],
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
