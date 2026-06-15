import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'review',
  toolIds: ['filesystem', 'shell', 'git', 'github', 'knowledge', 'task_state', 'visual'],
  defaultTopic: 'review',
};
