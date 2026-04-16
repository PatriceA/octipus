import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'review',
  toolIds: ['filesystem', 'shell', 'git', 'knowledge', 'visual'],
  defaultTopic: 'review',
};
