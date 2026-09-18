import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'pm',
  // A project manager reads the backlog and writes to it. `tasks` is the
  // user's to-do list (the backlog it can actually change), `knowledge` holds
  // prior plans / status reports / ADRs, and `github` is where issues and
  // pull requests live when the project is on GitHub.
  toolIds: ['filesystem', 'messaging', 'tasks', 'knowledge', 'github', 'atlassian', 'skill-distill'],
  criticalRules: [
    "Break all work into estimable tasks of 4 hours or less",
    "Identify and document blockers, dependencies, and risks upfront",
    "Include buffer time (15-25%) for unknowns in all estimates",
    "Define clear acceptance criteria for every deliverable",
    "Prioritize tasks using impact vs. effort analysis",
  ],
  defaultTopic: 'pm',
};
