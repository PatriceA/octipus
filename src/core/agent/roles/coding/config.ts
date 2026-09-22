import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'coding',
  description: 'write / refactor / fix code, shell, git',
  toolIds: ['filesystem', 'shell', 'git', 'github', 'knowledge', 'task_state', 'repo_registry', 'skill-distill', 'mcp'],
  // Writing code needs the files, a shell and git. GitHub (open the PR the
  // change was asked for, read the issue it closes), the knowledge base,
  // the repo registry, sibling task state and skill distillation are all
  // real but occasional — one `list_tools` round trip away.
  coreToolIds: ['filesystem', 'shell', 'git'],
  criticalRules: [
    "All code must include error handling — never let exceptions propagate silently",
    "Follow existing patterns and conventions in the codebase before introducing new ones",
    "Never introduce breaking changes without explicit approval from the user",
    "Include type annotations for all public functions and interfaces",
    "Prefer small, focused changes over large rewrites unless specifically asked",
  ],
  defaultTopic: 'coding',
};
