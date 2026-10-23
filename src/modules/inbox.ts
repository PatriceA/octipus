import type { ModuleDefinition } from '../core/modules/types';

export const inboxModule: ModuleDefinition = {
  id: 'inbox',
  title: 'Email inbox (Gmail, Outlook)',
  description: 'The Gmail or Outlook inbox of a connected account: triage, summaries, drafts, tasks from mail, and the heartbeat\'s watch for new mail.',
  profiles: ['company'],
  dependsOn: [],
  routes: ['/api/email'],
  pages: ['/email'],
  tools: ['email-processor'],
  jobs: ['inbox-watch'],
  caseEntities: [],
};
