/**
 * What a runtime role's id may be. Kept apart from the registry (which loads
 * the role prompts and the tool registry) so the plugin manifest parser can
 * refuse a bad id at install without importing either.
 */
import { BUILTIN_ROLES, type BuiltinAgentRole } from './types';

/** A role id: tool-enum value and topic-path segment, so a plain identifier. */
export const ROLE_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;

/**
 * Ids no runtime role may take, besides the built-ins: names the system uses
 * for something else (message roles, the swarm's depth names, the retired
 * `orchestrator`) and would make a log line, a spawn menu or a transcript lie.
 */
export const RESERVED_ROLE_IDS: ReadonlySet<string> = new Set([
  'root', 'orchestrator', 'system', 'admin', 'administrator', 'operator', 'user', 'assistant',
  'tool', 'agent', 'subagent', 'supervisor', 'plugin', 'mcp', 'octipus', 'default', 'none', 'all', 'any',
]);

const BUILTIN = new Set<string>(BUILTIN_ROLES);

/** Whether `id` is one of the roles that ship with Octipus. */
export function isBuiltinRole(id: string): id is BuiltinAgentRole {
  return BUILTIN.has(id);
}

/** Why `id` cannot name a runtime role, or null. Shadowing a registered runtime role is checked by the registry. */
export function roleIdProblem(id: string): string | null {
  if (!ROLE_ID_RE.test(id)) return `role id '${id}' must be 2-32 chars: lowercase letters, digits, - or _, starting with a letter`;
  if (isBuiltinRole(id)) return `role id '${id}' is a built-in role and cannot be redefined`;
  if (RESERVED_ROLE_IDS.has(id)) return `role id '${id}' is reserved`;
  return null;
}
