import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';
import { workspaces } from './organizations';

/**
 * Group channels — shared chats (a Slack channel) where Octipus is a member
 * of the conversation rather than a 1:1 assistant.
 *
 * A channel is enrolled by a workspace owner from inside the channel
 * (`@octipus join`), which proves they are a member. Until a row exists the
 * bot stays silent there. Turns always run as the member who addressed the
 * bot, in that member's own session for the thread
 * (`sessions.group_channel_id`); the owner holds the enrolment, not the
 * conversations. Design: `docs/plans/group-chat-bot.md`.
 */
export const groupChannels = pgTable('group_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelType: text('channel_type').notNull(),
  channelId: text('channel_id').notNull(),
  /** Display name at enrolment time (e.g. `#release`), for the settings pages. */
  label: text('label'),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [uniqueIndex('group_channels_channel_uniq').on(t.channelType, t.channelId)]);

export type GroupChannel = typeof groupChannels.$inferSelect;
export type NewGroupChannel = typeof groupChannels.$inferInsert;
