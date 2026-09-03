import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'architecture',
  toolIds: ['filesystem', 'shell', 'knowledge', 'task_state', 'websearch', 'repo_registry', 'mcp'],
  defaultTopic: 'architecture',
  // Read-only: the file-mutating filesystem handlers are stripped from this
  // role's surface (see RoleMeta.readOnly). Its deliverable is returned in the
  // reply and handed to `coding` to persist — the prompt's OUTPUT section was
  // rewritten to match, since writing used to BE this role's deliverable.
  // Partial by construction: this role keeps `shell`, so `echo > file` remains
  // possible. Defense-in-depth, not a boundary.
  readOnly: true,
};
