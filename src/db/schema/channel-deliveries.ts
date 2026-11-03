import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Outbound chat messages that failed to send and are waiting to be retried
 * (src/channels/delivery-queue.ts). A message that goes out on the first try
 * never gets a row; one whose send failed (the platform API down, the
 * channel reconnecting, a restart in between) is retried with backoff
 * instead of being logged and lost.
 *
 * `status`: `pending` (waiting for `next_attempt_at`), `sending` (claimed by a
 * flush), `sent`, `failed` (out of attempts; the user got an in-app notice),
 * `dropped` (no longer wanted, or the target is no longer allowed). Finished
 * rows are kept a week for diagnosis, then deleted.
 */
export const channelDeliveries = pgTable('channel_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  channelType: text('channel_type').notNull(),
  channelId: text('channel_id').notNull(),
  content: text('content').notNull(),
  threadId: text('thread_id'),
  /** What sent it (`notification`, `hook_notify`, `hook_result`, `approval`): selects a still-wanted check. */
  kind: text('kind').notNull(),
  /** What the kind's check needs, such as an approval's request id. */
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}).notNull(),
  status: text('status').$type<'pending' | 'sending' | 'sent' | 'failed' | 'dropped'>().default('pending').notNull(),
  attempts: integer('attempts').default(0).notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, (table) => ({
  dueIdx: index('channel_deliveries_due_idx').on(table.status, table.nextAttemptAt),
  userIdx: index('channel_deliveries_user_idx').on(table.userId),
}));

export type ChannelDelivery = typeof channelDeliveries.$inferSelect;
