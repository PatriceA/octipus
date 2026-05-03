import { index, inet, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Admin impersonation — Phase 3d multi-user.
 *
 * One row per "act as" session opened by an admin. The auth-derive
 * middleware joins the admin's session token to this table; if an
 * active row exists (started_at set, ended_at NULL), the request is
 * treated as the target user but `principal.actorUserId` carries the
 * admin's id so audit can tag both sides.
 *
 * Lifecycle:
 *   - POST /api/admin/impersonate/:userId starts a session.
 *   - POST /api/admin/impersonate/stop ends it (sets ended_at).
 *   - Sessions auto-expire after `expires_at` (default: 1 hour) so a
 *     forgotten "act as" session can't outlast the admin's window.
 *
 * Strong audit:
 *   - Start writes audit_log with action='login' and details
 *     {impersonate: true, target_user_id}.
 *   - Stop writes audit_log with action='logout' and details
 *     {impersonate: true}.
 *   - Every state-changing request during the session is tagged via
 *     the audit-shadow middleware with both actor + target.
 *
 * One active session per admin at a time — re-issuing closes the
 * previous one (recorded as ended_by_replace). Prevents "act as"
 * stacking that would obscure the audit trail.
 */
export const impersonationSessions = pgTable('impersonation_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The admin who initiated the impersonation. */
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  /** The user being impersonated. */
  targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  /** Hash of the admin's auth-session token (sha256 hex). Lookup
   *  key: when validating an admin's token, hash it and check this
   *  table for an active row. */
  actorSessionHash: text('actor_session_hash').notNull(),
  /** When the session was started + when it auto-expires. */
  startedAt: timestamp('started_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  /** Set when the session is stopped (explicit POST /stop, replaced
   *  by a new impersonation, or expired by the cleanup job). NULL
   *  means active. */
  endedAt: timestamp('ended_at'),
  /** Why it ended: 'explicit' / 'replaced' / 'expired'. */
  endedReason: text('ended_reason'),
  /** Optional reason the admin gave for the action (free text). */
  reason: text('reason'),
  ipAddress: inet('ip_address'),
}, (table) => ({
  actorIdx: index('impersonation_sessions_actor_idx').on(table.actorUserId),
  targetIdx: index('impersonation_sessions_target_idx').on(table.targetUserId),
  actorSessionHashIdx: index('impersonation_sessions_actor_hash_idx').on(table.actorSessionHash),
  endedAtIdx: index('impersonation_sessions_ended_at_idx').on(table.endedAt),
}));

export type ImpersonationSession = typeof impersonationSessions.$inferSelect;
export type NewImpersonationSession = typeof impersonationSessions.$inferInsert;
