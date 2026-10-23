import type { ModuleDefinition } from '../core/modules/types';

export const peopleModule: ModuleDefinition = {
  id: 'people',
  title: 'People and profiles',
  description: 'Profiles of the people, pets and organisations in your life, the profiles tool, and the profile context agents get about you and the people you name.',
  profiles: ['company', 'product'],
  dependsOn: [],
  routes: [],
  pages: ['/profiles'],
  tools: ['profiles'],
  jobs: ['profile-context'],
  caseEntities: [],
};
