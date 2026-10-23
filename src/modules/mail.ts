import type { ModuleDefinition } from '../core/modules/types';

export const mailModule: ModuleDefinition = {
  id: 'mail',
  title: 'Mail (IMAP, POP3, SMTP)',
  description: 'Mailboxes connected over IMAP or POP3, drafts, and sending over SMTP with approval: info@, a practice mailbox, the KIM address.',
  profiles: ['company'],
  dependsOn: [],
  routes: ['/api/mail'],
  pages: [],
  tools: ['mail'],
  jobs: ['mail-sync'],
  caseEntities: ['mail'],
  docs: 'docs/MAIL.md',
};
