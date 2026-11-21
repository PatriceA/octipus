/**
 * The Google / Microsoft 365 mailbox as a mail client needs it
 * (docs/plans/email-calendar-ux.md, phases 1 and 5): folders, search, whole
 * conversations, attachments, and actions on several messages at once. The
 * shapes are the ones in src/shared/email.ts.
 *
 * Like the rest of core/email this is a live view of the provider: every call
 * runs on the calling user's own OAuth token, nothing is stored, and no
 * sender, subject or body is logged. Mail is untrusted: HTML is sanitized in
 * normalize.ts, ids go into provider paths as single encoded segments, and a
 * page token from the client is never used as a URL.
 *
 * A message is never deleted here. `trash` moves it to the provider's trash,
 * where the provider keeps it for its own retention period.
 */
import { randomBytes } from 'node:crypto';
import { EMAIL_FOLDERS } from '@/shared/email';
import type { EmailAccountsResponse, EmailAttachment, EmailBatchAction, EmailBatchResponse, EmailFolder, EmailListResponse, EmailMessage, EmailProvider, InboxItem } from '@/shared/email';
import { mapLimit } from '@/utils/concurrency';
import { coreLogger } from '@/utils/logger';
import { buildGmailBatch, parseGmailBatch } from './gmail-batch';
import { findGmailPart, type GmailMessage, type GraphMessage, gmailToMessage, m365ToMessage, normalizeGmail, normalizeM365List } from './normalize';
import { connectedProviders, detectProvider, gmailApi, gmailBatch, graphApi, graphBytes } from './providers';

/** A request the mailbox cannot serve; `status` is the HTTP status to answer with. */
export class MailboxError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const providerLabel = (provider: EmailProvider) => (provider === 'google' ? 'Google' : 'Microsoft 365');

/**
 * The mailbox a request works on: the one it names, when that is connected,
 * else the user's default (Google first, as before). Null: none connected.
 */
export async function resolveProvider(userId: string, requested?: string | null): Promise<EmailProvider | null> {
  if (!requested) return detectProvider(userId);
  if (requested !== 'google' && requested !== 'microsoft') throw new MailboxError('provider must be "google" or "microsoft".');
  if (!(await connectedProviders(userId)).includes(requested)) {
    throw new MailboxError(`${providerLabel(requested)} is not connected. Connect it in Settings → Integrations.`);
  }
  return requested;
}

// ── Accounts ────────────────────────────────────────────────────────────

const ADDRESS_TTL_MS = 10 * 60_000;
const addresses = new Map<string, { at: number; address: string }>();

async function accountAddress(userId: string, provider: EmailProvider): Promise<string | undefined> {
  const key = `${userId}\n${provider}`;
  const hit = addresses.get(key);
  if (hit && Date.now() - hit.at < ADDRESS_TTL_MS) return hit.address;
  try {
    let found: string | undefined;
    if (provider === 'google') {
      found = ((await gmailApi(userId, 'GET', '/profile')) as { emailAddress?: string }).emailAddress;
    } else {
      const me = (await graphApi(userId, 'GET', '/me?$select=mail,userPrincipalName')) as { mail?: string | null; userPrincipalName?: string };
      found = me.mail || me.userPrincipalName;
    }
    if (!found) return undefined;
    if (addresses.size > 2000) addresses.clear();
    addresses.set(key, { at: Date.now(), address: found });
    return found;
  } catch {
    return undefined; // the account is still listed, without its address
  }
}

/** The connected mailboxes, Google first, each with its address when the provider tells it. */
export async function listAccounts(userId: string): Promise<EmailAccountsResponse> {
  const providers = await connectedProviders(userId);
  const accounts = await Promise.all(providers.map(async (provider) => {
    const address = await accountAddress(userId, provider);
    return { provider, ...(address ? { address } : {}) };
  }));
  return { accounts };
}

// ── Listing ─────────────────────────────────────────────────────────────

export interface ListOptions {
  folder: EmailFolder;
  /** Free-text search, in the provider's own search syntax. */
  q?: string;
  unread?: boolean;
  limit: number;
  pageToken?: string;
}

export function isEmailFolder(value: unknown): value is EmailFolder {
  return typeof value === 'string' && (EMAIL_FOLDERS as readonly string[]).includes(value);
}

const cleanQuery = (q: string | undefined) => (q ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

/** Gmail's own page tokens are opaque; only their alphabet is checked. */
const GMAIL_PAGE_TOKEN = /^[A-Za-z0-9_-]{1,512}$/;

const GMAIL_FOLDER: Record<EmailFolder, { labels: string[]; q?: string; spamTrash?: boolean }> = {
  inbox: { labels: ['INBOX'] },
  starred: { labels: ['STARRED'] },
  sent: { labels: ['SENT'] },
  drafts: { labels: ['DRAFT'] },
  // Gmail has no archive folder: archived mail is mail that left the inbox and is none of the others.
  archive: { labels: [], q: '-in:inbox -in:sent -in:drafts -in:chats' },
  trash: { labels: ['TRASH'], spamTrash: true },
};

/** The `users.messages.list` path for a folder view. Pure; throws MailboxError on a bad page token. */
export function gmailListPath(opts: ListOptions): string {
  const folder = GMAIL_FOLDER[opts.folder];
  const params = [`maxResults=${opts.limit}`];
  for (const label of [...folder.labels, ...(opts.unread ? ['UNREAD'] : [])]) params.push(`labelIds=${label}`);
  const q = [folder.q, cleanQuery(opts.q)].filter(Boolean).join(' ');
  if (q) params.push(`q=${encodeURIComponent(q)}`);
  if (folder.spamTrash) params.push('includeSpamTrash=true');
  if (opts.pageToken) {
    if (!GMAIL_PAGE_TOKEN.test(opts.pageToken)) throw new MailboxError('Invalid page token.');
    params.push(`pageToken=${opts.pageToken}`);
  }
  return `/messages?${params.join('&')}`;
}

/** Graph's well-known folder names; `starred` is a filter over every folder. */
const GRAPH_FOLDER: Record<EmailFolder, string> = {
  inbox: '/me/mailFolders/inbox/messages',
  starred: '/me/messages',
  sent: '/me/mailFolders/sentitems/messages',
  drafts: '/me/mailFolders/drafts/messages',
  archive: '/me/mailFolders/archive/messages',
  trash: '/me/mailFolders/deleteditems/messages',
};
const GRAPH_LIST_SELECT = 'id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments,flag';
const GRAPH_SKIP_TOKEN = /^[A-Za-z0-9_\-.~!*'()%=+/]{1,2000}$/;

/**
 * A Graph page token as the client holds it: `s<offset>` for an ordered list,
 * `k<skiptoken>` for a search (which Graph pages with its own token only).
 * The client never hands over a URL. Pure.
 */
export function parseGraphPageToken(token: string | undefined): { skip: number } | { skipToken: string } {
  if (!token) return { skip: 0 };
  if (/^s\d{1,7}$/.test(token)) return { skip: Number(token.slice(1)) };
  if (token.startsWith('k') && GRAPH_SKIP_TOKEN.test(token.slice(1))) return { skipToken: token.slice(1) };
  throw new MailboxError('Invalid page token.');
}

/** The `k…` page token for a Graph next link: only its `$skiptoken`, and only from Graph itself. Pure. */
export function graphNextPageToken(nextLink: unknown): string | undefined {
  if (typeof nextLink !== 'string') return undefined;
  try {
    const url = new URL(nextLink);
    if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com') return undefined;
    const token = url.searchParams.get('$skiptoken') ?? url.searchParams.get('$skipToken');
    return token && GRAPH_SKIP_TOKEN.test(token) ? `k${token}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Graph messages path for a folder view. Pure.
 *
 * Graph refuses `$search` together with `$orderby`, `$filter` or `$skip`, so a
 * search carries "unread" and "flagged" inside the query (KQL) and pages with
 * the skip token. A filtered list must name its sort property first in the
 * filter, hence the always-true date clause.
 */
export function graphListPath(opts: ListOptions): string {
  const page = parseGraphPageToken(opts.pageToken);
  const params = [`$select=${GRAPH_LIST_SELECT}`, `$top=${opts.limit}`];
  const q = cleanQuery(opts.q).replace(/["\\]/g, ' ').trim();
  if (q) {
    const kql = [q, ...(opts.unread ? ['isread:false'] : []), ...(opts.folder === 'starred' ? ['isflagged:true'] : [])].join(' ');
    params.push(`$search=${encodeURIComponent(`"${kql}"`)}`);
    if ('skipToken' in page) params.push(`$skiptoken=${encodeURIComponent(page.skipToken)}`);
    else if (page.skip > 0) throw new MailboxError('Invalid page token.');
  } else {
    if ('skipToken' in page) throw new MailboxError('Invalid page token.');
    const filters = [...(opts.unread ? ['isRead eq false'] : []), ...(opts.folder === 'starred' ? ["flag/flagStatus eq 'flagged'"] : [])];
    if (filters.length) params.push(`$filter=${encodeURIComponent(['receivedDateTime ge 1900-01-01T00:00:00Z', ...filters].join(' and '))}`);
    params.push(`$orderby=${encodeURIComponent('receivedDateTime desc')}`);
    if (page.skip > 0) params.push(`$skip=${page.skip}`);
  }
  return `${GRAPH_FOLDER[opts.folder]}?${params.join('&')}`;
}

const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GMAIL_METADATA = 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date';

/**
 * The list rows for Gmail message ids, in the order given: one batch request
 * for the page, and one request each only for what the batch did not answer
 * (or for all of them when the batch itself fails). A message that cannot be
 * read (deleted in between) is left out.
 */
export async function gmailRows(userId: string, ids: string[]): Promise<InboxItem[]> {
  if (ids.length === 0) return [];
  const got = new Map<string, GmailMessage>();
  if (ids.every((id) => GMAIL_ID.test(id))) {
    try {
      const boundary = `batch_${randomBytes(12).toString('hex')}`;
      const answer = await gmailBatch(userId, buildGmailBatch(ids.map((id) => `/gmail/v1/users/me/messages/${id}?${GMAIL_METADATA}`), boundary), boundary);
      for (const [index, result] of parseGmailBatch(answer.contentType, answer.text)) {
        const body = result.body as GmailMessage | null;
        // The answer must be the message asked for at that position.
        if (result.status === 200 && body && body.id === ids[index]) got.set(body.id, body);
      }
    } catch (err) {
      coreLogger.warn({ userId, error: String((err as Error)?.message ?? err).slice(0, 120) }, 'email: Gmail batch failed; fetching messages one by one');
    }
  }
  const missing = ids.filter((id) => !got.has(id));
  await mapLimit(missing, 5, async (id) => {
    try {
      got.set(id, (await gmailApi(userId, 'GET', `/messages/${encodeURIComponent(id)}?${GMAIL_METADATA}`)) as GmailMessage);
    } catch {
      // Gone since the list call, or refused: the row is left out.
    }
  });
  return ids.flatMap((id) => {
    const msg = got.get(id);
    return msg ? [normalizeGmail(msg)] : [];
  });
}

async function unreadInInbox(userId: string, provider: EmailProvider): Promise<number | undefined> {
  try {
    const n = provider === 'google'
      ? ((await gmailApi(userId, 'GET', '/labels/INBOX')) as { messagesUnread?: number }).messagesUnread
      : ((await graphApi(userId, 'GET', '/me/mailFolders/inbox?$select=unreadItemCount')) as { unreadItemCount?: number }).unreadItemCount;
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

// A short memory of list pages, so coming back to the page (or to a folder
// just left) shows at once. Per user, never shared, dropped on every change.
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 400;
const cache = new Map<string, { at: number; value: EmailListResponse }>();
const cacheKey = (userId: string, provider: EmailProvider, o: ListOptions) =>
  [userId, provider, o.folder, cleanQuery(o.q), o.unread ? 'u' : '', o.limit, o.pageToken ?? ''].join('\n');

/** Forget this user's remembered list pages: call after anything that changes their mailbox. */
export function invalidateEmailCache(userId: string): void {
  const prefix = `${userId}\n`;
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

/** One page of a folder, newest first. `fresh` skips (and replaces) the remembered page. */
export async function listMessages(userId: string, provider: EmailProvider, opts: ListOptions, fresh = false): Promise<EmailListResponse> {
  const key = cacheKey(userId, provider, opts);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const wantsCount = opts.folder === 'inbox' && !opts.pageToken && !cleanQuery(opts.q);
  const counting = wantsCount ? unreadInInbox(userId, provider) : Promise.resolve(undefined);
  let items: InboxItem[];
  let nextPageToken: string | undefined;
  if (provider === 'google') {
    const list = (await gmailApi(userId, 'GET', gmailListPath(opts))) as { messages?: Array<{ id: string }>; nextPageToken?: string };
    items = await gmailRows(userId, (list.messages ?? []).slice(0, opts.limit).map((m) => m.id));
    nextPageToken = list.nextPageToken && GMAIL_PAGE_TOKEN.test(list.nextPageToken) ? list.nextPageToken : undefined;
  } else {
    const page = parseGraphPageToken(opts.pageToken);
    const res = (await graphApi(userId, 'GET', graphListPath(opts))) as { value?: GraphMessage[]; '@odata.nextLink'?: string };
    items = normalizeM365List(res.value ?? []);
    nextPageToken = cleanQuery(opts.q)
      ? graphNextPageToken(res['@odata.nextLink'])
      : items.length === opts.limit && 'skip' in page ? `s${page.skip + opts.limit}` : undefined;
  }
  const unreadCount = await counting;
  const value: EmailListResponse = { provider, items, ...(nextPageToken ? { nextPageToken } : {}), ...(unreadCount !== undefined ? { unreadCount } : {}) };
  if (cache.size >= CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ── Reading ─────────────────────────────────────────────────────────────

const GRAPH_FULL_SELECT = `${GRAPH_LIST_SELECT},ccRecipients,body`;
/** Messages of one conversation shown at once; a longer one shows its newest. */
export const THREAD_MAX = 50;

interface GraphAttachment { id?: string; name?: string; size?: number; contentType?: string | null; isInline?: boolean; '@odata.type'?: string }

async function graphAttachments(userId: string, messageId: string): Promise<EmailAttachment[]> {
  const res = (await graphApi(userId, 'GET', `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,size,contentType,isInline`)) as { value?: GraphAttachment[] };
  return (res.value ?? [])
    .filter((a) => a.id && !a.isInline)
    .map((a) => ({ id: a.id as string, name: a.name || 'attachment', size: a.size ?? 0, contentType: (a.contentType || 'application/octet-stream').toLowerCase() }));
}

async function graphFull(userId: string, msg: GraphMessage): Promise<EmailMessage> {
  const message = m365ToMessage(msg);
  if (!msg.hasAttachments) return message;
  // The message is still readable when its attachment list is not.
  const attachments = await graphAttachments(userId, msg.id).catch(() => [] as EmailAttachment[]);
  return attachments.length ? { ...message, attachments } : message;
}

/** One full message, with cc and its attachments listed. */
export async function readMessage(userId: string, provider: EmailProvider, id: string): Promise<EmailMessage> {
  if (provider === 'google') {
    return gmailToMessage((await gmailApi(userId, 'GET', `/messages/${encodeURIComponent(id)}?format=full`)) as GmailMessage);
  }
  return graphFull(userId, (await graphApi(userId, 'GET', `/me/messages/${encodeURIComponent(id)}?$select=${GRAPH_FULL_SELECT}`)) as GraphMessage);
}

/** Every message of a conversation, oldest first (the newest THREAD_MAX of a longer one). */
export async function getThread(userId: string, provider: EmailProvider, threadId: string): Promise<EmailMessage[]> {
  let messages: EmailMessage[];
  if (provider === 'google') {
    const thread = (await gmailApi(userId, 'GET', `/threads/${encodeURIComponent(threadId)}?format=full`)) as { messages?: GmailMessage[] };
    messages = (thread.messages ?? []).map(gmailToMessage);
  } else {
    // OData string literal: a quote is doubled. No $orderby: Graph refuses one that the filter does not lead with.
    const filter = encodeURIComponent(`conversationId eq '${threadId.replace(/'/g, "''")}'`);
    const res = (await graphApi(userId, 'GET', `/me/messages?$filter=${filter}&$select=${GRAPH_FULL_SELECT}&$top=${THREAD_MAX}`)) as { value?: GraphMessage[] };
    messages = await mapLimit(res.value ?? [], 4, (msg) => graphFull(userId, msg));
  }
  return messages.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(-THREAD_MAX);
}

// ── Attachments ─────────────────────────────────────────────────────────

/** The largest attachment served through the API (the size IMAP mail is kept whole up to, docs/MAIL.md). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const TOO_LARGE = 'This attachment is too large to download here. Open the message in your mail client.';

export interface AttachmentFile { name: string; contentType: string; content: Uint8Array }

/**
 * One attachment's bytes. For Gmail the id is the part's position in the
 * message (Gmail's own attachment ids change on every read); for Graph it is
 * the attachment id.
 */
export async function getAttachment(userId: string, provider: EmailProvider, messageId: string, attachmentId: string): Promise<AttachmentFile> {
  if (provider === 'google') {
    if (!/^[0-9]{1,3}(\.[0-9]{1,3}){0,9}$/.test(attachmentId)) throw new MailboxError('Attachment not found', 404);
    const msg = (await gmailApi(userId, 'GET', `/messages/${encodeURIComponent(messageId)}?format=full`)) as GmailMessage;
    const part = findGmailPart(msg.payload, attachmentId);
    if (!part?.filename || (!part.body?.attachmentId && !part.body?.data)) throw new MailboxError('Attachment not found', 404);
    if ((part.body.size ?? 0) > ATTACHMENT_MAX_BYTES) throw new MailboxError(TOO_LARGE, 413);
    const data = part.body.data
      ?? ((await gmailApi(userId, 'GET', `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId as string)}`)) as { data?: string }).data;
    if (!data) throw new MailboxError('Attachment not found', 404);
    const content = new Uint8Array(Buffer.from(data, 'base64url'));
    if (content.byteLength > ATTACHMENT_MAX_BYTES) throw new MailboxError(TOO_LARGE, 413);
    return { name: part.filename, contentType: part.mimeType || 'application/octet-stream', content };
  }
  const base = `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
  const meta = (await graphApi(userId, 'GET', `${base}?$select=id,name,size,contentType`)) as GraphAttachment;
  // An attached Outlook item or a link to a cloud file has no bytes of its own.
  if (meta['@odata.type'] && meta['@odata.type'] !== '#microsoft.graph.fileAttachment') {
    throw new MailboxError('This attachment is not a file and cannot be downloaded here. Open the message in Outlook.', 415);
  }
  if ((meta.size ?? 0) > ATTACHMENT_MAX_BYTES) throw new MailboxError(TOO_LARGE, 413);
  const content = await graphBytes(userId, `${base}/$value`, ATTACHMENT_MAX_BYTES);
  return { name: meta.name || 'attachment', contentType: meta.contentType || 'application/octet-stream', content };
}

// ── Actions on several messages ─────────────────────────────────────────

export const BATCH_MAX = 100;

const GMAIL_LABEL_CHANGE: Partial<Record<EmailBatchAction, { addLabelIds?: string[]; removeLabelIds?: string[] }>> = {
  archive: { removeLabelIds: ['INBOX'] },
  unarchive: { addLabelIds: ['INBOX'] },
  read: { removeLabelIds: ['UNREAD'] },
  unread: { addLabelIds: ['UNREAD'] },
  star: { addLabelIds: ['STARRED'] },
  unstar: { removeLabelIds: ['STARRED'] },
};

const graphAction = (userId: string, id: string, action: EmailBatchAction): Promise<unknown> => {
  const path = `/me/messages/${encodeURIComponent(id)}`;
  switch (action) {
    case 'archive': return graphApi(userId, 'POST', `${path}/move`, { destinationId: 'archive' });
    case 'trash': return graphApi(userId, 'POST', `${path}/move`, { destinationId: 'deleteditems' });
    case 'unarchive':
    case 'untrash': return graphApi(userId, 'POST', `${path}/move`, { destinationId: 'inbox' });
    case 'read': return graphApi(userId, 'PATCH', path, { isRead: true });
    case 'unread': return graphApi(userId, 'PATCH', path, { isRead: false });
    case 'star': return graphApi(userId, 'PATCH', path, { flag: { flagStatus: 'flagged' } });
    case 'unstar': return graphApi(userId, 'PATCH', path, { flag: { flagStatus: 'notFlagged' } });
  }
};

/**
 * Apply one action to several messages. Reports which ids it took and which
 * it did not; nothing is ever deleted for good. On Microsoft 365 a moved
 * message gets a new id: `done` names the ids as they were asked for.
 */
export async function batchAction(userId: string, provider: EmailProvider, ids: string[], action: EmailBatchAction): Promise<EmailBatchResponse> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { done: [], failed: [] };
  if (unique.length > BATCH_MAX) throw new MailboxError(`At most ${BATCH_MAX} messages at once.`);
  try {
    if (provider === 'google') {
      const change = GMAIL_LABEL_CHANGE[action];
      if (change) {
        // One call for all of them, and all or nothing.
        try {
          await gmailApi(userId, 'POST', '/messages/batchModify', { ids: unique, ...change });
          return { done: unique, failed: [] };
        } catch {
          return { done: [], failed: unique };
        }
      }
    }
    const results = await mapLimit(unique, 5, (id) => (provider === 'google'
      ? gmailApi(userId, 'POST', `/messages/${encodeURIComponent(id)}/${action === 'trash' ? 'trash' : 'untrash'}`)
      : graphAction(userId, id, action)
    ).then(() => true, () => false));
    return { done: unique.filter((_, i) => results[i]), failed: unique.filter((_, i) => !results[i]) };
  } finally {
    invalidateEmailCache(userId);
  }
}
