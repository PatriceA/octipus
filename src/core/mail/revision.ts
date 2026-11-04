import { createHash } from 'node:crypto';
import type { MailMessage } from '@/db/schema/mail';
/** Content receipt for the exact saved draft a person reviewed. */
export function mailDraftRevision(draft: Pick<MailMessage, 'toAddresses' | 'ccAddresses' | 'subject' | 'bodyText' | 'bodyHtml' | 'inReplyTo' | 'references'>): string {
  return createHash('sha256').update(JSON.stringify([draft.toAddresses, draft.ccAddresses, draft.subject, draft.bodyText, draft.bodyHtml, draft.inReplyTo, draft.references])).digest('hex');
}
