import type { ModuleDefinition } from '../core/modules/types';

export const businessModule: ModuleDefinition = {
  id: 'business',
  title: 'Cases, contacts and records',
  description: 'Matters of business, the people and organisations involved, structured records and public forms.',
  profiles: ['company'],
  dependsOn: [],
  routes: ['/api/cases', '/api/contacts', '/api/record-types', '/api/records', '/api/forms'],
  pages: ['/cases', '/contacts', '/records', '/forms'],
  tools: ['cases', 'records'],
  jobs: [],
  caseEntities: ['contact', 'record'],
  docs: 'docs/CASES.md',
};
