/** Provider-agnostic mailbox shapes over Gmail and Microsoft 365; shared with the web pages (src/shared/email.ts). */
export type { EmailAddress, EmailAttachment, EmailFolder, EmailMessage, EmailProvider, EmailTriage, ImapMailboxKey, InboxItem, MailboxKey, TriageSource } from '@/shared/email';
export { imapAccountId, imapMailbox, isImapMailbox, isMailboxKey, mailboxOf } from '@/shared/email';
