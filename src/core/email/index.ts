export {
  archiveMessage,
  draftReply,
  getInbox,
  getMessage,
  sendReply,
  summarizeMessage,
  triageInbox,
} from './service';
export { detectProvider } from './providers';
export { gmailToMessage, m365ToMessage, normalizeGmail, normalizeM365, parseAddress } from './normalize';
export type { EmailAddress, EmailMessage, EmailProvider, EmailTriage, InboxItem } from './types';
