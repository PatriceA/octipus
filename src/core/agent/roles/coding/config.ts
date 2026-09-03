import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'coding',
  toolIds: ['filesystem', 'shell', 'git', 'knowledge', 'task_state', 'repo_registry', 'skill-distill', 'mcp'],
  // Writing code needs the files, a shell and git. The knowledge base,
  // the repo registry, sibling task state and skill distillation are all
  // real but occasional — one `list_tools` round trip away.
  coreToolIds: ['filesystem', 'shell', 'git'],
  defaultTopic: 'coding',
};
