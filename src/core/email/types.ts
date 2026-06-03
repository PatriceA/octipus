/** Email triage-lite (feature #7). Provider-agnostic shapes over gmail/m365. */
export type EmailProvider = 'google' | 'microsoft';

export interface EmailAddress {
  name?: string;
  email: string;
}

/** AI triage computed by the email-processor / a classifier. */
export interface EmailTriage {
  priority: 'high' | 'normal' | 'low';
  category?: string;
  reason?: string;
}

/** A normalized inbox row — provider-agnostic. */
export interface InboxItem {
  id: string;
  threadId?: string;
  provider: EmailProvider;
  from: EmailAddress;
  subject: string;
  snippet: string;
  /** ISO timestamp. */
  receivedAt: string;
  unread: boolean;
  triage?: EmailTriage;
}

/** A full message (inbox row + body), for the read pane. */
export interface EmailMessage extends InboxItem {
  to?: EmailAddress[];
  body: string;
}
