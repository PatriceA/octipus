export {
  applyCategoryLabels,
  archiveMessage,
  autoArchive,
  DEFAULT_CATEGORIES,
  getCategories,
  setCategories,
  validateCategories,
  unarchiveMessage,
  draftReply,
  getInbox,
  getMessage,
  markRead,
  replyOptions,
  sendReply,
  summarizeMessage,
  triageInbox,
  triageReview,
  backlogProgress,
  startLabelBacklog,
  BacklogBusyError,
} from './service';
export { setUserLabel, storedTriage } from './triage-labels';
export { detectProvider } from './providers';
export { gmailToMessage, m365ToMessage, normalizeGmail, normalizeGmailList, normalizeM365, normalizeM365List, parseAddress } from './normalize';
export type { EmailAddress, EmailMessage, EmailProvider, EmailTriage, InboxItem } from './types';
export { batchAction, getAttachment, getThread, invalidateEmailCache, listAccounts, listMessages, MailboxError, readMessage, resolveProvider } from './mailbox';
export { EmailInputError } from './send-mime';
export { mailIndexStatus, setMailIndexEnabled, syncMailIndex } from './mail-index';
