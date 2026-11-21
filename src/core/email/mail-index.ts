/**
 * A local index of Gmail and Outlook headers (docs/MAIL.md, "Local index of
 * Gmail and Outlook headers"). The Email page's lists, its search and the
 * inbox's unread count are answered from here when the index of that mailbox
 * is fresh, instead of asking the provider for every page.
 *
 * Kept: per message its folders and flags, sender and recipients, subject,
 * the provider's own short preview (≤ 300 characters), date, and whether it
 * has attachments. Never a body or an attachment, and nothing of it is logged.
 *
 * Read: mail of the last 90 days. Gmail reads at most the newest 2000
 * messages of that window; Outlook reads each folder's 90 days whole, over as
 * many syncs as that takes, because its change feed (delta) only continues
 * from the end of a full read. Older mail is read live from the provider
 * (the "l." page tokens below), so a folder never seems to end at the window.
 *
 * Kept current by a sync every few minutes for mailboxes opened in the Email
 * page in the last two weeks (Gmail history, Graph delta), and right after
 * the owner changes something. Off with `users.preferences.emailIndex =
 * false`: nothing is synced and the rows are deleted.
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { userRepository } from '@/db/repositories/user-repository';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { emailIndex, emailIndexState, type EmailIndexRow, type EmailIndexStateRow, type IndexedAddress, type IndexFolderState } from '@/db/schema/email-index';
import type { EmailBatchAction, EmailFolder, EmailListResponse, EmailProvider, InboxItem } from '@/shared/email';
import { mapLimit } from '@/utils/concurrency';
import { coreLogger } from '@/utils/logger';
import { inMailbox, selectedAccount } from './account-context';
import { buildGmailBatch, parseGmailBatch } from './gmail-batch';
import type { ListOptions } from './mailbox';
import { type GmailMessage, type GraphMessage, normalizeGmail, normalizeM365, parseAddressList } from './normalize';
import { connectedProviders, gmailApi, gmailBatch, graphApi, graphGetPrefer } from './providers';

/** Mail received in this window is indexed. */
export const INDEX_WINDOW_DAYS = 90;
/** Gmail reads at most this many messages of the window. */
export const GMAIL_BACKFILL_MAX = 2000;
/** Served from the index only when its last sync is this recent. */
export const FRESH_MS = 10 * 60_000;
/** How often an open mailbox is synced. */
export const SYNC_EVERY_MS = 3 * 60_000;
/** A mailbox not opened for this long is no longer synced (its rows stay until it is opened again). */
export const ACTIVE_FOR_MS = 14 * 24 * 60 * 60_000;
/** One mailbox's sync stops after this long; what it read is kept. */
const SYNC_DEADLINE_MS = 2 * 60_000;
/** Mailboxes synced per cron tick, and at once. */
const SWEEP_MAX = 25;
const SWEEP_PARALLEL = 3;
const SNIPPET_MAX = 300;
/** Graph pages read per folder in one sync; a longer read resumes on the next. */
const GRAPH_PAGES_PER_RUN = 40;
const GMAIL_HISTORY_PAGES = 20;
/** The default (and today the only) account of a provider. */
const DEFAULT_ACCOUNT = '';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 200);

// ── Flags ───────────────────────────────────────────────────────────────

export interface IndexFlags { inbox: boolean; sent: boolean; drafts: boolean; archive: boolean; trash: boolean; starred: boolean; unread: boolean }

/**
 * A Gmail message's folders from its labels. Gmail has no archive folder:
 * archived mail is mail in none of the others, and not spam or a chat. Pure.
 */
export function gmailFlags(labelIds: string[] | undefined): IndexFlags {
  const labels = new Set(labelIds ?? []);
  const inbox = labels.has('INBOX');
  const sent = labels.has('SENT');
  const drafts = labels.has('DRAFT');
  const trash = labels.has('TRASH');
  return {
    inbox, sent, drafts, trash,
    archive: !inbox && !sent && !drafts && !trash && !labels.has('SPAM') && !labels.has('CHAT'),
    starred: labels.has('STARRED'),
    unread: labels.has('UNREAD'),
  };
}

/** The Graph well-known folder each indexed folder is read from. */
export const GRAPH_INDEX_FOLDERS = { inbox: 'inbox', sent: 'sentitems', drafts: 'drafts', archive: 'archive', trash: 'deleteditems' } as const;
export type IndexFolder = keyof typeof GRAPH_INDEX_FOLDERS;

/** A Graph message's flags: its folder is the one it was read from. Pure. */
export function graphFlags(msg: Pick<GraphMessage, 'isRead' | 'flag'>, folder: IndexFolder): IndexFlags {
  return {
    inbox: folder === 'inbox', sent: folder === 'sent', drafts: folder === 'drafts', archive: folder === 'archive', trash: folder === 'trash',
    starred: msg.flag?.flagStatus === 'flagged',
    unread: msg.isRead === false,
  };
}

type IndexInsert = typeof emailIndex.$inferInsert;
const addresses = (list: Array<{ name?: string; email: string }> | undefined): IndexedAddress[] =>
  (list ?? []).filter((a) => a.email).slice(0, 50).map((a) => ({ ...(a.name ? { name: a.name.slice(0, 200) } : {}), email: a.email.slice(0, 320) }));

function row(userId: string, provider: EmailProvider, item: InboxItem, flags: IndexFlags, cc: IndexedAddress[]): IndexInsert | null {
  const at = Date.parse(item.receivedAt);
  if (!Number.isFinite(at)) return null;
  return {
    userId, provider, account: DEFAULT_ACCOUNT, messageId: item.id, threadId: item.threadId ?? null, ...flags,
    fromName: item.from.name?.slice(0, 200) ?? null, fromEmail: item.from.email.toLowerCase().slice(0, 320),
    to: addresses(item.to), cc, subject: item.subject.slice(0, 1000), snippet: item.snippet.slice(0, SNIPPET_MAX),
    receivedAt: new Date(at), hasAttachments: item.hasAttachments ?? null, updatedAt: new Date(),
  };
}

/** The index row of a Gmail message read with format=metadata. Pure. */
export function gmailIndexRow(userId: string, msg: GmailMessage): IndexInsert | null {
  const cc = msg.payload?.headers?.find((h) => h.name.toLowerCase() === 'cc')?.value;
  return row(userId, 'google', normalizeGmail(msg), gmailFlags(msg.labelIds), addresses(parseAddressList(cc)));
}

/** The index row of a Graph message read from `folder`. Pure. */
export function graphIndexRow(userId: string, msg: GraphMessage, folder: IndexFolder): IndexInsert | null {
  const cc = (msg.ccRecipients ?? []).map((r) => ({ name: r.emailAddress?.name, email: r.emailAddress?.address ?? '' }));
  return row(userId, 'microsoft', normalizeM365(msg), graphFlags(msg, folder), addresses(cc));
}

// ── Change feeds ────────────────────────────────────────────────────────

interface GmailHistoryRecord {
  messagesAdded?: Array<{ message?: { id?: string } }>;
  messagesDeleted?: Array<{ message?: { id?: string } }>;
  labelsAdded?: Array<{ message?: { id?: string } }>;
  labelsRemoved?: Array<{ message?: { id?: string } }>;
}

/**
 * What a run of Gmail history records changed: messages to read again and
 * messages gone. Records are in order, so a message deleted after it changed
 * is gone, and one added again after a delete is read. Pure.
 */
export function parseGmailHistory(records: GmailHistoryRecord[]): { upsert: Set<string>; remove: Set<string> } {
  const upsert = new Set<string>();
  const remove = new Set<string>();
  for (const record of records) {
    for (const list of [record.messagesAdded, record.labelsAdded, record.labelsRemoved]) {
      for (const change of list ?? []) {
        const id = change.message?.id;
        if (id) { upsert.add(id); remove.delete(id); }
      }
    }
    for (const change of record.messagesDeleted ?? []) {
      const id = change.message?.id;
      if (id) { remove.add(id); upsert.delete(id); }
    }
  }
  return { upsert, remove };
}

type GraphDeltaEntry = GraphMessage & { '@removed'?: { reason?: string } };

/** A Graph delta page as rows to keep and ids gone (moved away or deleted). Pure. */
export function parseGraphDelta(value: GraphDeltaEntry[] | undefined): { messages: GraphMessage[]; removed: string[] } {
  const messages: GraphMessage[] = [];
  const removed: string[] = [];
  for (const entry of value ?? []) {
    if (!entry?.id) continue;
    if (entry['@removed']) removed.push(entry.id);
    else messages.push(entry);
  }
  return { messages, removed };
}

/**
 * The /v1.0-relative path of a Graph next or delta link, only when it really
 * is one of Graph's own: the stored link is never taken as an arbitrary URL.
 * Pure.
 */
export function graphLinkPath(link: unknown): string | null {
  if (typeof link !== 'string') return null;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com' || !url.pathname.startsWith('/v1.0/me/mailFolders/')) return null;
    return `${url.pathname.slice('/v1.0'.length)}${url.search}`;
  } catch {
    return null;
  }
}

// ── Page tokens ─────────────────────────────────────────────────────────

/**
 * Page tokens of index pages start with "i.", tokens of the live pages after
 * the indexed window with "l.". A provider's own token has neither prefix
 * (Gmail's alphabet has no dot; Graph's starts with "s" or "k"), so the three
 * never mix.
 */
export const INDEX_TOKEN = 'i.';
export const LIVE_TOKEN = 'l.';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function unb64(token: string): unknown {
  try { return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { return null; }
}

/** After this row of an index page. Pure. */
export const indexToken = (at: Date, id: string) => `${INDEX_TOKEN}${b64({ a: at.toISOString(), i: id })}`;
export function parseIndexToken(token: string): { at: Date; id: string } | null {
  const v = unb64(token.slice(INDEX_TOKEN.length)) as { a?: unknown; i?: unknown } | null;
  if (!v || typeof v.a !== 'string' || typeof v.i !== 'string' || v.i.length > 1024) return null;
  const at = new Date(v.a);
  return Number.isFinite(+at) ? { at, id: v.i } : null;
}

/** The live pages of mail older than `before`, continuing from the provider's own `token`. Pure. */
export const liveToken = (before: Date, token?: string) => `${LIVE_TOKEN}${b64({ b: before.toISOString(), ...(token ? { t: token } : {}) })}`;
export function parseLiveToken(token: string): { before: Date; token?: string } | null {
  const v = unb64(token.slice(LIVE_TOKEN.length)) as { b?: unknown; t?: unknown } | null;
  if (!v || typeof v.b !== 'string' || (v.t !== undefined && (typeof v.t !== 'string' || v.t.length > 2048))) return null;
  const before = new Date(v.b);
  return Number.isFinite(+before) ? { before, ...(typeof v.t === 'string' ? { token: v.t } : {}) } : null;
}

// ── State ───────────────────────────────────────────────────────────────

/** The owner keeps the index unless they turned it off. */
export async function indexEnabled(userId: string): Promise<boolean> {
  return (await userRepository.findById(userId))?.preferences?.emailIndex !== false;
}

const mailbox = (userId: string, provider: EmailProvider) => and(
  eq(emailIndexState.userId, userId), eq(emailIndexState.provider, provider), eq(emailIndexState.account, DEFAULT_ACCOUNT),
);
const rowsOf = (userId: string, provider: EmailProvider) => and(
  eq(emailIndex.userId, userId), eq(emailIndex.provider, provider), eq(emailIndex.account, DEFAULT_ACCOUNT),
);

async function stateOf(userId: string, provider: EmailProvider): Promise<EmailIndexStateRow | null> {
  const [state] = await getDb().select().from(emailIndexState).where(mailbox(userId, provider)).limit(1);
  return state ?? null;
}

/**
 * Whether a folder can be answered from this mailbox's index: the first read
 * finished, the last sync is recent, and (Outlook) the folders it needs were
 * read to their end. `starred` spans every folder. Pure.
 */
export function isFresh(state: Pick<EmailIndexStateRow, 'provider' | 'backfilledAt' | 'lastSyncAt' | 'folders' | 'coveredFrom'> | null, folder: EmailFolder, now = Date.now()): boolean {
  if (!state?.backfilledAt || !state.lastSyncAt || !state.coveredFrom) return false;
  if (now - state.lastSyncAt.getTime() > FRESH_MS) return false;
  if (state.provider !== 'microsoft') return true;
  const needed: IndexFolder[] = folder === 'starred' ? Object.keys(GRAPH_INDEX_FOLDERS) as IndexFolder[] : [folder as IndexFolder];
  return needed.every((f) => state.folders[f]?.complete === true);
}

/** Note that the owner opened this mailbox; a mailbox new to the index starts its first read now. */
const opened = new Map<string, number>();
async function noteOpened(userId: string, provider: EmailProvider): Promise<void> {
  const key = `${userId}\n${provider}`;
  const last = opened.get(key) ?? 0;
  if (Date.now() - last < 60_000) return;
  if (opened.size > 5000) opened.clear();
  opened.set(key, Date.now());
  const created = await getDb().insert(emailIndexState).values({ userId, provider, account: DEFAULT_ACCOUNT }).onConflictDoUpdate({
    target: [emailIndexState.userId, emailIndexState.provider, emailIndexState.account],
    set: { lastOpenedAt: new Date() },
  }).returning({ backfilledAt: emailIndexState.backfilledAt, lastSyncAt: emailIndexState.lastSyncAt });
  // A first open, or one after an idle stretch: read now instead of at the next tick.
  const state = created[0];
  if (!state?.backfilledAt || !state.lastSyncAt || Date.now() - state.lastSyncAt.getTime() > SYNC_EVERY_MS) runInBackground(userId, provider);
}

// ── Sync ────────────────────────────────────────────────────────────────

const running = new Map<string, Promise<void>>();

function runInBackground(userId: string, provider: EmailProvider): void {
  void syncMailIndex(userId, provider).catch(() => { /* recorded on the state row */ });
}

/**
 * Sync one mailbox's index now: the first read, or the changes since the
 * last sync. Never two at once in this process. Errors are recorded on the
 * state row (without mail content) and back the next try off.
 */
export function syncMailIndex(userId: string, provider: EmailProvider): Promise<void> {
  // The index holds the provider's DEFAULT account only (account ''). A sync
  // started from a request about another account must not read that account
  // into it: it runs outside any account choice, on the default token.
  return inMailbox(null, () => syncDefaultAccount(userId, provider));
}

function syncDefaultAccount(userId: string, provider: EmailProvider): Promise<void> {
  const key = `${userId}\n${provider}`;
  const current = running.get(key);
  if (current) return current;
  const work = (async () => {
    if (!(await indexEnabled(userId))) return;
    const state = await stateOf(userId, provider);
    if (!state) return;
    const deadline = Date.now() + SYNC_DEADLINE_MS;
    try {
      const update = provider === 'google' ? await syncGmail(userId, state, deadline) : await syncGraph(userId, state, deadline);
      await getDb().update(emailIndexState).set({
        ...update, lastSyncAt: new Date(), lastError: null, failures: 0, nextSyncAt: new Date(Date.now() + SYNC_EVERY_MS),
      }).where(eq(emailIndexState.id, state.id));
    } catch (err) {
      const failures = state.failures + 1;
      await getDb().update(emailIndexState).set({
        lastError: errorText(err), failures, nextSyncAt: new Date(Date.now() + Math.min(SYNC_EVERY_MS * 2 ** failures, 60 * 60_000)),
      }).where(eq(emailIndexState.id, state.id));
      coreLogger.warn({ userId, provider, failures, error: errorText(err) }, 'email: index sync failed');
      throw err;
    }
  })().finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

async function upsertRows(rows: IndexInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await getDb().insert(emailIndex).values(chunk).onConflictDoUpdate({
      target: [emailIndex.userId, emailIndex.provider, emailIndex.account, emailIndex.messageId],
      set: {
        threadId: sql`excluded.thread_id`, inbox: sql`excluded.inbox`, sent: sql`excluded.sent`, drafts: sql`excluded.drafts`,
        archive: sql`excluded.archive`, trash: sql`excluded.trash`, starred: sql`excluded.starred`, unread: sql`excluded.unread`,
        fromName: sql`excluded.from_name`, fromEmail: sql`excluded.from_email`, to: sql`excluded."to"`, cc: sql`excluded.cc`,
        subject: sql`excluded.subject`, snippet: sql`excluded.snippet`, receivedAt: sql`excluded.received_at`,
        hasAttachments: sql`excluded.has_attachments`, updatedAt: sql`excluded.updated_at`,
      },
    });
  }
}

async function removeRows(userId: string, provider: EmailProvider, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    await getDb().delete(emailIndex).where(and(rowsOf(userId, provider), inArray(emailIndex.messageId, ids.slice(i, i + 500))));
  }
}

const GMAIL_INDEX_METADATA = 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date';
const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Gmail metadata for ids: found messages, and the ids Gmail says are gone (404). */
async function gmailMetadata(userId: string, ids: string[], deadline: number): Promise<{ found: GmailMessage[]; gone: string[] }> {
  const found: GmailMessage[] = [];
  const gone: string[] = [];
  const valid = ids.filter((id) => GMAIL_ID.test(id));
  for (let i = 0; i < valid.length; i += 50) {
    if (Date.now() > deadline) throw new Error('The index sync ran out of time; it continues on the next sync.');
    const chunk = valid.slice(i, i + 50);
    const got = new Map<string, GmailMessage>();
    try {
      const boundary = `batch_${randomBytes(12).toString('hex')}`;
      const answer = await gmailBatch(userId, buildGmailBatch(chunk.map((id) => `/gmail/v1/users/me/messages/${id}?${GMAIL_INDEX_METADATA}`), boundary), boundary);
      for (const [index, result] of parseGmailBatch(answer.contentType, answer.text)) {
        const body = result.body as GmailMessage | null;
        if (result.status === 200 && body && body.id === chunk[index]) got.set(body.id, body);
        else if (result.status === 404 && chunk[index]) gone.push(chunk[index]);
      }
    } catch {
      // The batch endpoint failed: read them one by one below.
    }
    await mapLimit(chunk.filter((id) => !got.has(id) && !gone.includes(id)), 5, async (id) => {
      try {
        got.set(id, (await gmailApi(userId, 'GET', `/messages/${encodeURIComponent(id)}?${GMAIL_INDEX_METADATA}`)) as GmailMessage);
      } catch (err) {
        if (/HTTP 404\b/.test(errorText(err))) gone.push(id);
        // Anything else: left as it is, read again on a later change or resync.
      }
    });
    found.push(...got.values());
  }
  return { found, gone };
}

async function gmailInboxUnread(userId: string): Promise<number | null> {
  const n = ((await gmailApi(userId, 'GET', '/labels/INBOX').catch(() => null)) as { messagesUnread?: number } | null)?.messagesUnread;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

type StateUpdate = Partial<typeof emailIndexState.$inferInsert>;

/** Gmail: a full read of the window, or the history since the last sync. */
async function syncGmail(userId: string, state: EmailIndexStateRow, deadline: number): Promise<StateUpdate> {
  if (state.backfilledAt && state.historyId) {
    const records: GmailHistoryRecord[] = [];
    let pageToken: string | undefined;
    let historyId = state.historyId;
    try {
      for (let page = 0; page < GMAIL_HISTORY_PAGES; page++) {
        const res = (await gmailApi(userId, 'GET', `/history?startHistoryId=${encodeURIComponent(state.historyId)}&maxResults=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`)) as
          { history?: GmailHistoryRecord[]; historyId?: string; nextPageToken?: string };
        records.push(...(res.history ?? []));
        if (res.historyId) historyId = res.historyId;
        pageToken = res.nextPageToken;
        if (!pageToken) break;
      }
    } catch (err) {
      // History older than Gmail keeps (about a week): read the window again.
      if (/HTTP 404\b/.test(errorText(err))) return gmailBackfill(userId, deadline);
      throw err;
    }
    // More history than one sync reads: start over rather than lose changes.
    if (pageToken) return gmailBackfill(userId, deadline);
    const { upsert, remove } = parseGmailHistory(records);
    const { found, gone } = await gmailMetadata(userId, [...upsert], deadline);
    await upsertRows(found.map((msg) => gmailIndexRow(userId, msg)).filter((r): r is IndexInsert => r !== null));
    await removeRows(userId, 'google', [...remove, ...gone]);
    return { historyId, inboxUnread: await gmailInboxUnread(userId) };
  }
  return gmailBackfill(userId, deadline);
}

async function gmailBackfill(userId: string, deadline: number): Promise<StateUpdate> {
  // The history id first: what changes while the window is read is caught by the next sync.
  const profile = (await gmailApi(userId, 'GET', '/profile')) as { historyId?: string };
  if (!profile.historyId) throw new Error('Gmail did not say where its history stands.');
  const ids: string[] = [];
  let pageToken: string | undefined;
  let capped = false;
  do {
    const res = (await gmailApi(userId, 'GET', `/messages?maxResults=500&includeSpamTrash=true&q=${encodeURIComponent(`newer_than:${INDEX_WINDOW_DAYS}d -in:spam -in:chats`)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`)) as
      { messages?: Array<{ id: string }>; nextPageToken?: string };
    for (const m of res.messages ?? []) if (ids.length < GMAIL_BACKFILL_MAX) ids.push(m.id);
    pageToken = res.nextPageToken;
    if (ids.length >= GMAIL_BACKFILL_MAX && pageToken) { capped = true; break; }
  } while (pageToken);
  const { found } = await gmailMetadata(userId, ids, deadline);
  const rows = found.map((msg) => gmailIndexRow(userId, msg)).filter((r): r is IndexInsert => r !== null);
  // A fresh read replaces what the index held.
  await getDb().delete(emailIndex).where(rowsOf(userId, 'google'));
  await upsertRows(rows);
  const windowStart = new Date(Date.now() - INDEX_WINDOW_DAYS * 24 * 60 * 60_000);
  // With the cap hit, the index holds the newest 2000: it covers from the oldest of them.
  const oldest = rows.reduce<Date | null>((min, r) => (!min || (r.receivedAt as Date) < min ? r.receivedAt as Date : min), null);
  return { historyId: profile.historyId, backfilledAt: new Date(), coveredFrom: capped && oldest ? oldest : windowStart, inboxUnread: await gmailInboxUnread(userId) };
}

const GRAPH_INDEX_SELECT = 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments,flag';

/** Outlook: each folder's change feed, from where it stopped. */
async function syncGraph(userId: string, state: EmailIndexStateRow, deadline: number): Promise<StateUpdate> {
  const folders: Record<string, IndexFolderState> = { ...state.folders };
  const coveredFrom = state.coveredFrom ?? new Date(Date.now() - INDEX_WINDOW_DAYS * 24 * 60 * 60_000);
  for (const folder of Object.keys(GRAPH_INDEX_FOLDERS) as IndexFolder[]) {
    const current = folders[folder];
    let path = graphLinkPath(current?.deltaLink)
      ?? `/me/mailFolders/${GRAPH_INDEX_FOLDERS[folder]}/messages/delta?$select=${GRAPH_INDEX_SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${coveredFrom.toISOString()}`)}`;
    let complete = current?.complete === true;
    for (let page = 0; page < GRAPH_PAGES_PER_RUN && Date.now() < deadline; page++) {
      let res: { value?: GraphDeltaEntry[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
      try {
        res = (await graphGetPrefer(userId, path, 'odata.maxpagesize=100')) as typeof res;
      } catch (err) {
        // A folder this account does not have (no archive folder yet) is empty, not an error.
        if (/HTTP 404\b/.test(errorText(err)) && !current?.deltaLink) { folders[folder] = { complete: true }; path = ''; break; }
        // A delta link Graph no longer honours (410): read the folder again.
        if (/HTTP 410\b/.test(errorText(err))) {
          await getDb().delete(emailIndex).where(and(rowsOf(userId, 'microsoft'), eq(emailIndex[folder], true)));
          folders[folder] = { complete: false };
          path = '';
          break;
        }
        throw err;
      }
      const { messages, removed } = parseGraphDelta(res.value);
      await upsertRows(messages.map((msg) => graphIndexRow(userId, msg, folder)).filter((r): r is IndexInsert => r !== null));
      await removeRows(userId, 'microsoft', removed);
      const next = graphLinkPath(res['@odata.nextLink']);
      const delta = graphLinkPath(res['@odata.deltaLink']);
      if (delta) { folders[folder] = { deltaLink: res['@odata.deltaLink'], complete: true }; complete = true; path = ''; break; }
      if (!next) throw new Error('Microsoft 365 ended a change feed without a link to continue.');
      path = next;
      folders[folder] = { deltaLink: res['@odata.nextLink'], complete };
    }
    if (Date.now() >= deadline) break;
  }
  const unread = ((await graphApi(userId, 'GET', '/me/mailFolders/inbox?$select=unreadItemCount').catch(() => null)) as { unreadItemCount?: number } | null)?.unreadItemCount;
  const allRead = (Object.keys(GRAPH_INDEX_FOLDERS) as IndexFolder[]).every((f) => folders[f]?.complete);
  return {
    folders, coveredFrom,
    ...(allRead && !state.backfilledAt ? { backfilledAt: new Date() } : {}),
    ...(typeof unread === 'number' ? { inboxUnread: unread } : {}),
  };
}

/**
 * The cron tick's share: sync the due mailboxes the owner opened lately.
 * Each is claimed on the row first, so two instances never sync one mailbox
 * in the same tick. Returns how many were synced.
 */
export async function syncDueMailIndexes(now = new Date()): Promise<number> {
  const db = getDb();
  const due = await db.select().from(emailIndexState).where(and(
    lte(emailIndexState.nextSyncAt, now), gte(emailIndexState.lastOpenedAt, new Date(now.getTime() - ACTIVE_FOR_MS)),
  )).orderBy(emailIndexState.nextSyncAt).limit(SWEEP_MAX);
  let synced = 0;
  await mapLimit(due, SWEEP_PARALLEL, async (state) => {
    const claim = await db.update(emailIndexState).set({ nextSyncAt: new Date(now.getTime() + SYNC_EVERY_MS) })
      .where(and(eq(emailIndexState.id, state.id), lte(emailIndexState.nextSyncAt, now))).returning({ id: emailIndexState.id });
    if (!claim.length) return;
    const provider = state.provider as EmailProvider;
    if (!(await indexEnabled(state.userId))) { await forgetMailIndex(state.userId); return; }
    // A disconnected account keeps no index.
    if (!(await connectedProviders(state.userId)).includes(provider)) { await forgetMailIndex(state.userId, provider); return; }
    await syncMailIndex(state.userId, provider).then(() => { synced++; }, () => {});
  });
  return synced;
}

/** After the owner changed something: sync soon (debounced), so the index catches what was not updated in place. */
const soon = new Map<string, ReturnType<typeof setTimeout>>();
export function syncMailIndexSoon(userId: string): void {
  const timer = soon.get(userId);
  if (timer) clearTimeout(timer);
  // Outside the request's account choice: a timer inherits it otherwise.
  soon.set(userId, inMailbox(null, () => setTimeout(() => {
    soon.delete(userId);
    void (async () => {
      const states = await getDb().select({ provider: emailIndexState.provider }).from(emailIndexState).where(eq(emailIndexState.userId, userId));
      for (const s of states) await syncMailIndex(userId, s.provider as EmailProvider).catch(() => {});
    })().catch(() => {});
  }, 4000)));
}

// ── Serving ─────────────────────────────────────────────────────────────

const FOLDER_COLUMN: Record<EmailFolder, AnyPgColumn> = {
  inbox: emailIndex.inbox, sent: emailIndex.sent, drafts: emailIndex.drafts, archive: emailIndex.archive, trash: emailIndex.trash, starred: emailIndex.starred,
};

/** Search words the index can answer; a provider operator ("from:x", "has:attachment") goes to the provider. Pure. */
export function indexSearchTerms(q: string | undefined): string[] | null {
  const clean = (q ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return [];
  if (/[:"()]/.test(clean) || /\b(OR|AND|NOT)\b/.test(clean)) return null;
  return clean.split(' ').filter(Boolean).slice(0, 8);
}

const escapeLike = (term: string) => term.replace(/[\\%_]/g, (c) => `\\${c}`);

/** An index row as a list row. Pure. */
export function indexItem(r: EmailIndexRow): InboxItem {
  return {
    id: r.messageId, ...(r.threadId ? { threadId: r.threadId } : {}), provider: r.provider as EmailProvider,
    from: { ...(r.fromName ? { name: r.fromName } : {}), email: r.fromEmail },
    ...(r.to.length ? { to: r.to } : {}),
    subject: r.subject, snippet: r.snippet, receivedAt: r.receivedAt.toISOString(), unread: r.unread, starred: r.starred,
    ...(r.hasAttachments === null ? {} : { hasAttachments: r.hasAttachments }),
  };
}

/** One page from the index; null when this request is better answered live. */
async function indexPage(userId: string, provider: EmailProvider, state: EmailIndexStateRow, opts: ListOptions, after: { at: Date; id: string } | null): Promise<EmailListResponse | null> {
  const terms = indexSearchTerms(opts.q);
  if (terms === null || !state.coveredFrom) return null;
  const conditions = [rowsOf(userId, provider), eq(FOLDER_COLUMN[opts.folder], true), gte(emailIndex.receivedAt, state.coveredFrom)];
  // Starred mail in the trash is trash.
  if (opts.folder === 'starred') conditions.push(eq(emailIndex.trash, false));
  if (opts.unread) conditions.push(eq(emailIndex.unread, true));
  for (const term of terms) {
    const like = `%${escapeLike(term)}%`;
    conditions.push(or(ilike(emailIndex.subject, like), ilike(emailIndex.fromEmail, like), ilike(emailIndex.fromName, like), ilike(emailIndex.snippet, like))!);
  }
  if (after) conditions.push(or(lt(emailIndex.receivedAt, after.at), and(eq(emailIndex.receivedAt, after.at), lt(emailIndex.messageId, after.id)))!);
  const rows = await getDb().select().from(emailIndex).where(and(...conditions))
    .orderBy(desc(emailIndex.receivedAt), desc(emailIndex.messageId)).limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1);
  // Past the last indexed row the folder goes on live, with mail older than the window.
  const nextPageToken = rows.length > opts.limit && last ? indexToken(last.receivedAt, last.messageId) : liveToken(state.coveredFrom);
  const wantsCount = opts.folder === 'inbox' && !after && terms.length === 0;
  return {
    provider, items: page.map(indexItem), nextPageToken,
    ...(wantsCount && typeof state.inboxUnread === 'number' ? { unreadCount: state.inboxUnread } : {}),
  };
}

/**
 * A folder page, from the index when it can answer, else from the provider
 * (`live`). Page tokens say which: "i." continues an index page, "l."
 * continues live with mail older than the window, anything else is the
 * provider's own. `fresh` (the page's Refresh) syncs first.
 */
export async function listWithIndex(
  userId: string, provider: EmailProvider, opts: ListOptions, fresh: boolean,
  live: (opts: ListOptions & { before?: Date }) => Promise<EmailListResponse>,
): Promise<EmailListResponse> {
  // Another account than the default: its mail is not indexed, so it is read live, whole.
  if (selectedAccount(provider)) return live(opts);
  const token = opts.pageToken;
  if (token?.startsWith(LIVE_TOKEN)) {
    const parsed = parseLiveToken(token);
    if (!parsed) {
      const { MailboxError } = await import('./mailbox');
      throw new MailboxError('Invalid page token.');
    }
    const page = await live({ ...opts, pageToken: parsed.token, before: parsed.before });
    return { ...page, nextPageToken: page.nextPageToken ? liveToken(parsed.before, page.nextPageToken) : undefined };
  }
  const enabled = await indexEnabled(userId).catch(() => false);
  if (enabled) {
    try {
      await noteOpened(userId, provider);
      if (fresh) await withTimeout(syncMailIndex(userId, provider), 8000).catch(() => {});
      const state = await stateOf(userId, provider);
      const after = token?.startsWith(INDEX_TOKEN) ? parseIndexToken(token) : null;
      // An index page already begun is continued even if the index went stale since.
      if (state && (after || (!token && isFresh(state, opts.folder)))) {
        const page = await indexPage(userId, provider, state, opts, after);
        if (page) return page;
      }
    } catch (err) {
      coreLogger.warn({ userId, provider, error: errorText(err) }, 'email: index unavailable; reading live');
    }
  }
  // An index token the index can no longer serve starts the folder again, live.
  return live({ ...opts, pageToken: token?.startsWith(INDEX_TOKEN) ? undefined : token });
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

// ── Changes made here ───────────────────────────────────────────────────

/**
 * Reflect an action the owner just took on the index rows, so the next list
 * is right before the next sync. Outlook gives a moved message a new id: its
 * row is dropped, and the sync adds it under the new folder.
 */
export async function applyIndexAction(userId: string, provider: EmailProvider, ids: string[], action: EmailBatchAction): Promise<void> {
  // Ids of another account than the default must not touch the default account's rows.
  if (ids.length === 0 || selectedAccount(provider)) return;
  const db = getDb();
  const where = and(rowsOf(userId, provider), inArray(emailIndex.messageId, ids));
  // The inbox's unread count moves by what this action changes there, until the sync reads the provider's own count.
  const before = await db.select({ inbox: emailIndex.inbox, unread: emailIndex.unread }).from(emailIndex).where(where);
  const count = (test: (r: { inbox: boolean; unread: boolean }) => boolean) => before.filter(test).length;
  const unreadDelta =
    action === 'read' || action === 'archive' || action === 'trash' ? -count((r) => r.inbox && r.unread) :
    action === 'unread' ? count((r) => r.inbox && !r.unread) :
    action === 'unarchive' ? count((r) => !r.inbox && r.unread) : 0;
  const moves = action === 'archive' || action === 'unarchive' || action === 'trash' || action === 'untrash';
  if (moves && provider === 'microsoft') {
    await db.delete(emailIndex).where(where);
  } else {
    const set: Record<string, unknown> =
      action === 'read' ? { unread: false } :
      action === 'unread' ? { unread: true } :
      action === 'star' ? { starred: true } :
      action === 'unstar' ? { starred: false } :
      action === 'archive' ? { inbox: false, archive: sql`NOT (${emailIndex.sent} OR ${emailIndex.drafts} OR ${emailIndex.trash})` } :
      action === 'unarchive' ? { inbox: true, archive: false } :
      action === 'trash' ? { trash: true, inbox: false, archive: false } :
      // Gmail puts an untrashed message back with its labels; the sync reads them.
      { trash: false };
    await db.update(emailIndex).set({ ...set, updatedAt: new Date() }).where(where);
  }
  if (unreadDelta) {
    await db.update(emailIndexState).set({ inboxUnread: sql`GREATEST(0, COALESCE(${emailIndexState.inboxUnread}, 0) + ${unreadDelta})` }).where(mailbox(userId, provider));
  }
  syncMailIndexSoon(userId);
}

// ── The owner's choice ──────────────────────────────────────────────────

/** Delete the index of one provider's mailbox, or of all the user's mailboxes. */
export async function forgetMailIndex(userId: string, provider?: string): Promise<void> {
  const db = getDb();
  await db.delete(emailIndex).where(provider ? and(eq(emailIndex.userId, userId), eq(emailIndex.provider, provider)) : eq(emailIndex.userId, userId));
  await db.delete(emailIndexState).where(provider ? and(eq(emailIndexState.userId, userId), eq(emailIndexState.provider, provider)) : eq(emailIndexState.userId, userId));
  for (const key of opened.keys()) if (key.startsWith(`${userId}\n`)) opened.delete(key);
}

export interface MailIndexStatus {
  enabled: boolean;
  mailboxes: Array<{
    provider: EmailProvider;
    /** building: the first read runs; ready: lists come from the index; stale: the last sync is too old (lists read live); error: the last sync failed. */
    status: 'building' | 'ready' | 'stale' | 'error';
    messages: number;
    coveredFrom: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
  }>;
}

export async function mailIndexStatus(userId: string): Promise<MailIndexStatus> {
  const enabled = await indexEnabled(userId);
  if (!enabled) return { enabled, mailboxes: [] };
  const db = getDb();
  const states = await db.select().from(emailIndexState).where(eq(emailIndexState.userId, userId));
  const counts = await db.select({ provider: emailIndex.provider, n: sql<number>`count(*)::int` }).from(emailIndex).where(eq(emailIndex.userId, userId)).groupBy(emailIndex.provider);
  return {
    enabled,
    mailboxes: states.map((s) => ({
      provider: s.provider as EmailProvider,
      status: !s.backfilledAt ? (s.lastError ? 'error' : 'building') : s.lastError ? 'error' : isFresh(s, 'inbox') ? 'ready' : 'stale',
      messages: counts.find((c) => c.provider === s.provider)?.n ?? 0,
      coveredFrom: s.coveredFrom?.toISOString() ?? null,
      lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
      lastError: s.lastError,
    })),
  };
}

/** Turn the index on or off. Off deletes every row at once; on starts reading at the next open of the Email page. */
export async function setMailIndexEnabled(userId: string, enabled: boolean): Promise<MailIndexStatus> {
  const user = await userRepository.findById(userId);
  if (!user) throw new Error('User not found');
  const { emailIndex: _drop, ...rest } = user.preferences ?? {};
  await userRepository.update(userId, { preferences: enabled ? rest : { ...rest, emailIndex: false } });
  if (!enabled) await forgetMailIndex(userId);
  return mailIndexStatus(userId);
}
