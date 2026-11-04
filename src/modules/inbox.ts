import type { ModuleDefinition } from '../core/modules/types';

export const inboxModule: ModuleDefinition = {
  id: 'inbox',
  title: 'Email & calendar (Google, Microsoft 365)',
  description: 'The Gmail or Outlook inbox of a connected account: triage, summaries, drafts, tasks from mail, and the heartbeat\'s watch for new mail.',
  profiles: ['company'],
  dependsOn: [],
  routes: ['/api/email', '/api/calendar'],
  pages: ['/email', '/calendar'],
  tools: ['email-processor'],
  jobs: ['inbox-watch'],
  caseEntities: [],
};
