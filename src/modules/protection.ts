import type { ModuleDefinition } from '@/core/modules/types';

export const protectionModule: ModuleDefinition = {
  id: 'protection',
  title: 'Protection levels',
  description: 'Levels 1-4 on documents, cases, records and mail, saying how sensitive they are. Off, levels are neither shown nor enforced.',
  profiles: ['company'],
  dependsOn: [],
  routes: ['/api/protection'],
  pages: [],
  tools: ['protection'],
  jobs: [],
  caseEntities: [],
  docs: 'docs/PROTECTION-LEVELS.md',
};
