import type { ModuleDefinition } from '../core/modules/types';

export const artifactsModule: ModuleDefinition = {
  id: 'artifacts',
  title: 'Live artifacts',
  description: 'Hosted dashboards, tables, feeds and pages agents build from live data, and saving a chat answer as one.',
  profiles: ['product', 'research'],
  dependsOn: [],
  routes: ['/api/artifacts', '/a', '/__artifacts__', '/octipus-artifact-client.js'],
  pages: ['/artifacts'],
  tools: ['artifacts', 'artifacts_toolbox'],
  jobs: ['artifacts-refresh', 'artifacts-cleanup'],
  caseEntities: ['artifact'],
  docs: 'docs/ARTIFACTS.md',
};
