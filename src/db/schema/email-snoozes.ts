import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Snoozed mail (core/email/snooze.ts): a conversation archived until
 * `wakeAt`, when the cron tick moves it back to the inbox, unread. Sender,
 * subject and snippet are kept so the Snoozed list can show the mail while it
 * is out of the inbox. The row is deleted when the mail wakes.
 */
export const emailSnoozes = pgTable('email_snoozes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** 'google' | 'microsoft' */
  provider: text('provider').notNull(),
  /** Which account of the provider, where a user has several; null = the default one. */
  account: text('account'),
  /** The provider's ids of the messages as they are while archived (Outlook gives a moved message a new id). */
  messageIds: jsonb('message_ids').$type<string[]>().notNull(),
  threadId: text('thread_id'),
  fromEmail: text('from_email').notNull(),
  fromName: text('from_name'),
  subject: text('subject').notNull(),
  snippet: text('snippet').notNull(),
  wakeAt: timestamp('wake_at', { withTimezone: true }).notNull(),
  /** Failed wake attempts so far; the next one waits for `nextAttemptAt`. */
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('email_snoozes_user_idx').on(t.userId, t.wakeAt),
  index('email_snoozes_due_idx').on(t.wakeAt),
]);

export type EmailSnooze = typeof emailSnoozes.$inferSelect;
