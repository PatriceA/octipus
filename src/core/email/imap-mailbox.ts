/**
 * IMAP / POP3 mailboxes (src/core/mail, docs/MAIL.md) in the Email page's
 * shapes, so the same client lists, reads, triages and drafts their mail.
 *
 * Every read goes through the caller's content scope (`contentRepos`): a
 * personal mailbox for its owner, a space's mailbox for the space's members.
 * Nothing here reaches a mailbox the scope does not. Writes (drafts, sends)
 * stay on /api/mail, which checks the roles.
 *
 * Mail of these mailboxes carries a protection level (docs/PROTECTION-LEVELS.md).
 * While the `protection` module is on, mail at level 3-4 (unclear counts as 4)
 * goes only to models that run locally: imapAiRefusal() says when it may not.
 */
import { messageSummary, messageView } from '@/core/mail/accounts';
import { isModuleOn } from '@/core/modules/registry';
import type { ContentRepos } from '@/db/repositories/content';
import type { MailSummaryRow } from '@/db/repositories/mail';
import type { MailAddress, MailMessageSummary, MailMessageView, MailStatus } from '@/shared/mail';
import { type EmailAddress, type EmailListResponse, type EmailMessage, type ImapFolder, type ImapMailboxKey, imapMailbox, type InboxItem } from '@/shared/email';
import { storedTriage } from './triage-labels';
import type { EmailTriage } from './types';

export class ImapMailboxError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 404) { super(message); }
}

const address = (a: MailAddress | null | undefined): EmailAddress => ({ ...(a?.name ? { name: a.name } : {}), email: a?.address ?? '' });

/** A stored message as a list row. Pure. */
export function imapItem(m: MailMessageSummary): InboxItem {
  return {
    id: m.id,
    provider: 'imap',
    mailbox: imapMailbox(m.accountId),
    status: m.status,
    from: address(m.from),
    to: m.to.map(address),
    subject: m.subject,
    snippet: m.snippet,
    receivedAt: m.date,
    unread: m.unread,
    hasAttachments: m.hasAttachments,
  };
}

/** A stored message for the reading pane. Attachments are listed only when they can be downloaded. Pure. */
export function imapMessage(m: MailMessageView): EmailMessage {
  return {
    ...imapItem(m),
    cc: m.cc.map(address),
    body: m.text,
    ...(m.html ? { html: m.html } : {}),
    attachments: m.rawKept ? m.attachments.map((a) => ({ id: String(a.index), name: a.filename, size: a.size, contentType: a.contentType })) : [],
    ...(m.revision ? { revision: m.revision } : {}),
    sendError: m.error,
  };
}

/** The stored status a folder lists. Pure. */
export const IMAP_FOLDER_STATUS: Record<ImapFolder, MailStatus> = { inbox: 'received', sent: 'sent', drafts: 'draft', failed: 'failed' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cursor of the next page: the last row's date and id. Pure. */
export function imapPageToken(last: Pick<InboxItem, 'id' | 'receivedAt'>): string {
  return `${last.receivedAt}~${last.id}`;
}

/** A page token back to its cursor; null for anything else. Pure. */
export function parseImapPageToken(token: string | undefined): { date: Date; id: string } | null {
  if (!token) return null;
  const [iso, id, ...rest] = token.split('~');
  if (rest.length || !id || !UUID.test(id)) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? { date, id } : null;
}

/** An account of the scope, or ImapMailboxError (404) when the scope does not reach it. */
export async function imapAccount(repos: ContentRepos, accountId: string) {
  const account = UUID.test(accountId) ? await repos.mail.account(accountId) : null;
  if (!account) throw new ImapMailboxError('Mail account not found');
  return account;
}

export interface ImapListOptions {
  folder: ImapFolder;
  q?: string;
  unread?: boolean;
  limit: number;
  pageToken?: string;
}

/**
 * One page of a folder of an IMAP / POP3 mailbox, newest first, with the
 * triage `userId` gave its mail (triage is per person, also in a shared
 * mailbox).
 */
export async function listImap(repos: ContentRepos, userId: string, accountId: string, opts: ImapListOptions): Promise<EmailListResponse> {
  await imapAccount(repos, accountId);
  const before = parseImapPageToken(opts.pageToken);
  if (opts.pageToken && !before) throw new ImapMailboxError('Invalid page token', 400);
  const limit = Math.max(1, Math.min(50, opts.limit));
  const rows = await repos.mail.list({
    accountId,
    status: IMAP_FOLDER_STATUS[opts.folder],
    unread: opts.unread === true,
    q: opts.q?.trim() || undefined,
    ...(before ? { before } : {}),
    limit,
  });
  const mailbox = imapMailbox(accountId);
  const triage = opts.folder === 'inbox' && rows.length
    ? await storedTriage(userId, mailbox, rows.map((r) => r.id)).catch((): Record<string, EmailTriage> => ({}))
    : {};
  const items = rows.map((row) => {
    const item = imapItem(messageSummary(row));
    return triage[item.id] ? { ...item, triage: triage[item.id] } : item;
  });
  const first = opts.folder === 'inbox' && !before && !opts.q?.trim();
  return {
    provider: null,
    mailbox,
    items,
    ...(items.length === limit ? { nextPageToken: imapPageToken(items[items.length - 1]) } : {}),
    ...(first ? { unreadCount: await repos.mail.unreadCount(accountId).catch(() => 0) } : {}),
  };
}

/** One message the scope reaches, as the reading pane shows it; null when it does not. */
export async function readImap(repos: ContentRepos, id: string): Promise<{ message: EmailMessage; level: number | null } | null> {
  const row = UUID.test(id) ? await repos.mail.message(id) : null;
  if (!row) return null;
  const raw = row.attachments.length > 0 ? await repos.mail.raw(row.id) : null;
  return { message: imapMessage(messageView(row, raw !== null)), level: row.protectionLevel };
}

export interface ImapTriageItem { item: InboxItem; level: number | null }

/**
 * Received mail of `accountId` among `ids`, read from the store, never from
 * what a client sent: triage sees the mail as it is, and only mail the scope
 * reaches.
 */
export async function imapItemsByIds(repos: ContentRepos, accountId: string, ids: readonly string[]): Promise<ImapTriageItem[]> {
  await imapAccount(repos, accountId);
  const rows: MailSummaryRow[] = await repos.mail.findByIds(ids);
  return rows.filter((r) => r.accountId === accountId && r.status === 'received').map((r) => ({ item: imapItem(messageSummary(r)), level: r.protectionLevel }));
}

/** The newest `limit` received mails of `accountId`. */
export async function newestImap(repos: ContentRepos, accountId: string, limit: number): Promise<ImapTriageItem[]> {
  await imapAccount(repos, accountId);
  const rows = await repos.mail.list({ accountId, status: 'received', limit: Math.max(1, Math.min(200, limit)) });
  return rows.map((r) => ({ item: imapItem(messageSummary(r)), level: r.protectionLevel }));
}

/** Mark received mail read or unread; the scope's write role is checked by the repository. */
export async function markImap(repos: ContentRepos, ids: readonly string[], unread: boolean): Promise<{ done: string[]; failed: string[] }> {
  const done: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    const row = await repos.mail.setUnread(id, unread).catch((err: unknown) => {
      // A role refusal is the caller's, not one message's: let the route answer it.
      if ((err as { name?: string })?.name === 'SpaceError') throw err;
      return null;
    });
    (row ? done : failed).push(id);
  }
  return { done, failed };
}

/** The lowest level whose mail stays on local models while protection is on. */
const LOCAL_ONLY = 3;
/** Unclear counts as 4. Pure. */
export const effectiveLevel = (level: number | null | undefined): number => level ?? 4;

export interface ImapAiDeps {
  protectionOn: () => boolean;
  /** Where the models that would read the mail run: true when every one of them is local. */
  modelsLocal: (userId: string, uses: 'everyday' | 'triage') => Promise<boolean>;
}

const defaultDeps: ImapAiDeps = {
  protectionOn: () => isModuleOn('protection'),
  modelsLocal: async (userId, uses) => {
    const [{ runsLocally }, { everydayRow }] = await Promise.all([import('@/core/protection/routing'), import('./service')]);
    if (!(await runsLocally(await everydayRow(userId).catch(() => null)))) return false;
    if (uses === 'everyday') return true;
    // Triage asks the decision model first, when one is bound.
    const { getModelRegistry } = await import('@/models/model-registry');
    const decision = await getModelRegistry().getModelForTopic('decision').catch(() => null);
    return !decision || runsLocally(decision);
  },
};

/**
 * Why mail at `level` may not go to the models `uses` calls, or null when it
 * may. Protection off, or level 1-2: it may. Level 3-4: only to local models.
 */
export async function imapAiRefusal(userId: string, level: number | null, uses: 'everyday' | 'triage', deps: ImapAiDeps = defaultDeps): Promise<string | null> {
  if (!deps.protectionOn() || effectiveLevel(level) < LOCAL_ONLY) return null;
  if (await deps.modelsLocal(userId, uses)) return null;
  const n = effectiveLevel(level);
  return `This mail is at protection level ${n}${level === null ? ' (not classified)' : ''}, which stays on local models, and ${uses === 'triage' ? 'the triage models are' : 'the everyday model is'} not local. Bind a local model, or lower the mail's level if it is not confidential.`;
}

export const isImapKey = (key: string): key is ImapMailboxKey => key.startsWith('imap:');
