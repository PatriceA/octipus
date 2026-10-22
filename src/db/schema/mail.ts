import { sql } from 'drizzle-orm';
import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { MailAddress, MailProtocol, MailServer, MailStatus } from '@/shared/mail';
import { workspaces } from './organizations';
import { users } from './users';

/** Raw bytes: postgres-js hands back a Buffer, PGlite a Uint8Array. */
const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value),
});

/**
 * Mail accounts (docs/MAIL.md): an IMAP or POP3 mailbox, optionally with SMTP
 * to send from it. Scoped like `cases`: `user_id` is the author and
 * `workspace_id` decides personal (the owner's own mailbox) or space (a
 * functional mailbox such as info@ or the KIM address, read by every member).
 * Passwords are vault system secrets `mail:<id>:incoming` / `:outgoing`.
 */
export const mailAccounts = pgTable('mail_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  label: text('label').notNull(),
  address: text('address').notNull(),
  displayName: text('display_name'),
  protocol: text('protocol').$type<MailProtocol>().notNull(),
  incoming: jsonb('incoming').$type<MailServer>().notNull(),
  outgoing: jsonb('outgoing').$type<MailServer | null>(),
  folder: text('folder').default('INBOX').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  /**
   * An admin allowed this account's hosts on the local network (the KIM
   * client module, an on-prem Exchange). Without it a host that resolves to
   * a private address is refused, at save and again at every connect.
   */
  localNetwork: boolean('local_network').default(false).notNull(),
  /** File the attachments of received mail into the documents of the account's scope (a fax-to-mail drop). */
  fileAttachments: boolean('file_attachments').default(false).notNull(),
  /** Where the last sync stopped (IMAP: UIDVALIDITY and last UID; POP3: UIDLs passed over). */
  syncState: jsonb('sync_state').$type<MailSyncState>().default({}).notNull(),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastError: text('last_error'),
  /** Syncs failed in a row; spaces the next attempt out. */
  failures: integer('failures').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index('mail_accounts_user_idx').on(table.userId),
  workspaceIdx: index('mail_accounts_workspace_idx').on(table.workspaceId),
}));

export interface MailSyncState {
  uidValidity?: string;
  lastUid?: number;
  /** POP3 messages older than the first sync's window, never fetched. Pruned to what the server still has. */
  skipped?: string[];
}

/**
 * Messages of a mail account: received ones as synced, and drafts and sent
 * mail written here. `user_id` / `workspace_id` repeat the account's, so the
 * scope filters read them directly.
 */
export const mailMessages = pgTable('mail_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').references(() => mailAccounts.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  status: text('status').$type<MailStatus>().notNull(),
  /** The message on the server: IMAP `<uidvalidity>:<uid>`, POP3 its UIDL. Null for mail written here. */
  remoteId: text('remote_id'),
  messageIdHeader: text('message_id_header'),
  inReplyTo: text('in_reply_to'),
  references: text('references'),
  fromAddress: jsonb('from_address').$type<MailAddress | null>(),
  /** Where a reply goes when not to the sender (`Reply-To`). */
  replyTo: jsonb('reply_to').$type<MailAddress[]>().default([]).notNull(),
  toAddresses: jsonb('to_addresses').$type<MailAddress[]>().default([]).notNull(),
  ccAddresses: jsonb('cc_addresses').$type<MailAddress[]>().default([]).notNull(),
  subject: text('subject').default('').notNull(),
  snippet: text('snippet').default('').notNull(),
  bodyText: text('body_text').default('').notNull(),
  bodyHtml: text('body_html'),
  attachments: jsonb('attachments').$type<StoredAttachment[]>().default([]).notNull(),
  unread: boolean('unread').default(false).notNull(),
  /** Received (from the server), sent, or for a draft its last change. */
  date: timestamp('date', { withTimezone: true }).defaultNow().notNull(),
  size: integer('size').default(0).notNull(),
  /** Why the last send failed. */
  error: text('error'),
  /** Who wrote a draft or sent the message (null for received mail). */
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  accountDateIdx: index('mail_messages_account_date_idx').on(table.accountId, table.date),
  remoteIdx: uniqueIndex('mail_messages_remote_idx').on(table.accountId, table.remoteId).where(sql`${table.remoteId} IS NOT NULL`),
  // The same received message twice (an IMAP UIDVALIDITY reset) is stored once.
  receivedIdx: uniqueIndex('mail_messages_received_idx')
    .on(table.accountId, table.messageIdHeader)
    .where(sql`${table.status} = 'received' AND ${table.messageIdHeader} IS NOT NULL`),
}));

export interface StoredAttachment {
  filename: string;
  contentType: string;
  size: number;
}

/** The raw RFC 822 source of a received message, for attachment downloads. Kept apart so lists stay light. */
export const mailRaw = pgTable('mail_raw', {
  messageId: uuid('message_id').primaryKey().references(() => mailMessages.id, { onDelete: 'cascade' }),
  raw: bytea('raw').notNull(),
});

export type MailAccount = typeof mailAccounts.$inferSelect;
export type NewMailAccount = typeof mailAccounts.$inferInsert;
export type MailMessage = typeof mailMessages.$inferSelect;
export type NewMailMessage = typeof mailMessages.$inferInsert;
