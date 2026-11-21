/**
 * The mailboxes as the API returns them and the Email page reads them
 * (docs/plans/email-calendar-ux.md): a connected Google / Microsoft 365
 * account, or an IMAP / POP3 mailbox (docs/MAIL.md). Dependency-free, like
 * the rest of `src/shared`.
 */

export type EmailProvider = 'google' | 'microsoft';

/** An IMAP / POP3 mailbox (src/core/mail) named as a mailbox: `imap:<account id>`. */
export type ImapMailboxKey = `imap:${string}`;
/** Which mailbox a message lives in: a connected provider, or an IMAP / POP3 mailbox. */
export type MailboxKey = EmailProvider | ImapMailboxKey;

const IMAP_KEY = /^imap:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isImapMailbox = (key: unknown): key is ImapMailboxKey => typeof key === 'string' && IMAP_KEY.test(key);
export const isMailboxKey = (key: unknown): key is MailboxKey => key === 'google' || key === 'microsoft' || isImapMailbox(key);
export const imapMailbox = (accountId: string): ImapMailboxKey => `imap:${accountId}`;
export const imapAccountId = (key: ImapMailboxKey): string => key.slice('imap:'.length);
/** The mailbox a listed message lives in. */
export function mailboxOf(item: Pick<InboxItem, 'provider' | 'mailbox'>): MailboxKey {
  if (item.mailbox) return item.mailbox;
  if (item.provider === 'imap') throw new Error('IMAP mail must name its mailbox');
  return item.provider;
}

/**
 * The folders of an IMAP / POP3 mailbox in the Email page: what Octipus
 * stores for it. Archive, trash and stars do not exist there (nothing on the
 * server is changed); failed sends are a folder of their own.
 */
export const IMAP_FOLDERS = ['inbox', 'sent', 'drafts', 'failed'] as const;
export type ImapFolder = (typeof IMAP_FOLDERS)[number];

export interface EmailAddress {
  name?: string;
  email: string;
}

/** The folders every provider has, under one name each. `archive` is mail that left the inbox but was kept. */
export const EMAIL_FOLDERS = ['inbox', 'starred', 'sent', 'drafts', 'archive', 'trash'] as const;
export type EmailFolder = (typeof EMAIL_FOLDERS)[number];

/** Who gave a triage answer: the owner's own label, the decision model, or the LLM. */
export type TriageSource = 'owner' | 'decision' | 'llm';

export interface EmailTriage {
  priority: 'high' | 'normal' | 'low';
  category?: string;
  /** The LLM's one-line reason; the decision model gives none. */
  reason?: string;
  source?: TriageSource;
}

/** One row of a message list. */
export interface InboxItem {
  id: string;
  /** The conversation this message belongs to (Gmail thread id, Graph conversation id). */
  threadId?: string;
  /** `imap` for IMAP / POP3 mail, whose mailbox is then in `mailbox`. */
  provider: EmailProvider | 'imap';
  /** The account it belongs to, when that is not the provider's default account (Google / Microsoft). */
  account?: string;
  /** The mailbox, for IMAP / POP3 mail (`imap:<account id>`); Google / Microsoft mail is in `provider`. */
  mailbox?: MailboxKey;
  /** IMAP / POP3 only: received, a draft, on its way, sent, or a send that failed. */
  status?: 'received' | 'draft' | 'sending' | 'sent' | 'failed';
  from: EmailAddress;
  /** Recipients, where the list call gives them (always for `sent` and `drafts`). */
  to?: EmailAddress[];
  subject: string;
  snippet: string;
  /** ISO timestamp; '' when the provider gave none. */
  receivedAt: string;
  unread: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
  triage?: EmailTriage;
}

export interface EmailAttachment {
  /** Opaque provider id, used only in the download path. */
  id: string;
  name: string;
  size: number;
  contentType: string;
}

/** A full message, for the read pane. */
export interface EmailMessage extends InboxItem {
  cc?: EmailAddress[];
  /** Plain-text body (always present: AI prompts and the fallback when there is no HTML). */
  body: string;
  /** Sanitized HTML body. Remote images wait in `data-remote-src` (REMOTE_IMAGE_ATTR). */
  html?: string;
  attachments?: EmailAttachment[];
  /** IMAP / POP3 drafts: the saved content's revision, which a send confirmation is bound to. */
  revision?: string;
  /** IMAP / POP3: why the last send of this draft failed. */
  sendError?: string | null;
}

/** GET /api/email/accounts */
export interface EmailAccountsResponse {
  /**
   * Every connected account, Google first, each provider's default account
   * first. A request names a non-default account with `account` (its address)
   * next to `provider`; without it the default account answers.
   */
  accounts: Array<{ provider: EmailProvider; address?: string; isDefault?: boolean }>;
}

/** GET /api/email/messages?folder=&q=&unread=true&pageToken=&limit=&provider= */
export interface EmailListResponse {
  /** Null: no mailbox is connected. */
  provider: EmailProvider | null;
  /** Set when the list is one IMAP / POP3 mailbox (GET /api/mail/client/messages). */
  mailbox?: MailboxKey;
  items: InboxItem[];
  nextPageToken?: string;
  /** Unread mail in the whole folder, on the first page of `inbox` when the provider tells. */
  unreadCount?: number;
}

/** GET /api/email/thread/:threadId?provider= — every message of a conversation, oldest first. */
export interface EmailThreadResponse {
  messages: EmailMessage[];
}

export const EMAIL_BATCH_ACTIONS = ['archive', 'unarchive', 'trash', 'untrash', 'read', 'unread', 'star', 'unstar'] as const;
export type EmailBatchAction = (typeof EMAIL_BATCH_ACTIONS)[number];

/** POST /api/email/messages/batch */
export interface EmailBatchRequest {
  ids: string[];
  action: EmailBatchAction;
  provider?: EmailProvider;
}
export interface EmailBatchResponse {
  done: string[];
  failed: string[];
}

/**
 * POST /api/email/send. `to`, `cc` and `bcc` are comma-separated address
 * lists. With `replyTo` the mail is threaded under that message; `replyAll`
 * is informational (the client already filled the recipients).
 */
export interface EmailSendRequest {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  confirm: true;
  replyTo?: string;
  provider?: EmailProvider;
}
