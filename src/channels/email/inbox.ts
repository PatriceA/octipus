/**
 * The email channel's decision for one received mail (docs/CHANNELS.md#email):
 * a turn, a short notice back, or dropped and recorded — never answered.
 *
 * In order, each step failing closed, the cheap ones first:
 *
 *  1. Claim the mail (one record per received mail: no mail is handled twice,
 *     by this process or another).
 *  2. Too old (it arrived longer ago than the lookback: a first sync, an
 *     outage, a flood that kept the channel busy): recorded, not answered.
 *  3. Well-formed headers (no bare CR), then the loop guards: no Message-ID,
 *     our own address, auto replies, bulk and list mail, bounces.
 *  4. Exactly one plain `From` address.
 *  5. The Message-ID seen before (the same mail again, or one of our own
 *     replies coming back).
 *  6. The receiving server reported DMARC pass for the From domain
 *     (headers.ts). Otherwise dropped: a forged sender gets no answer (no
 *     backscatter).
 *  7. The sender is allow-listed.
 *  8. The sender's hourly limit.
 *  9. The address is linked to an Octipus account (the same link codes as
 *     every channel). If not, the sender — authenticated and allow-listed by
 *     now — gets a link code (subject `link`) or how to get one.
 * 10. Size: larger than allowed, the sender is told so.
 * 11. The new text and the attachments become the turn, in the thread the
 *     mail replies to (a reply to one of our replies continues its session).
 *
 * A failure part way records the mail as dropped (`error`) rather than
 * leaving it claimed and unexplained.
 */
import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { addressesOf } from '@/core/mail/parse';
import type { Attachment } from '@/core/types';
import { FORWARD_SUBJECT, MAX_REFERENCES, mailContent } from './content';
import { authenticationVerdict, domainOf, headerBlock, type HeaderLine, headerLines, type LoopReason, loopReason, MalformedHeaders, messageIds, plainFromAddress } from './headers';
import type { EmailChannelStore, InboundRecord } from './store';

export interface InboxSettings {
  accountId: string;
  /** The channel mailbox's own address. */
  ownAddress: string;
  allowedSenders: readonly string[];
  trustedAuthservIds: readonly string[];
  maxMessageBytes: number;
  maxPerSenderPerHour: number;
  /** Mail that arrived longer ago than this is recorded and not answered. */
  lookbackMs: number;
}

export type NoticeKind = 'link_code' | 'not_linked' | 'too_large';

export interface InboxDeps {
  store: EmailChannelStore;
  /** The raw source of a received mail of the channel mailbox; null when it was too large to keep. */
  raw(mailMessageId: string): Promise<Buffer | null>;
  /** The Octipus user this address is linked to on the email channel. */
  linkedUser(address: string): Promise<{ id: string; username: string } | null>;
  /** A link code for this address (`channel_link_codes`). */
  linkCode(address: string): Promise<string>;
  /** Send a notice in reply to a mail (not a turn's answer). */
  notice(to: InboundRecord, text: string, kind: NoticeKind): Promise<void>;
  now(): Date;
}

export type DropReason = LoopReason | 'too_old' | 'unreadable' | 'malformed' | 'from_header' | 'duplicate' | 'unauthenticated'
  | 'not_allowed' | 'rate_limited' | 'empty' | 'error';

export interface InboundTurn {
  /** The channel's record of the mail: a reply names it. */
  recordId: string;
  /** The conversation (the session's channel id). */
  threadKey: string;
  userId: string;
  address: string;
  content: string;
  attachments: Attachment[];
}

export type InboundOutcome =
  | { kind: 'turn'; turn: InboundTurn }
  | { kind: 'answered'; reason: NoticeKind }
  | { kind: 'dropped'; reason: DropReason }
  | { kind: 'claimed_elsewhere' };

const HOUR_MS = 60 * 60_000;

/** A conversation's key: per user, from the mail that started it. Pure. */
export function threadKeyFor(userId: string, messageId: string): string {
  return createHash('sha256').update(`${userId}\n${messageId}`).digest('hex').slice(0, 32);
}

/** Address comparison: trimmed, lower-cased, the domain in ASCII form. */
export function normalizeAddress(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  const domain = at >= 0 ? domainOf(a) : '';
  return at >= 0 && domain ? `${a.slice(0, at)}@${domain}` : a;
}

/** Look at one received mail (`mail_messages` row) and decide. */
export async function handleInbound(mail: { id: string; size: number; date: Date }, settings: InboxSettings, deps: InboxDeps): Promise<InboundOutcome> {
  const recordId = await deps.store.claim(settings.accountId, mail.id);
  if (!recordId) return { kind: 'claimed_elsewhere' };
  try {
    return await decide(recordId, mail, settings, deps);
  } catch (err) {
    await deps.store.finish(recordId, { status: 'dropped', reason: 'error' });
    throw err;
  }
}

async function decide(recordId: string, mail: { id: string; size: number; date: Date }, settings: InboxSettings, deps: InboxDeps): Promise<InboundOutcome> {
  const { store } = deps;
  const drop = async (reason: DropReason, address: string | null = null, messageIdHeader: string | null = null): Promise<InboundOutcome> => {
    await store.finish(recordId, { status: 'dropped', reason, address, messageIdHeader });
    return { kind: 'dropped', reason };
  };
  const now = deps.now();
  if (mail.date.getTime() < now.getTime() - settings.lookbackMs) return drop('too_old');

  // Over the mail stack's own limit only the headers were fetched and no raw is kept: nothing can be checked.
  const raw = await deps.raw(mail.id);
  if (!raw) return drop('unreadable');
  let lines: HeaderLine[];
  try {
    lines = headerLines(raw);
  } catch (err) {
    if (err instanceof MalformedHeaders) return drop('malformed');
    throw err;
  }
  let headers: Awaited<ReturnType<typeof simpleParser>>;
  try {
    headers = await simpleParser(headerBlock(raw), { skipHtmlToText: true, skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  } catch {
    return drop('unreadable');
  }
  const parsedFrom = addressesOf(headers.from).map((a) => a.address);
  const plain = plainFromAddress(lines, parsedFrom);
  const address = plain ? normalizeAddress(plain) : null;
  const messageId = messageIds(lines.find((l) => l.name === 'message-id')?.value)[0] ?? null;

  const loop = loopReason(lines, address ?? parsedFrom[0] ?? '', settings.ownAddress);
  if (loop) return drop(loop, address, messageId);
  if (!address || !messageId) return drop('from_header', address, messageId);
  if (await store.seen(settings.accountId, messageId, recordId)) return drop('duplicate', address, messageId);

  const verdict = authenticationVerdict(lines, domainOf(address), settings.trustedAuthservIds);
  if (!verdict.ok) return drop('unauthenticated', address, messageId);
  if (!settings.allowedSenders.some((a) => normalizeAddress(a) === address)) return drop('not_allowed', address, messageId);
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  if (await store.answeredSince(settings.accountId, address, hourAgo) >= settings.maxPerSenderPerHour) {
    return drop('rate_limited', address, messageId);
  }

  const subject = (headers.subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  // The chain as RFC 5322 orders it: References oldest first, then In-Reply-To; the newest kept.
  const refs = [...new Set([
    ...messageIds(lines.find((l) => l.name === 'references')?.value),
    ...messageIds(lines.find((l) => l.name === 'in-reply-to')?.value),
  ])].slice(-MAX_REFERENCES);
  const references = refs.length ? refs.join(' ') : null;

  // From here the sender is authenticated and allowed: a notice back is an answer, not backscatter.
  const answer = async (kind: NoticeKind, text: string, userId: string | null): Promise<InboundOutcome> => {
    const threadKey = threadKeyFor(userId ?? `unlinked:${address}`, messageId);
    await store.finish(recordId, { status: 'answered', reason: kind, address, userId, messageIdHeader: messageId, threadKey, subject, references });
    await deps.notice({ id: recordId, address, userId, messageIdHeader: messageId, threadKey, subject, references }, text, kind);
    return { kind: 'answered', reason: kind };
  };

  const user = await deps.linkedUser(address);
  if (!user) {
    if (/^link$/i.test(subject)) {
      const code = await deps.linkCode(address);
      return answer('link_code', `Your link code: ${code}\n\nEnter it in Octipus under Settings → Channels within 15 minutes. After that, mail to this address reaches your Octipus.`, null);
    }
    return answer('not_linked', 'This address is not linked to an Octipus account yet. Send a mail with the subject "link" to this address to get a link code, then enter it in Octipus under Settings → Channels.', null);
  }
  if (Math.max(mail.size, raw.length) > settings.maxMessageBytes) {
    const mb = Math.max(1, Math.round(settings.maxMessageBytes / 1024 / 1024));
    return answer('too_large', `Your mail is larger than ${mb} MB, the most Octipus takes by mail, so it was not read. Send a smaller one, or upload the files in the Octipus web app.`, user.id);
  }

  const content = await mailContent(raw);
  let text = content.text;
  // A new mail's subject is often the request itself; a reply's ("Re: …") or a forward's is not.
  if (subject && !/^(re|aw|sv|antw)\s*:/i.test(subject) && !FORWARD_SUBJECT.test(subject)) text = text ? `${subject}\n\n${text}` : subject;
  if (content.omitted.length) text += `\n\n[${content.omitted.length} more attachment(s) were not passed on: at most ${content.attachments.length} are taken from one mail.]`;
  if (!text.trim() && content.attachments.length === 0) return drop('empty', address, messageId);

  const threadKey = await store.threadOf(settings.accountId, user.id, refs) ?? threadKeyFor(user.id, messageId);
  await store.finish(recordId, { status: 'accepted', reason: null, address, userId: user.id, messageIdHeader: messageId, threadKey, subject, references });
  return { kind: 'turn', turn: { recordId, threadKey, userId: user.id, address, content: text, attachments: content.attachments } };
}
