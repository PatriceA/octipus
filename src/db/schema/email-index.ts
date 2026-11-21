import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/** An address as the index keeps it. */
export interface IndexedAddress { name?: string; email: string }

/**
 * The local index of Gmail / Outlook headers (core/email/mail-index.ts): one
 * row per message, so a folder, a search and the unread count are answered
 * without asking the provider. Headers only: never a body or an attachment.
 * `account` is '' for the user's one account of that provider (several
 * accounts per provider would fill it). Deleted with the user, when the
 * account is disconnected, and when the owner turns the index off.
 */
export const emailIndex = pgTable('email_index', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** 'google' | 'microsoft' */
  provider: text('provider').notNull(),
  account: text('account').notNull().default(''),
  messageId: text('message_id').notNull(),
  threadId: text('thread_id'),
  inbox: boolean('inbox').notNull().default(false),
  sent: boolean('sent').notNull().default(false),
  drafts: boolean('drafts').notNull().default(false),
  archive: boolean('archive').notNull().default(false),
  trash: boolean('trash').notNull().default(false),
  starred: boolean('starred').notNull().default(false),
  unread: boolean('unread').notNull().default(false),
  fromName: text('from_name'),
  fromEmail: text('from_email').notNull().default(''),
  to: jsonb('to').$type<IndexedAddress[]>().notNull().default([]),
  cc: jsonb('cc').$type<IndexedAddress[]>().notNull().default([]),
  subject: text('subject').notNull().default(''),
  /** The provider's own preview, at most 300 characters. */
  snippet: text('snippet').notNull().default(''),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  /** Null: the provider's list did not say (Gmail metadata cannot tell). */
  hasAttachments: boolean('has_attachments'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('email_index_message_idx').on(t.userId, t.provider, t.account, t.messageId),
  index('email_index_received_idx').on(t.userId, t.provider, t.account, t.receivedAt),
]);

/** Where the index of one Graph folder stands. */
export interface IndexFolderState {
  /** The delta link to continue from. */
  deltaLink?: string;
  /** The folder has been read to its end once, so its rows can be served. */
  complete: boolean;
}

export const emailIndexState = pgTable('email_index_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  account: text('account').notNull().default(''),
  /** Gmail: the history id incremental syncs continue from. */
  historyId: text('history_id'),
  /** Graph: per folder, the delta link and whether it was read to its end. */
  folders: jsonb('folders').$type<Record<string, IndexFolderState>>().notNull().default({}),
  /** When the first full read finished; null while it runs. */
  backfilledAt: timestamp('backfilled_at', { withTimezone: true }),
  /** Mail received from here on is in the index; older mail is read live. */
  coveredFrom: timestamp('covered_from', { withTimezone: true }),
  /** Unread mail in the inbox as the provider counts it (exact, not just the indexed window). */
  inboxUnread: integer('inbox_unread'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastError: text('last_error'),
  failures: integer('failures').notNull().default(0),
  nextSyncAt: timestamp('next_sync_at', { withTimezone: true }).notNull().defaultNow(),
  /** The owner last opened this mailbox in the Email page; idle mailboxes stop syncing. */
  lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('email_index_state_mailbox_idx').on(t.userId, t.provider, t.account),
  index('email_index_state_due_idx').on(t.nextSyncAt),
]);

export type EmailIndexRow = typeof emailIndex.$inferSelect;
export type EmailIndexStateRow = typeof emailIndexState.$inferSelect;
