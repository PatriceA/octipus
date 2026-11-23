/**
 * The email channel's records (`email_channel_messages`) and the mailbox rows
 * it reads (`mail_messages`, `mail_raw`), behind one interface so the
 * channel's decisions can be tested without a database (inbox.test.ts).
 *
 * The channel acts for nobody here: it reads the received mail of its own
 * account, as the mail sync (core/mail/sync.ts) writes it.
 */
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type EmailChannelStatus, emailChannelMessages } from '@/db/schema/email-channel';
import { mailMessages, mailRaw } from '@/db/schema/mail';

/** An accepted inbound mail: what a reply to it needs. */
export interface InboundRecord {
  id: string;
  address: string;
  userId: string | null;
  messageIdHeader: string;
  threadKey: string;
  subject: string;
  references: string | null;
}

export interface InboundPatch {
  status: EmailChannelStatus;
  reason?: string | null;
  address?: string | null;
  userId?: string | null;
  messageIdHeader?: string | null;
  threadKey?: string | null;
  subject?: string | null;
  references?: string | null;
}

export interface OutboundRow {
  accountId: string;
  address: string;
  userId: string | null;
  threadKey: string;
  messageIdHeader: string | null;
  status: 'sent' | 'failed';
  reason?: string | null;
}

export interface EmailChannelStore {
  /**
   * Received mail of the account, stored and received since `since`, that
   * the channel has not looked at, oldest first. Both times count: a first
   * sync stores a month of old mail at once, which is not answered.
   */
  unseen(accountId: string, since: Date, limit: number): Promise<Array<{ id: string; size: number }>>;
  /** The raw source, or null when the mail was too large to keep it. */
  raw(mailMessageId: string): Promise<Buffer | null>;
  /** Claim a received mail: the record's id, or null when it was claimed before (by this or another process). */
  claim(accountId: string, mailMessageId: string): Promise<string | null>;
  finish(id: string, patch: InboundPatch): Promise<void>;
  /** Another record of the account (a mail or a reply) carries this Message-ID. */
  seen(accountId: string, messageIdHeader: string, exceptId: string): Promise<boolean>;
  /** The conversation of `userId` that one of `ids` belongs to, newest first. */
  threadOf(accountId: string, userId: string, ids: readonly string[]): Promise<string | null>;
  /** Mail from `address` that got a turn or a notice since `since`. */
  answeredSince(accountId: string, address: string, since: Date): Promise<number>;
  /** The mail a reply answers: record `id` of the thread, or the thread's newest accepted mail. */
  replyTarget(accountId: string, threadKey: string, id?: string): Promise<InboundRecord | null>;
  recordOutbound(row: OutboundRow): Promise<void>;
  /** Forget dropped mail recorded before `before`. */
  pruneDropped(accountId: string, before: Date): Promise<number>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dbEmailChannelStore: EmailChannelStore = {
  async unseen(accountId, since, limit) {
    return getDb()
      .select({ id: mailMessages.id, size: mailMessages.size })
      .from(mailMessages)
      .leftJoin(emailChannelMessages, eq(emailChannelMessages.mailMessageId, mailMessages.id))
      .where(and(
        eq(mailMessages.accountId, accountId),
        eq(mailMessages.status, 'received'),
        gte(mailMessages.createdAt, since),
        gte(mailMessages.date, since),
        isNull(emailChannelMessages.id),
      ))
      .orderBy(mailMessages.createdAt)
      .limit(limit);
  },

  async raw(mailMessageId) {
    const [row] = await getDb().select({ raw: mailRaw.raw }).from(mailRaw).where(eq(mailRaw.messageId, mailMessageId)).limit(1);
    return row?.raw ?? null;
  },

  async claim(accountId, mailMessageId) {
    const [row] = await getDb()
      .insert(emailChannelMessages)
      .values({ accountId, mailMessageId, direction: 'in', status: 'processing' })
      .onConflictDoNothing()
      .returning({ id: emailChannelMessages.id });
    return row?.id ?? null;
  },

  async finish(id, patch) {
    await getDb().update(emailChannelMessages).set(patch).where(eq(emailChannelMessages.id, id));
  },

  async seen(accountId, messageIdHeader, exceptId) {
    const [row] = await getDb()
      .select({ id: emailChannelMessages.id })
      .from(emailChannelMessages)
      .where(and(
        eq(emailChannelMessages.accountId, accountId),
        eq(emailChannelMessages.messageIdHeader, messageIdHeader),
        ne(emailChannelMessages.id, exceptId),
      ))
      .limit(1);
    return !!row;
  },

  async threadOf(accountId, userId, ids) {
    if (ids.length === 0) return null;
    const [row] = await getDb()
      .select({ threadKey: emailChannelMessages.threadKey })
      .from(emailChannelMessages)
      .where(and(
        eq(emailChannelMessages.accountId, accountId),
        eq(emailChannelMessages.userId, userId),
        inArray(emailChannelMessages.messageIdHeader, [...ids]),
        sql`${emailChannelMessages.threadKey} IS NOT NULL`,
      ))
      .orderBy(desc(emailChannelMessages.createdAt))
      .limit(1);
    return row?.threadKey ?? null;
  },

  async answeredSince(accountId, address, since) {
    const [row] = await getDb()
      .select({ n: count() })
      .from(emailChannelMessages)
      .where(and(
        eq(emailChannelMessages.accountId, accountId),
        eq(emailChannelMessages.direction, 'in'),
        eq(emailChannelMessages.address, address),
        inArray(emailChannelMessages.status, ['accepted', 'answered']),
        gte(emailChannelMessages.createdAt, since),
      ));
    return Number(row?.n ?? 0);
  },

  async replyTarget(accountId, threadKey, id) {
    const [row] = await getDb()
      .select()
      .from(emailChannelMessages)
      .where(and(
        eq(emailChannelMessages.accountId, accountId),
        eq(emailChannelMessages.direction, 'in'),
        eq(emailChannelMessages.threadKey, threadKey),
        inArray(emailChannelMessages.status, ['accepted', 'answered']),
        ...(id && UUID.test(id) ? [eq(emailChannelMessages.id, id)] : []),
      ))
      .orderBy(desc(emailChannelMessages.createdAt))
      .limit(1);
    if (!row?.address || !row.messageIdHeader || !row.threadKey) return null;
    return {
      id: row.id, address: row.address, userId: row.userId, messageIdHeader: row.messageIdHeader,
      threadKey: row.threadKey, subject: row.subject ?? '', references: row.references,
    };
  },

  async recordOutbound(row) {
    await getDb().insert(emailChannelMessages).values({ ...row, direction: 'out' });
  },

  async pruneDropped(accountId, before) {
    const rows = await getDb()
      .delete(emailChannelMessages)
      .where(and(eq(emailChannelMessages.accountId, accountId), eq(emailChannelMessages.status, 'dropped'), lt(emailChannelMessages.createdAt, before)))
      .returning({ id: emailChannelMessages.id });
    return rows.length;
  },
};
