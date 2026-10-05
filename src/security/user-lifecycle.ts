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
import { markUserChanged } from '@/security/user-change-marks';
import { securityLogger } from '@/utils/logger';

/** Who changed an account's active flag: an admin, or one org's SCIM token. */
export type ActiveSource = 'admin' | `scim:${string}`;

export type SetUserActiveOutcome =
  /**
   * `failedSteps` names the consequences of a deactivation that threw (each is
   * logged). The flag itself is off and every request re-reads it, so the
   * caller reports them rather than failing the whole change.
   */
  | { status: 'changed'; user: User; failedSteps: string[] }
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
  if (user.isActive === active) {
    // An admin's deactivation of an account SCIM already switched off is
    // recorded all the same, so that org's later `active: true` cannot undo it.
    if (!active && source === 'admin' && user.deactivatedBy !== 'admin') {
      const [claimed] = await getDb()
        .update(users)
        .set({ deactivatedBy: 'admin', updatedAt: new Date() })
        .where(and(eq(users.id, userId), eq(users.isActive, false)))
        .returning();
      if (claimed) {
        await auditRepository.log({
          userId: actor ?? userId,
          action: 'user_updated',
          resourceType: 'user',
          resourceId: userId,
          details: { isActive: false, source, previousDeactivatedBy: user.deactivatedBy, ...(actor ? { byAdmin: actor } : {}), targetUser: claimed.username },
        });
        return { status: 'unchanged', user: claimed };
      }
    }
    return { status: 'unchanged', user };
  }
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
  const failedSteps = active ? await applyReactivation(userId) : await applyDeactivation(userId, actor ?? userId, source);
  return { status: 'changed', user: updated, failedSteps };
}

/**
 * Everything a deactivation ends. Each step runs even when another fails; each
 * failure is logged and its name returned (the flag itself is already off, and
 * every request re-reads it).
 */
async function applyDeactivation(userId: string, actorId: string, source: ActiveSource): Promise<string[]> {
  const { getSessionManager } = await import('@/security/auth/session');
  const { closeUserSockets } = await import('@/api/user-sockets');
  const { getAgentManager } = await import('@/core/agent-manager');
  const { getPermissionManager } = await import('@/security/permissions');
  const { getAgentService } = await import('@/core/agent');
  const { getImpersonationManager } = await import('@/security/impersonation');
  const { onAccountDeactivated } = await import('@/core/spaces/membership');

  const steps: Array<[string, () => Promise<unknown> | unknown]> = [
    ['revoke sessions', () => getSessionManager().revokeAllForUser(userId)],
    ['close sockets', () => closeUserSockets(userId, DEACTIVATED_CLOSE_CODE, 'Account deactivated')],
    ['stop agents', () => getAgentManager().stopUser(userId)],
    ['expire permission requests', () => getPermissionManager().expireForUser(userId)],
    ['expire approvals', () => getAgentService().expireApprovalsForUser(userId, DEACTIVATED_MESSAGE)],
    ['end impersonations', () => getImpersonationManager().endForTarget(userId)],
    // Room turns, space jobs, data sources and sponsored work (§4.1).
    ['spaces', () => onAccountDeactivated(userId, { actorId, source })],
  ];
  return runLifecycleSteps(userId, steps);
}

/** What a re-activation resumes: the space data sources the deactivation paused. */
async function applyReactivation(userId: string): Promise<string[]> {
  const { onAccountReactivated } = await import('@/core/spaces/membership');
  return runLifecycleSteps(userId, [['spaces', () => onAccountReactivated(userId)]]);
}

async function runLifecycleSteps(userId: string, steps: Array<[string, () => Promise<unknown> | unknown]>): Promise<string[]> {
  const failed: string[] = [];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      securityLogger.error({ err, userId, step: name }, 'Account lifecycle step failed');
      failed.push(name);
    }
  }
  return failed;
}

/**
 * The user's active flag or admin flag changed. A gateway connection fixes its
 * identity, trust and admin rights at auth, so all of the user's connections
 * are closed: the client reconnects and is re-authenticated with the current
 * row (or refused).
 */
export async function onUserChanged(userId: string): Promise<void> {
  // First, so a socket that is still authenticating with the old row closes
  // itself when it registers after the sweeps below.
  markUserChanged(userId);
  // Lazy: the hub module pulls the gateway in, which this module's callers
  // (routes) must not have to load at import time.
  const { getGatewayHub } = await import('@/core/gateway/hub');
  getGatewayHub().connectionManager.closeUserConnections(userId, USER_CHANGED_CLOSE_CODE, 'Account changed');
}
