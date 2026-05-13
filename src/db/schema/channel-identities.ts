import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Channel identities — Phase 2d multi-user.
 *
 * Replaces the legacy `users.channelBindings` JSONB column with a
 * proper relational table. Keyed by `(channel_type, external_id)` so
 * lookup from a channel webhook is O(1) on a unique index. The legacy
 * JSON column stays during the transition; helpers in
 * `src/security/channel-bindings.ts` read from this table first and
 * fall back to the JSON column for back-compat.
 *
 * `verified_at` is set when the binding is established via a one-time
 * code redemption (the user proved control of both the channel
 * external_id AND a logged-in web session). Bindings created via the
 * legacy JSON-column migration have `verified_at = created_at` since
 * the existing flow already required user action to add them.
 */
export const channelIdentities = pgTable('channel_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  /** 'telegram' | 'slack' | 'whatsapp' | 'teams' | 'webchat' | … */
  channelType: text('channel_type').notNull(),
  /** External id from the channel (telegram chat_id, slack user id, …). */
  externalId: text('external_id').notNull(),
  /** Optional human-readable handle (telegram @username, slack display name). */
  externalHandle: text('external_handle'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  channelExternalUnique: unique('channel_identities_channel_external_unique')
    .on(table.channelType, table.externalId),
  userIdIdx: index('channel_identities_user_id_idx').on(table.userId),
  channelTypeIdx: index('channel_identities_channel_type_idx').on(table.channelType),
}));

export type ChannelIdentity = typeof channelIdentities.$inferSelect;
export type NewChannelIdentity = typeof channelIdentities.$inferInsert;

/**
 * Short-lived one-time codes for the channel-binding signup flow.
 *
 * When a channel adapter receives a message from an unbound
 * external_id, it inserts a row here and replies with a deep-link to
 * the web "Link account" page. The user logs in (or is already
 * logged in), enters the code, and the server moves the
 * `(channel_type, external_id)` pair into `channel_identities` keyed
 * to their user_id.
 *
 * Codes expire after 15 minutes. Single-use: redemption sets
 * `redeemed_at` + `redeemed_by_user_id`. Stale rows are reaped by a
 * background job (not in this commit; manual `DELETE` works for now).
 */
export const channelLinkCodes = pgTable('channel_link_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 6-character user-typeable code (alphanumeric, uppercase). */
  code: text('code').notNull().unique(),
  channelType: text('channel_type').notNull(),
  externalId: text('external_id').notNull(),
  externalHandle: text('external_handle'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  redeemedByUserId: uuid('redeemed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  codeIdx: index('channel_link_codes_code_idx').on(table.code),
  expiresAtIdx: index('channel_link_codes_expires_at_idx').on(table.expiresAt),
}));

export type ChannelLinkCode = typeof channelLinkCodes.$inferSelect;
export type NewChannelLinkCode = typeof channelLinkCodes.$inferInsert;
