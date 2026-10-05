import { pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './organizations';
import { sessions } from './sessions';
import { users } from './users';

/**
 * Group channels — shared chats (a Slack or Teams channel, a Telegram group) where Octipus is a member
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
  /**
   * `mention` (default): the bot speaks only when addressed. `listen`: it may
   * offer help with an unanswered question. `proactive`: it may answer one
   * itself. Unprompted posts also need `groupChannels.unpromptedEnabled`.
   */
  mode: text('mode').$type<GroupChannelMode>().default('mention').notNull(),
  /** No unprompted posts while the local hour is in [start, end); null = none. */
  quietHoursStart: smallint('quiet_hours_start'),
  quietHoursEnd: smallint('quiet_hours_end'),
  /** IANA zone for the quiet hours and the daily cap's day. */
  timezone: text('timezone').default('UTC').notNull(),
  maxUnpromptedPerDay: smallint('max_unprompted_per_day').default(8).notNull(),
  minMinutesBetween: smallint('min_minutes_between').default(60).notNull(),
  /** The last unprompted post, and the day (`YYYY-MM-DD` local) the count is for. */
  lastUnpromptedAt: timestamp('last_unprompted_at', { withTimezone: true }),
  unpromptedDay: text('unprompted_day'),
  unpromptedCount: smallint('unprompted_count').default(0).notNull(),
  /**
   * The space the channel is bound to (coworking §9.4), or null. Shared
   * workspaces only: the bridge service checks it on write. While set, the
   * channel's threads are rooms of that space (`group_channel_rooms`).
   */
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [uniqueIndex('group_channels_channel_uniq').on(t.channelType, t.channelId)]);

export const GROUP_CHANNEL_MODES = ['mention', 'listen', 'proactive'] as const;
export type GroupChannelMode = (typeof GROUP_CHANNEL_MODES)[number];

/** A ✅ / ❌ (👍 / 👎) a linked member put on one of the bot's messages. */
export const groupChannelFeedback = pgTable('group_channel_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupChannelId: uuid('group_channel_id').references(() => groupChannels.id, { onDelete: 'cascade' }).notNull(),
  messageId: text('message_id').notNull(),
  threadId: text('thread_id'),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  value: smallint('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [uniqueIndex('group_channel_feedback_uniq').on(t.groupChannelId, t.messageId, t.userId)]);

/**
 * A bound channel's platform thread and the room of the space it is (§9.4).
 * Room sessions carry no `group_channel_id`; this row is the only link.
 */
export const groupChannelRooms = pgTable('group_channel_rooms', {
  groupChannelId: uuid('group_channel_id').references(() => groupChannels.id, { onDelete: 'cascade' }).notNull(),
  threadId: text('thread_id').notNull(),
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [
  primaryKey({ columns: [t.groupChannelId, t.threadId] }),
  uniqueIndex('group_channel_rooms_session_uniq').on(t.sessionId),
]);

export type GroupChannel = typeof groupChannels.$inferSelect;
export type NewGroupChannel = typeof groupChannels.$inferInsert;
