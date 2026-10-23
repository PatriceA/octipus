import type { ModuleDefinition } from '@/core/modules/types';

export const scanFoldersModule: ModuleDefinition = {
  id: 'scan-folders',
  title: 'Scan folders',
  description: 'Folders on this machine (a scanner or fax drop) whose new files are filed into the documents.',
  profiles: ['company'],
  dependsOn: [],
  routes: ['/api/scan-folders'],
  pages: [],
  tools: [],
  jobs: ['scan-folders'],
  caseEntities: [],
  docs: 'docs/SCAN-FOLDERS.md',
};
