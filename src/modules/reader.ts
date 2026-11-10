import type { ModuleDefinition } from '../core/modules/types';

/**
 * Deprecated: the reader is the bundled Reader plugin now (plugins/reader,
 * docs/plans/plugins-everything.md phase 3). This module keeps working where
 * it is on, for this release; no use case switches it on any more, and
 * Settings → Modules points admins to the plugin.
 */
export const readerModule: ModuleDefinition = {
  id: 'reader',
  title: 'Reader',
  description: 'Read a web page or article in a clean view, and turn what it says into notes and tasks.',
  profiles: [],
  dependsOn: [],
  routes: ['/api/reader'],
  pages: ['/reader'],
  tools: [],
  jobs: [],
  caseEntities: [],
  replacedBy: {
    plugin: 'reader',
    note: 'Deprecated: the reader moves to the bundled Reader plugin. Install it under Admin → Plugin packages → Bundled, enable it, then turn this module off.',
  },
};
