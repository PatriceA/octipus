/**
 * The role registry: the built-in roles (`roles/<name>/`), plus roles
 * registered at runtime from declarative data — an operator's role row
 * (`POST /api/roles`, persisted in `roles`) or a plugin package's `roles`
 * contribution (docs/PLUGIN-PACKAGES.md#roles).
 *
 * `ROLE_CONFIGS` is the live map every spawn reads synchronously; this module
 * owns every write to it that adds or removes a role, and remembers where each
 * one came from. What a runtime role may be is decided here:
 *
 *  - for every runtime role: the charset and length rule, not a built-in id
 *    (no shadowing or redefinition), not an id another source owns, tools that
 *    are registered, a text lane, limits that only lower the depth defaults —
 *    and nothing in it can make it the root: the root role is `ROOT_ROLE`, a
 *    constant, and a definition has no field that touches it;
 *  - for a PLUGIN role, besides: not a reserved word (`root`, `system`, a lane
 *    name, …); only tools a built-in role already holds, so it never widens the
 *    root's delegation ceiling (the union of every role's tools; a child only
 *    ever gets the intersection with its parent's); and none of
 *    `PLUGIN_ROLE_DENIED_TOOLS`.
 *
 * An operator's role is not held to the last three: an admin can give a
 * built-in role any registered tool anyway, so a ceiling on the admin's own
 * roles bought nothing and stranded rows that worked before. A NEW operator
 * id is refused a reserved word by the roles route (`newRoleIdProblem`),
 * which cannot strand a row that already exists.
 *
 * Execution is unchanged by any of this: a tool call from an agent of any role
 * is authorized against the permissions of the user it runs for.
 */
import { z } from 'zod';
import { canonicalTopic, TOPICS } from '@/models/topics';
import { getToolRegistry } from '@/tools/registry';
import { withoutRetiredToolIds } from './retired-tools';
import { loadRoles } from './roles/index';
import { isBuiltinRole, newRoleIdProblem, ROLE_ID_RE, roleIdShapeProblem } from './role-ids';
import { type AgentRole, BUILTIN_ROLES, type RoleConfig, type RoleLimits } from './types';

export { isBuiltinRole, isLaneName, newRoleIdProblem, RESERVED_ROLE_IDS, ROLE_ID_RE, roleIdProblem } from './role-ids';

/** Where a registered role came from. */
export type RoleSource =
  | { kind: 'builtin' }
  /** A row an operator created through the roles API. */
  | { kind: 'admin' }
  /** The `roles` contribution of an enabled plugin package. */
  | { kind: 'plugin'; plugin: string };

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

/**
 * The most characters a runtime role's prompt may hold. Generous on purpose:
 * operator rows were stored with no cap, and a stored row must keep loading.
 * A plugin's prompt file has its own, tighter cap (8,000 characters).
 */
export const MAX_ROLE_PROMPT_CHARS = 200_000;

const roleRef = z.string().regex(ROLE_ID_RE, 'a role id: lowercase letters, digits, - or _, starting with a letter (2-32)');
const toolRef = z.string().trim().min(1).max(64);

/**
 * A runtime role, as data. Validated by `parseRoleDefinition`; the policy
 * (shadowing, tool ceiling, lane) is `roleDefinitionProblems`.
 */
export const roleDefinitionSchema = z.object({
  id: z.string(),
  displayName: z.string().trim().min(1).max(60).optional(),
  /** The one line the model reads when choosing a role to spawn. */
  description: z.string().trim().min(1).max(2_000).optional(),
  systemPrompt: z.string().trim().min(1, 'systemPrompt must not be empty').max(MAX_ROLE_PROMPT_CHARS),
  toolIds: z.array(toolRef).min(1, 'toolIds: at least one tool').max(200),
  coreToolIds: z.array(toolRef).max(200).optional(),
  /** The model lane (`defaultTopic`). */
  lane: z.string().trim().min(1).max(64),
  spawns: z.array(roleRef).max(32).optional(),
  spawnedBy: z.array(roleRef).max(32).optional(),
  criticalRules: z.array(z.string().trim().min(1).max(4_000)).max(100).optional(),
  readOnly: z.boolean().optional(),
  limits: z.object({
    maxTokens: z.number().int().min(1_000).max(10_000_000).optional(),
    maxWallClockMs: z.number().int().min(10_000).max(24 * 3_600_000).optional(),
  }).strict().optional(),
}).strict();

export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;

/** A definition that cannot be registered, with every reason. */
export class RoleDefinitionError extends Error {
  constructor(readonly problems: string[], readonly conflict = false) {
    super(problems.join('; '));
    this.name = 'RoleDefinitionError';
  }
}

/**
 * A role named by a session, a pipeline stage, a hook or a spawn that is not
 * registered (never was, or its plugin was disabled or uninstalled since).
 * Thrown instead of running the work as some other role.
 */
export class UnknownRoleError extends Error {
  constructor(readonly role: string) {
    super(`Role '${role}' is not registered. It may have been removed, or the plugin package that contributed it disabled or uninstalled; nothing was run as another role in its place.`);
    this.name = 'UnknownRoleError';
  }
}

/** Parse a definition, or throw `RoleDefinitionError` with every problem. */
export function parseRoleDefinition(value: unknown): RoleDefinition {
  const result = roleDefinitionSchema.safeParse(value);
  if (!result.success) {
    throw new RoleDefinitionError(result.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)));
  }
  return result.data;
}

/**
 * A lane a role may run on: the text lanes. `ocr`, `vision`, `embedding` are
 * model classes and `background` runs memory extraction; a role bound to any
 * of them resolves to a model that cannot serve a tool-calling worker.
 */
export function isRoleLane(lane: string): boolean {
  const canonical = canonicalTopic(lane);
  return TOPICS.some((tp) => tp.value === canonical && tp.kind === 'text');
}

// ── The live registry ────────────────────────────────────────────────────

/** Every role a spawn can reach, by id. Read synchronously on the spawn path. */
export const ROLE_CONFIGS: Record<AgentRole, RoleConfig> = loadRoles();
const sources = new Map<string, RoleSource>(Object.keys(ROLE_CONFIGS).map((id) => [id, { kind: 'builtin' }]));

/** Whether `id` names a role registered now. */
export function isRegisteredRole(id: string): id is AgentRole {
  return Object.hasOwn(ROLE_CONFIGS, id);
}

/** `id` as a role, or `UnknownRoleError`. The one way text becomes an `AgentRole`. */
export function resolveRole(id: string): AgentRole {
  if (!isRegisteredRole(id)) throw new UnknownRoleError(id);
  return id;
}

/** Where `id` came from, or null when it is not registered. */
export function roleSource(id: string): RoleSource | null {
  return isRegisteredRole(id) ? sources.get(id) ?? { kind: 'builtin' } : null;
}

/** The registered roles with their source, sorted by id. */
export function listRegisteredRoles(): Array<{ config: RoleConfig; source: RoleSource }> {
  return Object.values(ROLE_CONFIGS)
    .map((config) => ({ config, source: sources.get(config.role) ?? { kind: 'builtin' as const } }))
    .sort((a, b) => a.config.role.localeCompare(b.config.role));
}

/**
 * The tools a runtime role may name: the union of the built-in roles' tools as
 * they stand now (an operator's edit to a built-in included). The root's
 * delegation ceiling is the union over every role, so a runtime role held to
 * this set leaves that ceiling exactly where the built-ins put it.
 */
export function runtimeRoleToolCeiling(): Set<string> {
  const ceiling = new Set<string>();
  for (const id of BUILTIN_ROLES) {
    for (const tool of ROLE_CONFIGS[id]?.toolIds ?? []) ceiling.add(tool);
  }
  return ceiling;
}

export interface RoleCheckOptions {
  /**
   * Check the tool ids against the registered tools. On by default. The boot
   * load of stored rows turns it off: it runs before the tool registry is
   * populated, and those rows were checked when they were written.
   */
  checkRegisteredTools?: boolean;
}

/**
 * Why `def` cannot be registered by `source`, every reason at once. Empty when
 * it can. `conflict` marks the problems that are a clash with what is
 * registered (an id taken) rather than a bad definition.
 */
export function roleDefinitionProblems(
  def: RoleDefinition, source: Exclude<RoleSource, { kind: 'builtin' }>, opts: RoleCheckOptions = {},
): { problems: string[]; conflict: boolean } {
  const problems: string[] = [];
  let conflict = false;
  const plugin = source.kind === 'plugin';
  const idProblem = roleIdShapeProblem(def.id) ?? (plugin ? newRoleIdProblem(def.id) : null);
  if (idProblem) {
    problems.push(idProblem);
    conflict = isBuiltinRole(def.id);
  } else {
    const owner = sources.get(def.id);
    if (owner && !sameSource(owner, source)) {
      problems.push(`role id '${def.id}' is already registered by ${describeSource(owner)}`);
      conflict = true;
    } else if (!owner && source.kind === 'plugin' && unloaded.has(def.id)) {
      // An operator's stored row that did not load still owns its id.
      problems.push(`role id '${def.id}' is already the id of a stored role that did not load; an operator must fix or delete it first`);
      conflict = true;
    }
  }

  const toolIds = withoutRetiredToolIds(def.toolIds);
  if (toolIds.length === 0) problems.push('toolIds: at least one tool that still exists');
  if (opts.checkRegisteredTools !== false) {
    const known = new Set(getToolRegistry().getManifests().map((m) => m.id));
    // Fail closed: before discovery there is nothing to check against, and a
    // plugin's role is never bound before the tools are registered.
    const unknown = toolIds.filter((id) => id !== 'mcp' && !known.has(id));
    if (unknown.length > 0) problems.push(`unknown toolIds: ${unknown.join(', ')}`);
  }
  if (plugin) {
    const ceiling = runtimeRoleToolCeiling();
    const beyond = toolIds.filter((id) => !ceiling.has(id));
    if (beyond.length > 0) problems.push(`toolIds no built-in role holds (a plugin role cannot widen what agents can be given): ${beyond.join(', ')}`);
    // The host renders `criticalRules` as its own mandatory block, outside any
    // fence; a plugin's rules are third-party text and go inside its fenced
    // prompt instead (`fencedRolePrompt`).
    if (def.criticalRules?.length) problems.push('criticalRules: a plugin role\'s rules belong inside its fenced prompt, not in the host\'s critical rules');
    const denied = toolIds.filter((id) => PLUGIN_ROLE_DENIED_TOOLS.has(id));
    if (denied.length > 0) problems.push(`toolIds a plugin role may not hold: ${denied.join(', ')}`);
  }
  const notHeld = (def.coreToolIds ?? []).filter((id) => !toolIds.includes(id));
  if (notHeld.length > 0) problems.push(`coreToolIds must be a subset of toolIds: ${notHeld.join(', ')}`);
  if (!isRoleLane(def.lane)) problems.push(`lane must resolve to a text lane (got '${def.lane}')`);
  return { problems, conflict };
}

/** The `RoleConfig` a checked definition registers as. */
export function roleConfigOf(def: RoleDefinition): RoleConfig {
  const toolIds = withoutRetiredToolIds(def.toolIds);
  const core = (def.coreToolIds ?? []).filter((id) => toolIds.includes(id));
  const limits: RoleLimits | undefined = def.limits && (def.limits.maxTokens || def.limits.maxWallClockMs) ? { ...def.limits } : undefined;
  return {
    role: def.id as AgentRole,
    toolIds,
    defaultTopic: def.lane,
    systemPromptTemplate: def.systemPrompt,
    ...(def.displayName ? { displayName: def.displayName } : {}),
    ...(def.description ? { description: def.description } : {}),
    ...(core.length ? { coreToolIds: core } : {}),
    ...(def.criticalRules?.length ? { criticalRules: def.criticalRules } : {}),
    ...(def.readOnly ? { readOnly: true } : {}),
    ...(def.spawns ? { spawns: [...def.spawns] } : {}),
    ...(def.spawnedBy ? { spawnedBy: [...def.spawnedBy] } : {}),
    ...(limits ? { limits } : {}),
  };
}

/**
 * Register (or replace, for the same source) a runtime role. Throws
 * `RoleDefinitionError` when the definition or the policy refuses it; nothing
 * is registered then.
 */
export function registerRuntimeRole(
  value: unknown, source: Exclude<RoleSource, { kind: 'builtin' }>, opts: RoleCheckOptions = {},
): RoleConfig {
  const def = parseRoleDefinition(value);
  const { problems, conflict } = roleDefinitionProblems(def, source, opts);
  if (problems.length > 0) throw new RoleDefinitionError(problems, conflict);
  const config = roleConfigOf(def);
  ROLE_CONFIGS[config.role] = config;
  sources.set(def.id, source);
  unloaded.delete(def.id);
  return config;
}

/**
 * Remove a runtime role `source` registered. A built-in, or a role another
 * source owns, is left alone (false). Agents already running with it finish
 * with the config they started with; every later lookup of the id fails with
 * `UnknownRoleError`.
 */
export function unregisterRuntimeRole(id: string, source: Exclude<RoleSource, { kind: 'builtin' }>): boolean {
  const owner = sources.get(id);
  if (!owner || owner.kind === 'builtin' || !sameSource(owner, source)) return false;
  delete ROLE_CONFIGS[id as AgentRole];
  sources.delete(id);
  return true;
}

/**
 * Operator rows the boot load could not register, with why: listed by the
 * roles route so they can be repaired or deleted instead of vanishing.
 */
const unloaded = new Map<string, string[]>();

/** Record that a stored operator row could not be registered (or clear it with `null`). */
export function setUnloadedRole(id: string, problems: string[] | null): void {
  if (problems) unloaded.set(id, problems);
  else unloaded.delete(id);
}

/** Why a stored operator row is not registered, or null. */
export function unloadedRoleProblems(id: string): string[] | null {
  return unloaded.get(id) ?? null;
}

/** The runtime roles `plugin` registered now. */
export function pluginRoleIds(plugin: string): string[] {
  return [...sources].filter(([, s]) => s.kind === 'plugin' && s.plugin === plugin).map(([id]) => id).sort();
}

/**
 * Why an agent of `parent` may not spawn `child`, or null when it may. Only a
 * runtime role carries spawn rules; a built-in spawns and is spawned as before.
 */
export function spawnRefusal(parent: string, child: string): string | null {
  const parentCfg = ROLE_CONFIGS[parent as AgentRole];
  const childCfg = ROLE_CONFIGS[child as AgentRole];
  if (!childCfg) return new UnknownRoleError(child).message;
  if (parentCfg?.spawns && !parentCfg.spawns.includes(child)) {
    return parentCfg.spawns.length === 0
      ? `role '${parent}' may not spawn other agents`
      : `role '${parent}' may spawn only ${parentCfg.spawns.join(', ')}`;
  }
  if (childCfg.spawnedBy && !childCfg.spawnedBy.includes(parent)) {
    return `role '${child}' may be spawned only by ${childCfg.spawnedBy.join(', ')}`;
  }
  return null;
}

/** Clamp a budget to `role`'s limits: never above what it was. */
export function clampToRoleLimits(role: string, budget: { tokens: number; wallClockMs?: number }): { tokens: number; wallClockMs?: number } {
  const limits = ROLE_CONFIGS[role as AgentRole]?.limits;
  if (!limits) return budget;
  return {
    tokens: limits.maxTokens ? Math.min(budget.tokens, limits.maxTokens) : budget.tokens,
    ...(budget.wallClockMs !== undefined
      ? { wallClockMs: limits.maxWallClockMs ? Math.min(budget.wallClockMs, limits.maxWallClockMs) : budget.wallClockMs }
      : {}),
  };
}

function sameSource(a: RoleSource, b: RoleSource): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'plugin' || (b.kind === 'plugin' && a.plugin === b.plugin);
}

/** The source in words, for an error message. */
export function describeSource(source: RoleSource): string {
  switch (source.kind) {
    case 'builtin': return 'Octipus (a built-in role)';
    case 'admin': return 'an operator (Topics page)';
    case 'plugin': return `the plugin package ${source.plugin}`;
  }
}
