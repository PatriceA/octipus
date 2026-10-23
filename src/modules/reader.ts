import type { ModuleDefinition } from '../core/modules/types';

export const readerModule: ModuleDefinition = {
  id: 'reader',
  title: 'Reader',
  description: 'Read a web page or article in a clean view, and turn what it says into notes and tasks.',
  profiles: ['research'],
  dependsOn: [],
  routes: ['/api/reader'],
  pages: ['/reader'],
  tools: [],
  jobs: [],
  caseEntities: [],
};
