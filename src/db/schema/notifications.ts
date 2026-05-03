import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  /** Phase 4 follow-up — optional workspace scope. NULL = user-level. */
  workspaceId: uuid('workspace_id'),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  read: boolean('read').default(false).notNull(),
  deliveredChannels: text('delivered_channels').array().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
