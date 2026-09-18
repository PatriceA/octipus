import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'writing',
  description: 'docs, README, guides',
  toolIds: ['filesystem', 'browser', 'websearch', 'knowledge', 'task_state', 'messaging', 'documents'],
  criticalRules: [
    "Write for the target audience — adjust terminology and detail level accordingly",
    "Every document must have a clear purpose stated upfront",
    "Include working examples for all technical concepts",
    "Keep sentences concise — aim for one idea per sentence",
    "Use consistent terminology throughout — define terms on first use",
  ],
  defaultTopic: 'writing',
};
