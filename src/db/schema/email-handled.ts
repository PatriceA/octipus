import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Which inbox messages the heartbeat's email check has shown an agent, and
 * what the agent did with each (core/email/watch.ts). Ids and outcomes only:
 * no sender, subject or body is stored here, the mailbox stays the record of
 * the mail itself.
 *
 * A row starts `surfaced` when a heartbeat turn is given the message, and
 * becomes `handled` when the agent calls `mark_email_handled`. A surfaced row
 * the agent never closed (the turn failed, or it skipped the message) is shown
 * again later, a bounded number of times.
 */
export const emailHandled = pgTable('email_handled', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** 'google' | 'microsoft' */
  provider: text('provider').notNull(),
  messageId: text('message_id').notNull(),
  status: text('status').$type<'surfaced' | 'handled'>().notNull().default('surfaced'),
  /** What the agent did: see EMAIL_OUTCOMES in core/email/watch.ts. */
  outcome: text('outcome'),
  /** The agent's one-line account of it, for the owner. */
  note: text('note'),
  /** The to-do the agent filed for it, when it filed one. */
  taskId: uuid('task_id'),
  surfacedCount: integer('surfaced_count').notNull().default(0),
  surfacedAt: timestamp('surfaced_at', { withTimezone: true }),
  handledAt: timestamp('handled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('email_handled_message_idx').on(t.userId, t.provider, t.messageId),
  index('email_handled_recent_idx').on(t.userId, t.createdAt),
]);

export type EmailHandled = typeof emailHandled.$inferSelect;
