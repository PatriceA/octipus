/**
 * The email channel's own records (`email_channel_messages`), behind one
 * interface so the channel's decisions can be tested without a database
 * (channel.test.ts). The mailbox itself is read through the mail repository
 * as its owner (`MailRepo.channelUnseen`, `MailRepo.raw`), never here.
 */
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type EmailChannelStatus, emailChannelMessages } from '@/db/schema/email-channel';

/** An inbound mail the channel answered or ran: what a reply to it needs. */
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
  /** The draft or sent message in the mailbox; null for an unstored send (a link code). */
  mailMessageId: string | null;
  messageIdHeader: string | null;
  status: 'sent' | 'drafted' | 'failed';
  reason?: string | null;
}

export interface EmailChannelStore {
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
  /**
   * Retention: forget dropped mail recorded before `droppedBefore` and every
   * record before `before`; clear the address and subject of records whose
   * user is gone (or was never linked) once older than `scrubBefore`.
   */
  prune(accountId: string, cutoffs: { droppedBefore: Date; before: Date; scrubBefore: Date }): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dbEmailChannelStore: EmailChannelStore = {
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

  async prune(accountId, { droppedBefore, before, scrubBefore }) {
    const db = getDb();
    await db.delete(emailChannelMessages).where(and(
      eq(emailChannelMessages.accountId, accountId),
      or(
        and(eq(emailChannelMessages.status, 'dropped'), lt(emailChannelMessages.createdAt, droppedBefore)),
        lt(emailChannelMessages.createdAt, before),
      ),
    ));
    await db.update(emailChannelMessages)
      .set({ address: null, subject: null, references: null })
      .where(and(
        eq(emailChannelMessages.accountId, accountId),
        isNull(emailChannelMessages.userId),
        ne(emailChannelMessages.status, 'dropped'),
        lt(emailChannelMessages.createdAt, scrubBefore),
        sql`${emailChannelMessages.address} IS NOT NULL`,
      ));
  },
};
