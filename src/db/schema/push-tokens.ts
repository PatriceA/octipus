import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * FCM registration tokens of paired mobile devices. One row per device; a
 * token that FCM reports as unregistered is deleted on the next send.
 */
export const pushTokens = pgTable('push_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  token: text('token').notNull().unique(),
  platform: text('platform').notNull(), // android | ios
  deviceName: text('device_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('push_tokens_user_id_idx').on(table.userId),
}));

export type PushToken = typeof pushTokens.$inferSelect;
