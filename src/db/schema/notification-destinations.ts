import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Admin allowlist of shared notification destinations.
 *
 * A hook, notification or monitor may always message chats linked to its
 * owner. Shared chats (a Slack #alerts channel, a Telegram group) are allowed
 * only when an admin lists the `(channel_type, channel_id)` here. `org_id`
 * NULL approves the destination for every user on the instance; otherwise
 * only for members of that org. Enforcement: `src/channels/ownership.ts`.
 */
export const notificationDestinations = pgTable('notification_destinations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  channelType: text('channel_type').notNull(),
  channelId: text('channel_id').notNull(),
  label: text('label'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('notification_destinations_uniq').on(t.channelType, t.channelId, t.orgId)]);

export type NotificationDestination = typeof notificationDestinations.$inferSelect;
export type NewNotificationDestination = typeof notificationDestinations.$inferInsert;
