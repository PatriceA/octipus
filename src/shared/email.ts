/**
 * The Google / Microsoft 365 mailbox as the API returns it and the Email page
 * reads it (docs/plans/email-calendar-ux.md). Dependency-free, like the rest
 * of `src/shared`.
 */

export type EmailProvider = 'google' | 'microsoft';

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
  provider: EmailProvider;
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
}

/** GET /api/email/accounts */
export interface EmailAccountsResponse {
  accounts: Array<{ provider: EmailProvider; address?: string }>;
}

/** GET /api/email/messages?folder=&q=&unread=true&pageToken=&limit=&provider= */
export interface EmailListResponse {
  /** Null: no mailbox is connected. */
  provider: EmailProvider | null;
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
