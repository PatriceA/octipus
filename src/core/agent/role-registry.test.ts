/**
 * The role registry (docs/AGENT-ARCHITECTURE.md#runtime-roles): built-ins as
 * they ship, runtime roles registered from data and checked on the way in,
 * and a role that disappears failing by name.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { getToolRegistry } from '@/tools/registry';
import { getRoleConfig, getToolsForRole, ROLE_CONFIGS, SECURITY_PREAMBLE } from './roles';
import {
  clampToRoleLimits, isRegisteredRole, listRegisteredRoles, parseRoleDefinition, pluginRoleIds, registerRuntimeRole,
  RoleDefinitionError, roleSource, runtimeRoleToolCeiling, resolveRole, spawnRefusal, UnknownRoleError, unregisterRuntimeRole,
} from './role-registry';
import { stageContractErrors } from './role-contract';
import { BUILTIN_ROLES, type AgentRole } from './types';
import { buildSpawnRoleCatalog, childRoles, resolveRoleFromTopic } from '@/core/swarm/swarm-tool';

const ADMIN = { kind: 'admin' } as const;
const PLUGIN = { kind: 'plugin', plugin: 'acme' } as const;

/** Stub tool groups, so the registered-tool check has something to check against. */
const STUB_TOOLS = ['notes', 'knowledge', 'websearch', 'plugin_dev', 'mcp_admin', 'unheld_tool'];

function stubTool(id: string) {
  const handlers = [{ name: `${id}__do`, toolId: id, description: id, parameters: { type: 'object', properties: {} }, execute: async () => `${id} ok` }];
  return {
    id, name: id, version: '1.0.0',
    initialize: async () => {}, shutdown: async () => {},
    checkAvailability: async () => ({ available: true }),
    getToolHandlers: () => handlers,
    getTool: (n: string) => handlers.find((h) => h.name === n),
    getManifest: () => ({ id, name: id, version: '1.0.0', description: 'stub', tools: [] }),
  };
}

const def = (over: Record<string, unknown> = {}) => ({
  id: 'translator',
  displayName: 'Translator',
  description: 'translate documents between languages',
  systemPrompt: 'You translate documents faithfully.',
  toolIds: ['notes', 'knowledge'],
  lane: 'everyday',
  ...over,
});

/** Problems a registration is refused with. */
function refused(value: unknown, source: typeof ADMIN | typeof PLUGIN = ADMIN): { problems: string[]; conflict: boolean } {
  try {
    registerRuntimeRole(value, source);
  } catch (err) {
    if (err instanceof RoleDefinitionError) return { problems: err.problems, conflict: err.conflict };
    throw err;
  }
  throw new Error('expected the registration to be refused');
}

beforeAll(async () => {
  for (const id of STUB_TOOLS) await getToolRegistry().register(stubTool(id) as never);
});

afterAll(async () => {
  for (const id of STUB_TOOLS) await getToolRegistry().unregister(id);
});

afterEach(() => {
  for (const { config, source } of listRegisteredRoles()) {
    if (source.kind !== 'builtin') unregisterRuntimeRole(config.role, source);
  }
});

describe('built-in roles', () => {
  test('every built-in with a folder is registered as builtin, with the same config as before', () => {
    for (const id of BUILTIN_ROLES) {
      if (id === 'companion') continue; // the supervisor's scoped toolbox, no folder
      expect(roleSource(id)).toEqual({ kind: 'builtin' });
      expect(resolveRole(id)).toBe(id);
    }
    expect(getRoleConfig('coding').systemPromptTemplate.startsWith(SECURITY_PREAMBLE)).toBe(true);
  });

  test('a built-in id cannot be redefined by any source', () => {
    for (const source of [ADMIN, PLUGIN]) {
      const r = refused(def({ id: 'coding' }), source);
      expect(r.problems).toContain("role id 'coding' is a built-in role and cannot be redefined");
      expect(r.conflict).toBe(true);
    }
    expect(ROLE_CONFIGS.coding.systemPromptTemplate).not.toContain('You translate');
  });
});

describe('registering a runtime role', () => {
  test('registered, resolvable, listed with its source, spawnable and in the delegation menu', () => {
    const config = registerRuntimeRole(def({ coreToolIds: ['notes'], criticalRules: ['never guess'], spawns: ['research'] }), ADMIN);
    expect(config).toMatchObject({ role: 'translator', toolIds: ['notes', 'knowledge'], defaultTopic: 'everyday', coreToolIds: ['notes'], displayName: 'Translator', spawns: ['research'] });
    expect(isRegisteredRole('translator')).toBe(true);
    expect(roleSource('translator')).toEqual(ADMIN);
    expect(childRoles()).toContain('translator');
    expect(resolveRoleFromTopic('translator', 'x')).toBe('translator');
    expect(buildSpawnRoleCatalog()).toContain('- translator — translate documents between languages');
    expect(getRoleConfig(resolveRole('translator')).systemPromptTemplate.endsWith('You translate documents faithfully.')).toBe(true);
    expect(getToolsForRole(resolveRole('translator')).map((h) => h.name).sort()).toEqual(['knowledge__do', 'notes__do']);
  });

  test('the same source replaces its own role; another source cannot take the id', () => {
    registerRuntimeRole(def(), PLUGIN);
    registerRuntimeRole(def({ description: 'second version' }), PLUGIN);
    expect(ROLE_CONFIGS[resolveRole('translator')].description).toBe('second version');
    const r = refused(def(), ADMIN);
    expect(r.problems).toEqual(["role id 'translator' is already registered by the plugin package acme"]);
    expect(r.conflict).toBe(true);
    expect(refused(def(), { kind: 'plugin', plugin: 'other' } as never).conflict).toBe(true);
    expect(pluginRoleIds('acme')).toEqual(['translator']);
  });

  test.each([
    ['too short', 'x'],
    ['upper case', 'Translator'],
    ['a space', 'my role'],
    ['a dot', 'with.dot'],
    ['a leading digit', '1st'],
    ['too long', 'a'.repeat(33)],
  ])('an id with %s is refused', (_label, id) => {
    expect(refused(def({ id })).problems[0]).toMatch(/must be 2-32 chars/);
  });

  test.each(['root', 'system', 'orchestrator', 'admin', 'user', 'assistant', 'agent', 'subagent'])('the reserved id %s is refused', (id) => {
    expect(refused(def({ id })).problems).toContain(`role id '${id}' is reserved`);
  });

  test('a tool nothing registers is refused', () => {
    expect(refused(def({ toolIds: ['notes', 'no-such-tool'] })).problems).toContain('unknown toolIds: no-such-tool');
  });

  test('a tool no built-in role holds is refused: the root\'s delegation ceiling stays where the built-ins put it', () => {
    const ceiling = runtimeRoleToolCeiling();
    expect(ceiling.has('notes')).toBe(true);
    // Registered, but held by no built-in role.
    expect(refused(def({ toolIds: ['notes', 'mcp_admin_x'] })).problems).toContain('unknown toolIds: mcp_admin_x');
    expect(ceiling.has('unheld_tool')).toBe(false);
    expect(refused(def({ toolIds: ['notes', 'unheld_tool'] })).problems)
      .toContain('toolIds no built-in role holds (a runtime role cannot widen what agents can be given): unheld_tool');
    // And registering one does not change the union every role's tools make.
    const before = new Set(Object.values(ROLE_CONFIGS).flatMap((c) => c.toolIds));
    registerRuntimeRole(def(), ADMIN);
    const after = new Set(Object.values(ROLE_CONFIGS).flatMap((c) => c.toolIds));
    expect([...after].sort()).toEqual([...before].sort());
  });

  test('a plugin role may not hold the tools that install or reconfigure host code', () => {
    const r = refused(def({ toolIds: ['notes', 'plugin_dev', 'mcp_admin'] }), PLUGIN);
    expect(r.problems).toContain('toolIds a plugin role may not hold: plugin_dev, mcp_admin');
    // An operator's role may (both are held by the built-in general role).
    expect(registerRuntimeRole(def({ toolIds: ['notes', 'plugin_dev'] }), ADMIN).toolIds).toEqual(['notes', 'plugin_dev']);
  });

  test('a lane that is not a text lane, an empty prompt, a core set outside the tools, bad limits', () => {
    expect(refused(def({ lane: 'embedding' })).problems).toContain("lane must resolve to a text lane (got 'embedding')");
    expect(refused(def({ systemPrompt: '   ' })).problems.join()).toMatch(/systemPrompt/);
    expect(refused(def({ coreToolIds: ['websearch'] })).problems).toContain('coreToolIds must be a subset of toolIds: websearch');
    expect(refused(def({ limits: { maxTokens: 5 } })).problems.join()).toMatch(/limits\.maxTokens/);
    expect(refused(def({ spawns: ['Not A Role'] })).problems.join()).toMatch(/spawns\.0/);
    expect(() => parseRoleDefinition({ ...def(), root: true })).toThrow(RoleDefinitionError);
    expect(isRegisteredRole('translator')).toBe(false);
  });
});

describe('spawn rules and limits', () => {
  test('spawns and spawnedBy narrow who spawns whom; a built-in keeps its menu', () => {
    registerRuntimeRole(def({ id: 'leaf-role', spawns: [] }), ADMIN);
    registerRuntimeRole(def({ id: 'picky', spawns: ['research'] }), ADMIN);
    registerRuntimeRole(def({ id: 'research-only-child', spawnedBy: ['research'] }), ADMIN);

    expect(spawnRefusal('leaf-role', 'coding')).toBe("role 'leaf-role' may not spawn other agents");
    expect(spawnRefusal('picky', 'coding')).toBe("role 'picky' may spawn only research");
    expect(spawnRefusal('picky', 'research')).toBeNull();
    expect(spawnRefusal('general', 'research-only-child')).toBe("role 'research-only-child' may be spawned only by research");
    expect(spawnRefusal('research', 'research-only-child')).toBeNull();
    expect(spawnRefusal('general', 'coding')).toBeNull();

    expect(childRoles('leaf-role')).toEqual([]);
    expect(childRoles('picky')).toEqual(['research']);
    expect(childRoles('general')).not.toContain('research-only-child');
    expect(childRoles('research')).toContain('research-only-child');
  });

  test('limits only ever lower the budget', () => {
    registerRuntimeRole(def({ limits: { maxTokens: 5_000, maxWallClockMs: 60_000 } }), ADMIN);
    expect(clampToRoleLimits('translator', { tokens: 100_000, wallClockMs: 600_000 })).toEqual({ tokens: 5_000, wallClockMs: 60_000 });
    expect(clampToRoleLimits('translator', { tokens: 1_000, wallClockMs: 30_000 })).toEqual({ tokens: 1_000, wallClockMs: 30_000 });
    expect(clampToRoleLimits('coding', { tokens: 100_000, wallClockMs: 600_000 })).toEqual({ tokens: 100_000, wallClockMs: 600_000 });
  });
});

describe('a role that disappears while referenced', () => {
  test('every later lookup fails by name; nothing runs as general', () => {
    registerRuntimeRole(def(), PLUGIN);
    const role = resolveRole('translator');
    expect(stageContractErrors([{ name: 'Translate', role, requiresApproval: false, promptTemplate: 'x', producesArtifacts: false } as never])).toEqual([]);

    expect(unregisterRuntimeRole('translator', ADMIN)).toBe(false); // not its owner
    expect(unregisterRuntimeRole('coding', ADMIN)).toBe(false); // a built-in
    expect(unregisterRuntimeRole('translator', PLUGIN)).toBe(true);

    expect(() => resolveRole('translator')).toThrow(UnknownRoleError);
    expect(() => getRoleConfig(role)).toThrow(/Role 'translator' is not registered/);
    expect(() => getToolsForRole(role)).toThrow(UnknownRoleError);
    expect(spawnRefusal('general', role)).toMatch(/Role 'translator' is not registered/);
    expect(childRoles()).not.toContain(role);
    expect(resolveRoleFromTopic('translator', 'translator')).toBeUndefined();
    expect(stageContractErrors([{ name: 'Translate', role, requiresApproval: false, promptTemplate: 'x' } as never]))
      .toEqual(['stage 1 ("Translate") names role \'translator\', which is not registered (removed, or its plugin package disabled)']);
  });

  test('a text never becomes a role without the registry', () => {
    // @ts-expect-error — a bare string is not an AgentRole; it goes through resolveRole.
    const bad: AgentRole = 'translator';
    expect(isRegisteredRole(bad)).toBe(false);
  });
});
