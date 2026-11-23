import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { mailAccounts, mailMessages } from './mail';
import { users } from './users';

/**
 * What the email channel (src/channels/email/, docs/CHANNELS.md#email) did
 * with each mail of its mailbox, and the replies it sent.
 *
 * An inbound row is claimed (`processing`) before a received mail is looked
 * at, one per `mail_messages` row, so two processes never both answer one
 * mail. It then becomes `accepted` (a turn ran), `answered` (a notice went
 * back: a link code, too large) or `dropped`, with the reason. Dropped mail
 * is recorded, never answered. Outbound rows are the replies, `sent` or
 * `failed`; their Message-IDs let a later reply in the thread find it.
 */
export type EmailChannelDirection = 'in' | 'out';
export type EmailChannelStatus = 'processing' | 'accepted' | 'answered' | 'dropped' | 'sent' | 'drafted' | 'failed';

export const emailChannelMessages = pgTable('email_channel_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => mailAccounts.id, { onDelete: 'cascade' }),
  /** The received mail (inbound rows only). */
  mailMessageId: uuid('mail_message_id').references(() => mailMessages.id, { onDelete: 'set null' }),
  direction: text('direction').$type<EmailChannelDirection>().notNull(),
  status: text('status').$type<EmailChannelStatus>().notNull(),
  /** Why a mail was dropped or answered with a notice, or why a send failed. */
  reason: text('reason'),
  /** The sender (inbound) or the recipient (outbound), lower-cased. */
  address: text('address'),
  /** The Octipus user the address is linked to. */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  messageIdHeader: text('message_id_header'),
  /** The conversation: the session's channel id. */
  threadKey: text('thread_key'),
  /** Kept for accepted mail only: the reply's subject is made from it. */
  subject: text('subject'),
  /** The `References` chain of an accepted mail, for the reply's own. */
  references: text('references'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('email_channel_messages_mail_idx').on(t.mailMessageId),
  index('email_channel_messages_header_idx').on(t.accountId, t.messageIdHeader),
  index('email_channel_messages_address_idx').on(t.accountId, t.address, t.createdAt),
  index('email_channel_messages_thread_idx').on(t.accountId, t.threadKey, t.createdAt),
]);

export type EmailChannelMessage = typeof emailChannelMessages.$inferSelect;
