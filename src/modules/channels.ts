import type { ModuleDefinition } from '../core/modules/types';

export const channelsModule: ModuleDefinition = {
  id: 'channels',
  title: 'Chat channels',
  description: 'Telegram, Slack, Teams and WhatsApp: talk to Octipus from your chats, get its messages there, and group channels.',
  profiles: [],
  dependsOn: [],
  routes: [
    '/api/auth/channel-bindings', '/api/auth/link', '/api/me/group-channels', '/api/channels',
    '/api/admin/group-channels', '/api/admin/notification-destinations',
  ],
  pages: ['/link-account', '/admin/group-channels', '/admin/destinations'],
  tools: ['messaging'],
  jobs: ['channels-listen'],
  caseEntities: [],
  docs: 'docs/CHANNELS.md',
};
