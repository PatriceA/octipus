import type { ModuleDefinition } from '@/core/modules/types';

export const researchModule: ModuleDefinition = {
  id: 'research',
  title: 'Research jobs',
  description: 'Deep research run in the background on a question, with a report saved to the documents.',
  profiles: ['product', 'research'],
  dependsOn: [],
  routes: ['/api/research'],
  pages: ['/research'],
  tools: [],
  jobs: [],
  caseEntities: [],
};
