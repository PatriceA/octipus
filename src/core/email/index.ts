export {
  archiveMessage,
  draftReply,
  getInbox,
  getMessage,
  markRead,
  replyOptions,
  sendReply,
  summarizeMessage,
  triageInbox,
} from './service';
export { detectProvider } from './providers';
export { gmailToMessage, m365ToMessage, normalizeGmail, normalizeGmailList, normalizeM365, normalizeM365List, parseAddress } from './normalize';
export type { EmailAddress, EmailMessage, EmailProvider, EmailTriage, InboxItem } from './types';
