/**
 * Admin impersonation — Phase 3d multi-user.
 *
 * An admin can open a short-lived "act as <user>" window. While the
 * window is open every API request from the admin's session is
 * routed as the target user (so scopedRepos sees the target's data,
 * permission checks fire as the target, etc.) but the audit trail
 * tags BOTH sides so investigators can always answer "who actually
 * did this?".
 *
 * Storage: `impersonation_sessions` table (migration 0037). Each
 * row is keyed by a SHA-256 hash of the admin's session token, so
 * the auth-derive middleware can do a single indexed lookup on
 * every request without exposing tokens in the table.
 *
 * Lifecycle:
 *
 *   start(adminUser, targetUserId, adminSessionToken)
 *     - validates adminUser.isAdmin
 *     - rejects self-impersonation (no point) and target-not-found
 *     - closes any prior active session for the same admin (replace)
 *     - inserts a fresh row with expires_at = now() + TTL
 *     - audit_log: 'login' with details {impersonate: true, ...}
 *
 *   findActive(sessionTokenHash)
 *     - single indexed lookup on actor_session_hash
 *     - returns the row if started_at AND expires_at > now() AND
 *       ended_at IS NULL
 *
 *   stop(sessionTokenHash, reason='explicit')
 *     - sets ended_at + ended_reason
 *     - audit_log: 'logout' with details {impersonate: true}
 *
 * The cleanup job (out of scope for this PR) sweeps rows where
 * expires_at < now() AND ended_at IS NULL, marking them
 * ended_reason='expired'.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { userRepository } from '@/db/repositories/user-repository';
import { type ImpersonationSession, impersonationSessions } from '@/db/schema/impersonation-sessions';
import type { User } from '@/db/schema/users';
import { securityLogger } from '@/utils/logger';

/** Default impersonation window. Short on purpose — admins should
 *  finish their investigation in one sitting, not leave a backdoor
 *  open across days. */
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export type ImpersonationEndReason = 'explicit' | 'replaced' | 'expired';

export interface StartOptions {
  reason?: string;
  ttlMs?: number;
  ipAddress?: string;
}

export interface StartResult {
  ok: true;
  session: ImpersonationSession;
  target: User;
}

export interface StartError {
  ok: false;
  reason: 'not_admin' | 'self' | 'target_not_found' | 'target_inactive';
}

/** SHA-256 hex of the admin's session token. The auth-derive
 *  middleware passes the same hash for lookup so tokens never live
 *  unhashed in the impersonation table. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class ImpersonationManager {
  private get db() { return getDb(); }

  async start(
    actor: { id: string; username: string; isAdmin: boolean },
    targetUserId: string,
    actorSessionToken: string,
    options: StartOptions = {},
  ): Promise<StartResult | StartError> {
    if (!actor.isAdmin) return { ok: false, reason: 'not_admin' };
    if (targetUserId === actor.id) return { ok: false, reason: 'self' };

    const target = await userRepository.findById(targetUserId);
    if (!target) return { ok: false, reason: 'target_not_found' };
    if (!target.isActive) return { ok: false, reason: 'target_inactive' };

    const tokenHash = hashSessionToken(actorSessionToken);

    // Close any prior active session for this admin (one at a time).
    await this.db
      .update(impersonationSessions)
      .set({ endedAt: new Date(), endedReason: 'replaced' })
      .where(and(
        eq(impersonationSessions.actorUserId, actor.id),
        isNull(impersonationSessions.endedAt),
      ));

    const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
    const [session] = await this.db.insert(impersonationSessions).values({
      actorUserId: actor.id,
      targetUserId: target.id,
      actorSessionHash: tokenHash,
      expiresAt: new Date(Date.now() + ttl),
      reason: options.reason ?? null,
      ipAddress: options.ipAddress ?? null,
    }).returning();

    // Strong audit on the start event — both sides tagged so a search
    // by either user-id finds the entry.
    await auditRepository.log({
      userId: actor.id,
      action: 'login',
      resourceType: 'impersonation_session',
      resourceId: session.id,
      ipAddress: options.ipAddress,
      details: {
        impersonate: true,
        targetUserId: target.id,
        targetUsername: target.username,
        reason: options.reason,
        expiresAt: session.expiresAt.toISOString(),
      },
    });
    // Mirror under the target so a target-side audit search finds it too.
    await auditRepository.log({
      userId: target.id,
      action: 'login',
      resourceType: 'impersonation_session',
      resourceId: session.id,
      ipAddress: options.ipAddress,
      details: {
        impersonate: true,
        actorUserId: actor.id,
        actorUsername: actor.username,
        reason: options.reason,
      },
    });

    securityLogger.warn(
      { actorUserId: actor.id, targetUserId: target.id, sessionId: session.id, reason: options.reason },
      'Admin impersonation started',
    );

    return { ok: true, session, target };
  }

  /**
   * Look up the active impersonation row for a hashed session token.
   * Returns null when there is no active row, the row has ended, or
   * the row has expired.
   *
   * Cheap to call on every request — actor_session_hash is indexed.
   */
  async findActive(actorSessionToken: string): Promise<ImpersonationSession | null> {
    const tokenHash = hashSessionToken(actorSessionToken);
    const [row] = await this.db
      .select()
      .from(impersonationSessions)
      .where(and(
        eq(impersonationSessions.actorSessionHash, tokenHash),
        isNull(impersonationSessions.endedAt),
        gt(impersonationSessions.expiresAt, new Date()),
      ))
      .limit(1);
    return row ?? null;
  }

  /**
   * Stop the active session for a given admin's token. Returns the
   * row that was closed, or null when there was nothing active.
   */
  async stop(
    actorSessionToken: string,
    reason: ImpersonationEndReason = 'explicit',
  ): Promise<ImpersonationSession | null> {
    const tokenHash = hashSessionToken(actorSessionToken);
    const [updated] = await this.db
      .update(impersonationSessions)
      .set({ endedAt: new Date(), endedReason: reason })
      .where(and(
        eq(impersonationSessions.actorSessionHash, tokenHash),
        isNull(impersonationSessions.endedAt),
      ))
      .returning();
    if (!updated) return null;

    await auditRepository.log({
      userId: updated.actorUserId,
      action: 'logout',
      resourceType: 'impersonation_session',
      resourceId: updated.id,
      details: { impersonate: true, targetUserId: updated.targetUserId, endedReason: reason },
    });
    await auditRepository.log({
      userId: updated.targetUserId,
      action: 'logout',
      resourceType: 'impersonation_session',
      resourceId: updated.id,
      details: { impersonate: true, actorUserId: updated.actorUserId, endedReason: reason },
    });

    securityLogger.info(
      { actorUserId: updated.actorUserId, targetUserId: updated.targetUserId, reason },
      'Admin impersonation stopped',
    );
    return updated;
  }

  /**
   * Recent impersonation sessions for the admin console. Ordered most
   * recent first.
   */
  async listRecent(limit = 50): Promise<ImpersonationSession[]> {
    return this.db
      .select()
      .from(impersonationSessions)
      .orderBy(desc(impersonationSessions.startedAt))
      .limit(limit);
  }

  /** Sweep expired-but-not-explicitly-ended rows. */
  async reapExpired(): Promise<number> {
    const result = await this.db
      .update(impersonationSessions)
      .set({ endedAt: new Date(), endedReason: 'expired' })
      .where(and(
        isNull(impersonationSessions.endedAt),
        sql`${impersonationSessions.expiresAt} < now()`,
      ))
      .returning({ id: impersonationSessions.id });
    return result.length;
  }
}

let instance: ImpersonationManager | null = null;
export function getImpersonationManager(): ImpersonationManager {
  if (!instance) instance = new ImpersonationManager();
  return instance;
}
export function _resetImpersonationManagerForTests(): void { instance = null; }
