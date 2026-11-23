/**
 * What a runtime role's id may be. Kept apart from the registry (which loads
 * the role prompts and the tool registry) so the plugin manifest parser can
 * refuse a bad id at install without importing either.
 */
import { canonicalTopic, TOPICS } from '@/models/topics';
import { BUILTIN_ROLES, type BuiltinAgentRole } from './types';

/** A role id: tool-enum value and topic-path segment, so a plain identifier. */
export const ROLE_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;

/**
 * Ids a NEW runtime role may not take, besides the built-ins: names the system
 * uses for something else (message roles, the swarm's depth names, the
 * retired `orchestrator`) and would make a log line, a spawn menu or a
 * transcript lie. Applied to plugin roles and to operator roles created from
 * now on; an operator row stored before this list existed keeps loading.
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

/** Whether `name` names a model lane (or an alias of one). */
export function isLaneName(name: string): boolean {
  const canonical = canonicalTopic(name);
  return TOPICS.some((tp) => tp.value === canonical);
}

/** The rule every runtime role id meets: the charset and length, and not a built-in (no shadowing). */
export function roleIdShapeProblem(id: string): string | null {
  if (!ROLE_ID_RE.test(id)) return `role id '${id}' must be 2-32 chars: lowercase letters, digits, - or _, starting with a letter`;
  if (isBuiltinRole(id)) return `role id '${id}' is a built-in role and cannot be redefined`;
  return null;
}

/**
 * What a NEW id must also avoid: a reserved word, or a lane name (a recipe
 * step whose topic is a lane runs as `general`, see `stageRoleOf`, so a role
 * by that name would change what those steps run as).
 */
export function newRoleIdProblem(id: string): string | null {
  if (RESERVED_ROLE_IDS.has(id)) return `role id '${id}' is reserved`;
  if (isLaneName(id)) return `role id '${id}' is the name of a model lane`;
  return null;
}

/** Why `id` cannot name a new runtime role (a plugin's, or an operator's being created), or null. */
export function roleIdProblem(id: string): string | null {
  return roleIdShapeProblem(id) ?? newRoleIdProblem(id);
}
