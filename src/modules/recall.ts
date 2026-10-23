import type { ModuleDefinition } from '@/core/modules/types';

export const recallModule: ModuleDefinition = {
  id: 'recall',
  title: 'Recall',
  description: 'Context hooks: relevant knowledge passages and the notes index handed to every agent as it starts, and how well they are used.',
  profiles: ['research'],
  dependsOn: [],
  routes: ['/api/context-hooks'],
  pages: ['/recall'],
  tools: [],
  jobs: ['context-hooks'],
  caseEntities: [],
  docs: 'docs/CONTEXT-HOOKS.md',
};
