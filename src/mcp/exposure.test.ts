/**
 * MCP exposure modes in the bridge: what the model is offered for each mode,
 * and that `hidden` is refused at the one dispatch point every path shares.
 * See src/shared/mcp-exposure.ts.
 */
import { describe, expect, test, vi } from 'vitest';
import type { AgentContext, MCPServer } from '@/core/types';
import { MCPBridge } from './bridge';
import { mcpToolKey, mcpToolNames } from './exposure';

const ctx = (codemode?: boolean): AgentContext => ({
  space: null, trigger: 'user', funding: 'own',
  id: 'test', sessionId: 'test', userId: 'test', topic: 'test',
  model: 'test', role: 'general', status: 'running',
  createdAt: new Date(), updatedAt: new Date(), metadata: {}, codemode,
});

const tool = (name: string) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } });

function bridgeWith(server: Partial<MCPServer>, tools = ['search', 'get_issue', 'get_pr', 'delete_repo']) {
  const bridge = new MCPBridge();
  const config = { id: 'gh', name: 'GitHub', command: '', isEnabled: true, ...server } as MCPServer;
  (bridge as unknown as { serverConfigs: MCPServer[] }).serverConfigs = [config];
  (bridge as unknown as { connections: Map<string, unknown> }).connections.set('gh', {
    id: 'gh', server: config, status: 'connected', tools: tools.map(tool), resources: [], prompts: [],
  });
  return bridge;
}

const handler = (bridge: MCPBridge, name: string) => {
  const h = bridge.getLazyToolHandlers().find((x) => x.name === name);
  if (!h) throw new Error(`no handler ${name}`);
  return h;
};

async function listed(bridge: MCPBridge, codemode?: boolean) {
  const result = await handler(bridge, 'mcp_list_tools').execute({}, ctx(codemode)) as Array<{ tools: Array<{ name: string }>; codemode_only_tools?: number }>;
  return { names: result.flatMap((s) => s.tools.map((t) => t.name)), codemodeOnly: result[0]?.codemode_only_tools };
}

describe('mcpToolNames', () => {
  const names = (refs: Array<[string, string]>) => {
    const out = mcpToolNames(refs.map(([serverId, toolName]) => ({ serverId, toolName })));
    return (serverId: string, toolName: string) => out.get(mcpToolKey({ serverId, toolName })) as string;
  };

  test('mcp__<server>__<tool> with characters outside [A-Za-z0-9_] replaced', () => {
    expect(names([['dev-radius', 'search.v2']])('dev-radius', 'search.v2')).toBe('mcp__dev_radius__search_v2');
  });

  test('tools that collide after sanitising each get a distinct hashed name', () => {
    const name = names([['s', 'a-b'], ['s', 'a.b'], ['s', 'c']]);
    expect(name('s', 'a-b')).not.toBe(name('s', 'a.b'));
    expect(name('s', 'a-b')).toMatch(/^mcp__s__a_b_[0-9a-f]{8}$/);
    expect(name('s', 'c')).toBe('mcp__s__c');
  });

  test('two servers whose ids sanitise alike do not share a name', () => {
    const name = names([['my-srv', 'search'], ['my_srv', 'search'], ['my_srv', 'fetch']]);
    expect(name('my-srv', 'search')).not.toBe(name('my_srv', 'search'));
    expect(name('my_srv', 'fetch')).toBe('mcp__my_srv__fetch');
  });

  test('names stay within the 64-character provider limit, stably', () => {
    const long = 'x'.repeat(80);
    const name = names([['server', long]])('server', long);
    expect(name.length).toBe(64);
    expect(names([['server', long]])('server', long)).toBe(name);
  });
});

describe('MCP exposure in the bridge', () => {
  test('default (deferred): no per-tool handlers, every tool listed', async () => {
    const bridge = bridgeWith({});
    expect(bridge.getLazyToolHandlers().some((h) => h.name.startsWith('mcp__'))).toBe(false);
    expect((await listed(bridge, true)).names).toEqual(['delete_repo', 'get_issue', 'get_pr', 'search']);
  });

  test('direct tools become declared handlers that dispatch through callTool with the mcp_call_tool action', async () => {
    const bridge = bridgeWith({ toolExposure: { search: 'direct' } });
    const direct = handler(bridge, 'mcp__gh__search');
    expect(direct.toolId).toBe('mcp');
    expect(typeof direct.permissionAction === 'function' && direct.permissionAction({})).toBe('gh.search');
    expect(direct.parameters).toMatchObject({ type: 'object', properties: { q: { type: 'string' } } });
    const call = vi.spyOn(bridge, 'callTool').mockResolvedValue({ content: [] });
    await direct.execute({ q: 'x' }, ctx());
    expect(call).toHaveBeenCalledWith('gh', 'search', { q: 'x' }, expect.anything(), { server_id: 'gh', tool_name: 'search', arguments: { q: 'x' } });
  });

  test('codemode tools are left out of mcp_list_tools only for a worker running codemode', async () => {
    const bridge = bridgeWith({ exposure: 'codemode', toolExposure: { search: 'deferred' } });
    expect(await listed(bridge, true)).toEqual({ names: ['search'], codemodeOnly: 3 });
    expect((await listed(bridge, false)).names).toEqual(['delete_repo', 'get_issue', 'get_pr', 'search']);
    // An exact schema lookup still answers.
    const exact = await handler(bridge, 'mcp_list_tools').execute({ server_id: 'gh', tool_name: 'get_pr' }, ctx(true)) as Array<{ tools: Array<{ name: string }> }>;
    expect(exact[0].tools.map((t) => t.name)).toEqual(['get_pr']);
  });

  test('hidden tools are never listed and every call path refuses them', async () => {
    const bridge = bridgeWith({ toolExposure: { 'delete_*': 'hidden' } });
    expect((await listed(bridge)).names).not.toContain('delete_repo');
    await expect(bridge.callTool('gh', 'delete_repo', {}, ctx())).rejects.toThrow(/hidden by the server's exposure setting/);
    await expect(handler(bridge, 'mcp_call_tool').execute({ server_id: 'gh', tool_name: 'delete_repo', arguments: {} }, ctx()))
      .rejects.toThrow(/hidden/);
    expect(bridge.getScriptTools().map((t) => t.name)).not.toContain('mcp__gh__delete_repo');
  });

  test('a hidden server offers no resources or prompts, but can still expose selected tools', async () => {
    const bridge = bridgeWith({ exposure: 'hidden', toolExposure: { search: 'direct' } });
    await expect(bridge.readResource('gh', 'file:///x')).rejects.toThrow(/hidden/);
    await expect(bridge.getPrompt('gh', 'p')).rejects.toThrow(/hidden/);
    const resources = await handler(bridge, 'mcp_list_resources').execute({}, ctx()) as { total: number };
    expect(resources.total).toBe(0);
    expect((await listed(bridge)).names).toEqual(['search']);
    expect(bridge.getLazyToolHandlers().map((h) => h.name)).toContain('mcp__gh__search');
  });

  test('script tools: codemode and deferred tools, routed through mcp_call_tool with the real tool name', () => {
    const bridge = bridgeWith({ exposure: 'codemode', toolExposure: { search: 'direct', get_pr: 'deferred', delete_repo: 'hidden' } });
    const scriptTools = bridge.getScriptTools();
    expect(scriptTools.map((t) => t.name)).toEqual(['mcp__gh__get_issue', 'mcp__gh__get_pr']);
    expect(scriptTools[0].via).toBe('mcp_call_tool');
    expect(scriptTools[0].wrap({ q: 'x' })).toEqual({ server_id: 'gh', tool_name: 'get_issue', arguments: { q: 'x' } });
  });

  test('setExposure validates, persists, and reaches the live connection', async () => {
    const bridge = bridgeWith({});
    const save = vi.fn().mockResolvedValue(undefined);
    (bridge as unknown as { saveConfig: unknown }).saveConfig = save;
    await expect(bridge.setExposure('gh', { exposure: 'everywhere' as never })).rejects.toThrow(/exposure must be one of/);
    expect(await bridge.setExposure('nope', { exposure: 'direct' })).toBe(false);
    expect(await bridge.setExposure('gh', { exposure: 'hidden', toolExposure: { search: 'direct' } })).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(bridge.toolExposure('gh', 'search')).toBe('direct');
    expect(bridge.toolExposure('gh', 'get_pr')).toBe('hidden');
    await bridge.setExposure('gh', { toolExposure: {} });
    expect(bridge.toolExposure('gh', 'search')).toBe('hidden');
  });

  test('per-tool changes made concurrently all land, and null removes one', async () => {
    const bridge = bridgeWith({ toolExposure: { 'get_*': 'codemode' } });
    let release!: () => void;
    const firstSave = new Promise<void>((resolve) => { release = resolve; });
    const save = vi.fn().mockImplementationOnce(() => firstSave).mockResolvedValue(undefined);
    (bridge as unknown as { saveConfig: unknown }).saveConfig = save;
    const a = bridge.setToolExposure('gh', 'search', 'direct');
    const b = bridge.setToolExposure('gh', 'delete_repo', 'hidden');
    release();
    await Promise.all([a, b]);
    expect(bridge.getServerConfigs()[0].toolExposure).toEqual({ 'get_*': 'codemode', search: 'direct', delete_repo: 'hidden' });
    await bridge.setToolExposure('gh', 'search', null);
    expect(bridge.getServerConfigs()[0].toolExposure).toEqual({ 'get_*': 'codemode', delete_repo: 'hidden' });
    await expect(bridge.setToolExposure('gh', 'search', 'loud' as never)).rejects.toThrow(/exposure must be one of/);
    expect(await bridge.setToolExposure('nope', 'search', 'direct')).toBe(false);
  });

  test('a failed save rolls the exposure back', async () => {
    const bridge = bridgeWith({ exposure: 'deferred' });
    (bridge as unknown as { saveConfig: unknown }).saveConfig = vi.fn().mockRejectedValue(new Error('disk full'));
    await expect(bridge.setExposure('gh', { exposure: 'hidden' })).rejects.toThrow('disk full');
    expect(bridge.toolExposure('gh', 'search')).toBe('deferred');
  });
});

describe('exposure review fixes', () => {
  test('a tool named after an Object.prototype member is still hidden', async () => {
    const bridge = bridgeWith({ exposure: 'hidden' }, ['constructor', 'toString', 'search']);
    expect(bridge.toolExposure('gh', 'constructor')).toBe('hidden');
    expect(await handler(bridge, 'mcp_list_tools').execute({}, ctx())).toEqual({ message: 'No MCP servers connected.' });
    await expect(bridge.callTool('gh', 'constructor', {}, ctx())).rejects.toThrow(/hidden/);
  });

  test('two direct servers whose ids sanitise alike keep separate handlers', () => {
    const bridge = new MCPBridge();
    const connections = (bridge as unknown as { connections: Map<string, unknown> }).connections;
    for (const id of ['my-srv', 'my_srv']) {
      const server = { id, name: id, command: '', isEnabled: true, exposure: 'direct' } as MCPServer;
      connections.set(id, { id, server, status: 'connected', tools: [tool('search')], resources: [], prompts: [] });
    }
    const direct = bridge.getLazyToolHandlers().filter((h) => h.name.startsWith('mcp__'));
    expect(direct).toHaveLength(2);
    expect(new Set(direct.map((h) => h.name)).size).toBe(2);
    expect(direct.map((h) => typeof h.permissionAction === 'function' && h.permissionAction({})).sort()).toEqual(['my-srv.search', 'my_srv.search']);
  });

  test('a direct tool is authorized in the wrapped shape, so its own `arguments` field is not mistaken for the wrapper', async () => {
    const bridge = bridgeWith({ toolExposure: { search: 'direct' } });
    const call = vi.spyOn(bridge, 'callTool').mockResolvedValue({ content: [] });
    const args = { query: 'secret', arguments: { page: 2 } };
    await handler(bridge, 'mcp__gh__search').execute(args, ctx());
    expect(call).toHaveBeenCalledWith('gh', 'search', args, expect.anything(), { server_id: 'gh', tool_name: 'search', arguments: args });
  });

  test('a server whose tools are all hidden, or that is hidden itself, is not named by mcp_list_tools', async () => {
    const allHidden = bridgeWith({ toolExposure: { '*': 'hidden' } });
    expect(await handler(allHidden, 'mcp_list_tools').execute({}, ctx())).toEqual({ message: 'No MCP servers connected.' });
    const emptyHidden = bridgeWith({ exposure: 'hidden' }, []);
    expect(await handler(emptyHidden, 'mcp_list_tools').execute({}, ctx())).toEqual({ message: 'No MCP servers connected.' });
    // A codemode-only server is still named, with its count, so the model knows to script it.
    const scripted = bridgeWith({ exposure: 'codemode' });
    expect(await listed(scripted, true)).toEqual({ names: [], codemodeOnly: 4 });
  });

  test('script tools get the same normalized object schema as direct handlers', () => {
    const bridge = new MCPBridge();
    const server = { id: 's', name: 'S', command: '', isEnabled: true, exposure: 'codemode' } as MCPServer;
    (bridge as unknown as { connections: Map<string, unknown> }).connections.set('s', {
      id: 's', server, status: 'connected', tools: [{ name: 'bare', description: 'no schema', inputSchema: {} }], resources: [], prompts: [],
    });
    expect(bridge.getScriptTools()[0].parameters).toEqual({ type: 'object', properties: {} });
  });
});
