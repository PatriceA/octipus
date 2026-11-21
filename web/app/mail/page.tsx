'use client';

import { EmailClient } from '@/components/mail/email-client';

/** IMAP / POP3 mailboxes in the same mail window as the Email page; there for installs with the Mail module alone. */
export default function MailPage() {
  return <EmailClient imapOnly />;
}
