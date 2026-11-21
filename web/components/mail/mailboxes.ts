/**
 * The mailboxes the Email page shows, behind one shape: a connected Google /
 * Microsoft 365 account (/api/email) or an IMAP / POP3 mailbox (/api/mail).
 * What each kind can do differs, and the page asks here instead of guessing:
 * an IMAP mailbox changes nothing on its server, so it has no archive, trash
 * or stars, and it sends through a saved draft.
 */
import { api } from '@/lib/api';
import type { EmailBatchAction, EmailFolder, EmailListResponse, EmailMessage, EmailProvider, EmailThreadResponse, InboxItem, MailboxKey } from '../../../src/shared/email';
import type { MailAccountView } from '../../../src/shared/mail';
import { providerLabel } from './email-shared';

/** The folders of the page: every provider's, plus an IMAP mailbox's failed sends. */
export type ClientFolder = EmailFolder | 'failed';

const OAUTH_FOLDERS: readonly ClientFolder[] = ['inbox', 'starred', 'sent', 'drafts', 'archive', 'trash'];
const IMAP_FOLDERS: readonly ClientFolder[] = ['inbox', 'sent', 'drafts', 'failed'];

export interface Mailbox {
  key: MailboxKey;
  kind: 'oauth' | 'imap';
  /** For the mailbox picker: "Gmail — me@x.org", "Work — info@x.org". */
  label: string;
  /** For a row badge in "All inboxes". */
  short: string;
  address?: string;
  /** IMAP / POP3: the account. */
  account?: MailAccountView;
  /** May mark mail read / unread and write drafts (in a space: editors). */
  canWrite: boolean;
  /** May send: an IMAP mailbox needs SMTP set up and write access. */
  canSend: boolean;
  folders: readonly ClientFolder[];
  /** Archive, trash and stars exist (Google / Microsoft only). */
  moves: boolean;
}

export function oauthMailbox(provider: EmailProvider, address?: string): Mailbox {
  return {
    key: provider, kind: 'oauth', label: `${providerLabel(provider)}${address ? ` — ${address}` : ''}`, short: providerLabel(provider),
    ...(address ? { address } : {}), canWrite: true, canSend: true, folders: OAUTH_FOLDERS, moves: true,
  };
}

export function imapMailboxOf(account: MailAccountView, canWrite: boolean): Mailbox {
  return {
    key: `imap:${account.id}`, kind: 'imap', label: `${account.label} — ${account.address}`, short: account.label, address: account.address, account,
    canWrite, canSend: canWrite && !!account.outgoing, folders: IMAP_FOLDERS, moves: false,
  };
}

/** The mailbox a listed message lives in. */
export const keyOf = (item: Pick<InboxItem, 'provider' | 'mailbox'>): MailboxKey => item.mailbox ?? (item.provider as EmailProvider);

const accountOf = (box: Mailbox) => box.account!.id;

export interface ListOptions { folder: ClientFolder; q?: string; unread?: boolean; pageToken?: string; fresh?: boolean }

/** One page of a folder of one mailbox. A folder the mailbox does not have is empty. */
export async function listPage(box: Mailbox, opts: ListOptions): Promise<EmailListResponse> {
  if (!box.folders.includes(opts.folder)) return { provider: null, items: [] };
  const params = new URLSearchParams({ folder: opts.folder, limit: '30' });
  if (opts.q) params.set('q', opts.q);
  if (opts.unread) params.set('unread', 'true');
  if (opts.pageToken) params.set('pageToken', opts.pageToken);
  if (box.kind === 'imap') {
    params.set('account', accountOf(box));
    const res = await api.get<EmailListResponse & { error?: string }>(`/mail/client/messages?${params}`);
    if (res.error) throw new Error(res.error);
    return res;
  }
  params.set('provider', box.key);
  // Refresh asks the provider, past the server's short memory of this page.
  if (opts.fresh) params.set('refresh', 'true');
  const res = await api.get<EmailListResponse & { error?: string }>(`/email/messages?${params}`);
  if (res.error) throw new Error(res.error);
  return res;
}

/** The messages of a conversation, oldest first. Without a thread id: the one message. */
export async function loadConversation(box: Mailbox, latest: InboxItem): Promise<EmailMessage[]> {
  if (box.kind === 'imap') {
    const msg = await api.get<EmailMessage & { error?: string }>(`/mail/client/messages/${encodeURIComponent(latest.id)}`);
    if (msg.error) throw new Error(msg.error);
    return [msg];
  }
  if (latest.threadId) {
    const res = await api.get<EmailThreadResponse & { error?: string }>(`/email/thread/${encodeURIComponent(latest.threadId)}?provider=${box.key}`);
    if (res.error) throw new Error(res.error);
    if (res.messages?.length) return res.messages;
  }
  const msg = await api.get<EmailMessage & { error?: string }>(`/email/message/${encodeURIComponent(latest.id)}?provider=${box.key}`);
  if (msg.error) throw new Error(msg.error);
  return [msg];
}

/** Can `box` take `action`? */
export function canDo(box: Mailbox, action: EmailBatchAction): boolean {
  if (action === 'read' || action === 'unread') return box.canWrite;
  return box.moves;
}

/** One action on messages of one mailbox. Returns how many could not be changed. */
export async function changeMessages(box: Mailbox, ids: string[], action: EmailBatchAction): Promise<number> {
  if (!canDo(box, action)) return ids.length;
  const res = box.kind === 'imap'
    ? await api.post<{ failed?: string[]; error?: string }>('/mail/client/messages/batch', { ids, action })
    : await api.post<{ failed?: string[]; error?: string }>('/email/messages/batch', { ids, action, provider: box.key });
  if (res.error) throw new Error(res.error);
  return res.failed?.length ?? 0;
}

/** Fetch new mail now: an IMAP mailbox syncs (editors only); a provider is read past the server's page memory. */
export async function syncMailbox(box: Mailbox): Promise<string | null> {
  if (box.kind !== 'imap' || !box.canWrite) return null;
  const res = await api.post<{ stored?: number; error?: string }>(`/mail/accounts/${encodeURIComponent(accountOf(box))}/sync`, {});
  if (res.error) throw new Error(res.error);
  return res.stored ? `${res.stored} new ${res.stored === 1 ? 'message' : 'messages'} in ${box.short}.` : null;
}

/** Where the AI help for a message of `box` is asked. */
export function aiPath(box: Mailbox, id: string, what: 'summarize' | 'reply-options' | 'draft' | 'task'): string {
  return box.kind === 'imap'
    ? `/email/imap/message/${encodeURIComponent(id)}/${what}`
    : `/email/message/${encodeURIComponent(id)}/${what}?provider=${box.key}`;
}

/** Where the owner's triage label for a message of `box` is saved. */
export function labelPath(box: Mailbox, id: string): string {
  return box.kind === 'imap' ? `/email/imap/triage/label/${encodeURIComponent(id)}` : `/email/triage/label/${encodeURIComponent(id)}?provider=${box.key}`;
}

/** Where an attachment of a message of `box` is downloaded. */
export function attachmentPath(box: Mailbox, messageId: string, attachmentId: string): string {
  return box.kind === 'imap'
    ? `/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    : `/email/message/${encodeURIComponent(messageId)}/attachment/${encodeURIComponent(attachmentId)}?provider=${box.key}`;
}
