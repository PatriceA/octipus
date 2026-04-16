import type { AgentRole } from '../types';

/**
 * Per-role metadata exported from `roles/<name>/config.ts`.
 * The matching `prompt.md` is loaded by the registry and merged in.
 */
export interface RoleMeta {
  role: AgentRole;
  toolIds: string[];
  defaultTopic: string;
}
