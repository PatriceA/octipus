import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'review',
  toolIds: ['filesystem', 'shell', 'git', 'github', 'knowledge', 'task_state', 'visual'],
  // Not opted into lazy tool discovery: review's tools are nearly all hot-path
  // (filesystem/shell/git/github read code+diffs every turn, and the prompt
  // mandates search_knowledge as step 1), so only visual/task_state (~1.5k of
  // 27k) could move to the long tail — not worth a discovery round-trip.
  defaultTopic: 'review',
};
