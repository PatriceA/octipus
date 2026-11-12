/**
 * Lazy tool discovery split — partitions a role's flat handler list into the
 * advertised "core" set and the discoverable "long tail". See tool-split.ts.
 */
import { describe, expect, test } from 'vitest';
import type { ToolHandler } from '@/core/agent-base';
import { isLongTailHandler, MCP_META_TOOL_NAMES, orderByGroup, orderForCache, splitRoleTools, toolCacheTier } from './tool-split';

const handler = (name: string, toolId?: string): ToolHandler => ({
  name,
  description: `desc ${name}`,
  parameters: { type: 'object', properties: {} },
  toolId,
  execute: async () => null,
});

const HANDLERS: ToolHandler[] = [
  handler('web_search', 'websearch'),
  handler('kb_search', 'knowledge'),
  handler('read_file', 'filesystem'),
  handler('write_file', 'filesystem'),
  handler('save_artifact', 'artifacts'),
  handler('mcp_list_tools', 'mcp'),
  handler('spawn_child'), // no toolId — injected meta-tool
];

describe('splitRoleTools', () => {
  test('undefined coreToolIds → everything is core, long tail empty', () => {
    const { core, longTail } = splitRoleTools(HANDLERS, undefined);
    expect(core).toHaveLength(HANDLERS.length);
    expect(longTail).toHaveLength(0);
  });

  test('does not mutate the input array', () => {
    const before = [...HANDLERS];
    splitRoleTools(HANDLERS, ['websearch']);
    expect(HANDLERS).toEqual(before);
  });

  test('partitions by toolId against the core set', () => {
    const { core, longTail } = splitRoleTools(HANDLERS, ['websearch', 'knowledge']);
    const coreNames = core.map((h) => h.name);
    const tailNames = longTail.map((h) => h.name);

    expect(coreNames).toContain('web_search');
    expect(coreNames).toContain('kb_search');
    // long tail
    expect(tailNames).toEqual(expect.arrayContaining(['read_file', 'write_file', 'save_artifact']));
    // every filesystem handler (shared toolId) lands in the tail together
    expect(tailNames.filter((n) => n === 'read_file' || n === 'write_file')).toHaveLength(2);
  });

  test('mcp handlers always land in core (own discovery surface)', () => {
    const { core, longTail } = splitRoleTools(HANDLERS, ['websearch']);
    expect(core.map((h) => h.name)).toContain('mcp_list_tools');
    expect(longTail.map((h) => h.name)).not.toContain('mcp_list_tools');
  });

  test('ungrouped handlers (no toolId) stay core', () => {
    const { core } = splitRoleTools(HANDLERS, ['websearch']);
    expect(core.map((h) => h.name)).toContain('spawn_child');
  });
});

describe('lazy advertisement shape (mirrors agent-worker :1231 filter)', () => {
  // The worker registers core + longTail + discovery meta-tools, then advertises
  // everything that is NOT long tail. This asserts that composed result.
  test('advertises core + mcp + discovery, hides long tail (still registered)', async () => {
    const { buildToolDiscoveryHandlers } = await import('@/tools/tool-discovery');
    const coreIds = ['websearch', 'knowledge'];
    const { longTail } = splitRoleTools(HANDLERS, coreIds);
    const registered = [...HANDLERS, ...buildToolDiscoveryHandlers(longTail)];

    const advertised = registered
      .filter((h) => !isLongTailHandler(h, coreIds))
      .map((h) => h.name);

    expect(advertised).toEqual(
      expect.arrayContaining(['web_search', 'kb_search', 'mcp_list_tools', 'spawn_child', 'list_tools', 'describe_tool']),
    );
    expect(advertised).not.toContain('read_file');
    expect(advertised).not.toContain('save_artifact');
    // long-tail handlers remain in the registered set (callable by name)
    expect(registered.map((h) => h.name)).toContain('read_file');
  });
});

describe('isLongTailHandler', () => {
  test('true only for a defined, non-mcp, non-core toolId', () => {
    expect(isLongTailHandler(handler('x', 'filesystem'), ['websearch'])).toBe(true);
    expect(isLongTailHandler(handler('x', 'websearch'), ['websearch'])).toBe(false);
    expect(isLongTailHandler(handler('x', 'mcp'), ['websearch'])).toBe(false);
    expect(isLongTailHandler(handler('x', 'tool_discovery'), ['websearch'])).toBe(false);
    expect(isLongTailHandler(handler('x'), ['websearch'])).toBe(false);
  });
});

describe('discoverOnly', () => {
  const hidden = (name: string): ToolHandler => ({
    name, description: `desc ${name}`, parameters: { type: 'object', properties: {} },
    discoverOnly: true, execute: async () => null,
  });

  test('puts a discoverOnly handler in the tail even with no toolId', () => {
    // A meta-tool has no toolId, so without the flag it stays core forever.
    const { core, longTail } = splitRoleTools([handler('spawn_child'), hidden('create_pipeline')], ['filesystem']);
    expect(core.map((t) => t.name)).toEqual(['spawn_child']);
    expect(longTail.map((t) => t.name)).toEqual(['create_pipeline']);
  });

  test('full-schema mode still advertises it — there is nothing to discover with', () => {
    // `discoverOnly` is only safe because a lazy turn ships list_tools. Without
    // lazy mode there is no way back to a hidden tool, so the flag must not be
    // consulted: `splitRoleTools(handlers, undefined)` is the full path, and it
    // returns everything as core.
    const { core, longTail } = splitRoleTools([handler('spawn_child'), hidden('create_pipeline')], undefined);
    expect(core.map((t) => t.name)).toEqual(['spawn_child', 'create_pipeline']);
    expect(longTail).toEqual([]);
  });

  test('keeps it in the tail even when its name is in the core set', () => {
    // The advertisement list must not be able to drag it back into view.
    expect(isLongTailHandler(hidden('create_pipeline'), ['create_pipeline'])).toBe(true);
  });
});

describe('orderByGroup', () => {
  test('ordered groups go first, in that order; everything else follows in its place', () => {
    const names = orderByGroup(HANDLERS, ['filesystem', 'websearch']).map((h) => h.name);
    expect(names).toEqual(['read_file', 'write_file', 'web_search', 'kb_search', 'save_artifact', 'mcp_list_tools', 'spawn_child']);
  });

  test('a group used later follows the earlier groups, which keep their bytes', () => {
    // Before: the conversation has not reached for web search, so it is not advertised.
    const before = orderByGroup(HANDLERS.filter((h) => h.toolId !== 'websearch'), ['filesystem']).map((h) => h.name);
    const after = orderByGroup(HANDLERS, ['filesystem', 'websearch']).map((h) => h.name);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after[2]).toBe('web_search');
  });

  test('a tool outside the groups changing does not move any group tool', () => {
    const withMcp = orderByGroup(HANDLERS, ['filesystem', 'websearch']).map((h) => h.name);
    const withoutMcp = orderByGroup(HANDLERS.filter((h) => h.toolId !== 'mcp'), ['filesystem', 'websearch']).map((h) => h.name);
    expect(withoutMcp.slice(0, 3)).toEqual(withMcp.slice(0, 3));
  });
});

describe('orderForCache', () => {
  const MIXED: ToolHandler[] = [
    handler('web_search', 'websearch'),
    handler('mcp__crm__lookup', 'mcp'),
    handler('read_file', 'filesystem'),
    handler('gmail_search', 'plugin-gmail'),
    handler('ext_quotes__get', 'ext_quotes'),
    handler('kb_search', 'knowledge'),
    handler('inline_ui_ask', 'inline-ui'),
    handler('weather', 'plugin-weather'),
    handler('save_artifact', 'artifacts'),
    handler('spawn_child'),
  ];

  test('shared, then per-user and runtime, then the message-selected groups in first-used order', () => {
    const { tools, sharedCount } = orderForCache(MIXED, { lazy: true, groupOrder: ['filesystem', 'knowledge', 'websearch'] });
    expect(tools.map((h) => h.name)).toEqual([
      'read_file', 'save_artifact', 'spawn_child',
      'mcp__crm__lookup', 'gmail_search', 'ext_quotes__get', 'inline_ui_ask', 'weather',
      'kb_search', 'web_search',
    ]);
    expect(sharedCount).toBe(3);
  });

  test('full advertisement: no sticky tier, the message-selected groups stay shared', () => {
    const { tools, sharedCount } = orderForCache(MIXED, { lazy: false });
    expect(tools.slice(0, sharedCount).map((h) => h.name)).toEqual(['web_search', 'read_file', 'kb_search', 'save_artifact', 'spawn_child']);
  });

  test('only the order changes, never the set', () => {
    const { tools } = orderForCache(MIXED, { lazy: true, groupOrder: ['websearch'] });
    const byName = (a: ToolHandler, b: ToolHandler) => a.name.localeCompare(b.name);
    expect([...tools].sort(byName)).toEqual([...MIXED].sort(byName));
  });

  test('stable: the same input gives the same order, and per-user tools never move a shared one', () => {
    const full = orderForCache(MIXED, { lazy: true });
    expect(orderForCache(MIXED, { lazy: true }).tools).toEqual(full.tools);
    const withoutUser = orderForCache(MIXED.filter((h) => toolCacheTier(h, true) !== 'variable'), { lazy: true });
    expect(withoutUser.sharedCount).toBe(full.sharedCount);
    expect(withoutUser.tools.slice(0, withoutUser.sharedCount)).toEqual(full.tools.slice(0, full.sharedCount));
  });

  test('the floor groups and the discovery tools are shared on the lazy path too', () => {
    expect(toolCacheTier(handler('run', 'shell'), true)).toBe('shared');
    // Offered only while the thread has open taken tasks: never in the shared prefix.
    expect(toolCacheTier({ name: 'complete_taken_task', description: '', parameters: {}, execute: async () => null } as never, true)).toBe('variable');
    expect(toolCacheTier(handler('distill', 'skill-distill'), true)).toBe('shared');
    expect(toolCacheTier(handler('list_tools', 'tool_discovery'), true)).toBe('shared');
  });

  test('the MCP meta-tools are shared; direct and plugin MCP tools are not', () => {
    for (const name of MCP_META_TOOL_NAMES) expect(toolCacheTier(handler(name, 'mcp'), true)).toBe('shared');
    expect(toolCacheTier(handler('mcp__crm__lookup', 'mcp'), true)).toBe('variable');
    expect(toolCacheTier(handler('mcp__plugin_weather__forecast', 'mcp'), false)).toBe('variable');
    // A meta-tool's name under another group is not an MCP meta-tool.
    expect(toolCacheTier(handler('mcp_call_tool', 'plugin-acme'), true)).toBe('variable');
    const { tools, sharedCount } = orderForCache([handler('mcp__crm__lookup', 'mcp'), handler('mcp_list_tools', 'mcp'), handler('read_file', 'filesystem')], { lazy: true });
    expect(tools.map((h) => h.name)).toEqual(['mcp_list_tools', 'read_file', 'mcp__crm__lookup']);
    expect(sharedCount).toBe(2);
  });
});
