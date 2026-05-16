import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'ai',
  toolIds: ['shell', 'filesystem', 'browser', 'browser-ext', 'websearch', 'knowledge', 'task_state', 'mcp'],
  defaultTopic: 'ai',
};
