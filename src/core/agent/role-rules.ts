/**
 * The rules a runtime role is checked against that need nothing at runtime:
 * what its id may be and which tools a plugin role may never hold.
 *
 * Kept apart from the registry ON PURPOSE. The registry loads the role
 * folders, whose `prompt.md` imports only resolve under the bundler or the
 * test runner's loader; the plugin manifest parser and the offline
 * `octi plugin` CLI (`scripts/plugin.ts`, run by plain `tsx` in CI) need these
 * rules and must not load the role folders. This module imports nothing but
 * the topic list and the role types; `scripts/plugin-cli-imports.test.ts`
 * holds the CLI to that.
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

/**
 * Tools a plugin-contributed role may never hold, whatever a built-in role
 * holds. Two kinds:
 *
 *  - tools that change the host itself: install code (`plugin_dev`), add or
 *    change MCP servers (`mcp_admin`), change how data is guarded
 *    (`protection`);
 *  - tools that make ANOTHER agent act later, under a role the plugin role is
 *    not: a hook or schedule whose `spawn_agent` action runs a root `general`
 *    turn (`scheduling`), a task assigned to a role whose agent picks it up
 *    (`tasks`), a skill that is loaded into other roles' prompts
 *    (`skill-distill`), a monitor whose `continuation` text steers or starts
 *    the session's root turn on delivery (`monitor`), a companion session
 *    started or messaged (`companion`), and the user's own browser, which can
 *    type into the Octipus web chat (`browser-ext`).
 *
 * What it guarantees: an agent of a plugin role cannot, through its own tool
 * calls, reach those tools or start work under a role that holds them. What it
 * does not: it is no boundary for the user's own actions or for other roles,
 * and it narrows only the role's tool list — every call is still authorized as
 * the user the agent works for. A plugin's prompt text is third-party text; it
 * does not get to drive these.
 */
export const PLUGIN_ROLE_DENIED_TOOLS: ReadonlySet<string> = new Set([
  'plugin_dev', 'mcp_admin', 'protection', 'scheduling', 'tasks', 'skill-distill', 'monitor', 'companion', 'browser-ext',
]);
