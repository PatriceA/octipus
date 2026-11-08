import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { hooks } from './hooks';

/**
 * One heartbeat gate evaluation (docs/HEARTBEAT.md, "Seeing what it decided").
 *
 * The gate is cheap-first and silent by default: most checks skip before any
 * model call. Without this record a skip was a debug log line, so "why did my
 * writer not pick up the to-do?" had no answer in the product. Ids, a reason
 * and a count only: no task titles, mail or PR text.
 */
export const heartbeatChecks = pgTable('heartbeat_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  hookId: uuid('hook_id').notNull().references(() => hooks.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
  /** True when the gate started a turn. */
  ran: boolean('ran').notNull(),
  /** `HeartbeatSkipReason` when it did not. */
  reason: text('reason'),
  /** A role heartbeat's ready to-dos at the check, when the probe got that far. */
  readyTasks: integer('ready_tasks'),
}, (table) => ({
  hookCheckedIdx: index('heartbeat_checks_hook_checked_idx').on(table.hookId, table.checkedAt),
  userCheckedIdx: index('heartbeat_checks_user_checked_idx').on(table.userId, table.checkedAt),
}));

export type HeartbeatCheck = typeof heartbeatChecks.$inferSelect;
