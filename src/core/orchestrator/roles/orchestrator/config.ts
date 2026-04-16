import type { RoleMeta } from '../types';

/**
 * Orchestrator role metadata. The system prompt is co-located in `prompt.md`
 * and loaded by the role registry at startup.
 */
export const meta: RoleMeta = {
  role: 'orchestrator',
  toolIds: ['profiles'],
  defaultTopic: 'general',
};
