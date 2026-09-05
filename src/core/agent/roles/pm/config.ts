import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'pm',
  // A project manager reads the backlog and writes to it. `tasks` is the
  // user's to-do list (the backlog it can actually change), `knowledge` holds
  // prior plans / status reports / ADRs, and `github` is where issues and
  // pull requests live when the project is on GitHub.
  toolIds: ['filesystem', 'messaging', 'tasks', 'knowledge', 'github', 'skill-distill'],
  defaultTopic: 'pm',
};
