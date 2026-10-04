/**
 * Account deactivation (docs/plans/coworking-spec.md §4.1, L7/L8).
 *
 * `setUserActive` is the only writer of `users.is_active`. It records who
 * switched an account off in `users.deactivated_by` ('admin' or
 * 'scim:<orgId>'), so an identity provider's `active: true` never undoes an
 * admin's decision, and it applies the consequences at once rather than at the
 * next login: sessions revoked, every socket closed, agents stopped, pending
 * permission and approval prompts expired, impersonations of the account
 * ended, and an audit row written.
 *
 * Fire-time checks (hooks, heartbeats, monitors) and the per-request checks in
 * `SessionManager.validate` and `ApiTokenManager.validate` read the column
 * itself, so a process that missed this call still refuses the account.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { userRepository } from '@/db/repositories/user-repository';
import { type User, users } from '@/db/schema/users';
import { securityLogger } from '@/utils/logger';

/** Who changed an account's active flag: an admin, or one org's SCIM token. */
export type ActiveSource = 'admin' | `scim:${string}`;

export type SetUserActiveOutcome =
  | { status: 'changed'; user: User }
  | { status: 'unchanged'; user: User }
  /** A SCIM re-activation of an account an admin (or another org) switched off. */
  | { status: 'refused'; user: User }
  | { status: 'not_found' };

/** Close code for sockets of a deactivated account (the client's re-auth then fails). */
export const DEACTIVATED_CLOSE_CODE = 4001;
/** Close code for gateway connections whose user changed: reconnect to pick up the new rights. */
export const USER_CHANGED_CLOSE_CODE = 4004;

const DEACTIVATED_MESSAGE = 'The account was deactivated.';

/**
 * Switch `userId` on or off. `actor` is the admin's user id, or null for a
 * SCIM token (its org is in `source`).
 *
 * Re-activation by SCIM succeeds only for an account that the same org's SCIM
 * token switched off: never an admin's deactivation, and never another org's.
 */
export async function setUserActive(
  userId: string,
  active: boolean,
  actor: string | null,
  source: ActiveSource,
): Promise<SetUserActiveOutcome> {
  const user = await userRepository.findById(userId);
  if (!user) return { status: 'not_found' };
  if (user.isActive === active) return { status: 'unchanged', user };
  if (active && source !== 'admin' && user.deactivatedBy !== source) {
    securityLogger.warn({ userId, source, deactivatedBy: user.deactivatedBy }, 'Re-activation refused: deactivated by someone else');
    return { status: 'refused', user };
  }

  // Conditional on the flag still being what was read, so two writers racing
  // cannot both run the consequences.
  const [updated] = await getDb()
    .update(users)
    .set({ isActive: active, deactivatedBy: active ? null : source, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.isActive, !active)))
    .returning();
  if (!updated) {
    const current = await userRepository.findById(userId);
    return current ? { status: 'unchanged', user: current } : { status: 'not_found' };
  }

  await auditRepository.log({
    userId: actor ?? userId,
    action: 'user_updated',
    resourceType: 'user',
    resourceId: userId,
    details: { isActive: active, source, ...(actor ? { byAdmin: actor } : {}), targetUser: updated.username },
  });
  securityLogger.warn({ userId, active, source, actor }, active ? 'User re-activated' : 'User deactivated');

  await onUserChanged(userId);
  if (!active) await applyDeactivation(userId);
  return { status: 'changed', user: updated };
}

/**
 * Everything a deactivation ends. Each step runs even when another fails; any
 * failure is logged and rethrown once all have run (the flag itself is already
 * off, and every request re-reads it).
 */
async function applyDeactivation(userId: string): Promise<void> {
  const { getSessionManager } = await import('@/security/auth/session');
  const { closeUserSockets } = await import('@/api/user-sockets');
  const { getAgentManager } = await import('@/core/agent-manager');
  const { getPermissionManager } = await import('@/security/permissions');
  const { getAgentService } = await import('@/core/agent');
  const { getImpersonationManager } = await import('@/security/impersonation');

  const steps: Array<[string, () => Promise<unknown> | unknown]> = [
    ['revoke sessions', () => getSessionManager().revokeAllForUser(userId)],
    ['close sockets', () => closeUserSockets(userId, DEACTIVATED_CLOSE_CODE, 'Account deactivated')],
    ['stop agents', () => getAgentManager().stopUser(userId)],
    ['expire permission requests', () => getPermissionManager().expireForUser(userId)],
    ['expire approvals', () => getAgentService().expireApprovalsForUser(userId, DEACTIVATED_MESSAGE)],
    ['end impersonations', () => getImpersonationManager().endForTarget(userId)],
  ];
  const failures: unknown[] = [];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      securityLogger.error({ err, userId, step: name }, 'Deactivation step failed');
      failures.push(err);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `Deactivation of ${userId} left ${failures.length} step(s) undone`);
}

/**
 * The user's active flag or admin flag changed. A gateway connection fixes its
 * identity, trust and admin rights at auth, so all of the user's connections
 * are closed: the client reconnects and is re-authenticated with the current
 * row (or refused).
 */
export async function onUserChanged(userId: string): Promise<void> {
  // Lazy: the hub module pulls the gateway in, which this module's callers
  // (routes) must not have to load at import time.
  const { getGatewayHub } = await import('@/core/gateway/hub');
  getGatewayHub().connectionManager.closeUserConnections(userId, USER_CHANGED_CLOSE_CODE, 'Account changed');
}
