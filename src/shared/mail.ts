/**
 * Mail accounts and messages (docs/MAIL.md): the shapes the API returns and
 * the web pages read. Dependency-free, like the rest of `src/shared`.
 */

/** How messages come in: IMAP (a folder, kept on the server) or POP3 (a drop, e.g. the KIM client module). */
export const MAIL_PROTOCOLS = ['imap', 'pop3'] as const;
export type MailProtocol = (typeof MAIL_PROTOCOLS)[number];

/** How a connection is protected. `none` is for hosts on the local network only. */
export const MAIL_SECURITY = ['tls', 'starttls', 'none'] as const;
export type MailSecurity = (typeof MAIL_SECURITY)[number];

/** Where a message stands: received, a local draft, being sent, sent, or a send that failed. */
export const MAIL_STATUSES = ['received', 'draft', 'sending', 'sent', 'failed'] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];

export interface MailAddress {
  name?: string;
  address: string;
}

/** One side of an account's connection (incoming or outgoing). The password is in the vault. */
export interface MailServer {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
}

export interface MailAccountView {
  id: string;
  /** Null for a personal mailbox; the space for a functional (shared) one. */
  workspaceId: string | null;
  label: string;
  address: string;
  displayName: string | null;
  protocol: MailProtocol;
  incoming: MailServer;
  /** Null: the account only receives. */
  outgoing: MailServer | null;
  /** The IMAP folder synced (POP3 has none). */
  folder: string;
  enabled: boolean;
  /** Attachments of received mail are filed into the documents. */
  fileAttachments: boolean;
  /** The protection level received mail (and its filed attachments) start at; null: unclear (4). */
  defaultProtectionLevel: number | null;
  /** Whether a password is stored for incoming / outgoing. Never the password itself. */
  passwordSet: { incoming: boolean; outgoing: boolean };
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface MailAttachmentView {
  index: number;
  filename: string;
  contentType: string;
  size: number;
}

/** A message in a list: no body. */
export interface MailMessageSummary {
  id: string;
  accountId: string;
  status: MailStatus;
  from: MailAddress | null;
  to: MailAddress[];
  subject: string;
  snippet: string;
  /** Received, sent, or last changed (a draft). ISO. */
  date: string;
  unread: boolean;
  hasAttachments: boolean;
  /** 1-4 (docs/PROTECTION-LEVELS.md); null: unclear (4). */
  protectionLevel: number | null;
}

export interface MailMessageView extends MailMessageSummary {
  cc: MailAddress[];
  messageIdHeader: string | null;
  inReplyTo: string | null;
  /** Plain text: always present. */
  text: string;
  /** Sanitized HTML, safe to render, when the message had HTML. */
  html: string | null;
  attachments: MailAttachmentView[];
  /** The raw message is kept (attachments can be downloaded). */
  rawKept: boolean;
  /** Why the last send failed. */
  error: string | null;
}
