import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MCPBridge } from './bridge';
import type { AgentContext } from '@/core/types';

const dummyContext: AgentContext = {
  id: 'test', sessionId: 'test', userId: 'test', topic: 'test',
  model: 'test', role: 'general', status: 'running',
  createdAt: new Date(), updatedAt: new Date(), metadata: {},
};

describe('MCPBridge.getLazyToolHandlers', () => {
  let bridge: MCPBridge;

  beforeEach(() => {
    bridge = new MCPBridge();
  });

  test('returns empty array when no servers connected', () => {
    const handlers = bridge.getLazyToolHandlers();
    expect(handlers).toEqual([]);
  });

  test('returns discovery, dispatch, resource and prompt meta-tools when servers are connected', async () => {
    // Simulate a connected server by reaching into the private connections map
    const connections = (bridge as any).connections as Map<string, any>;
    connections.set('test-server', {
      id: 'test-server',
      server: { id: 'test-server', name: 'Test Server' },
      status: 'connected',
      tools: [
        { name: 'search', description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
        { name: 'fetch', description: 'Fetch a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
      ],
    });

    const handlers = bridge.getLazyToolHandlers();
    expect(handlers).toHaveLength(5);
    expect(handlers.map(h => h.name)).toEqual(expect.arrayContaining(['mcp_list_tools', 'mcp_call_tool', 'mcp_list_resources', 'mcp_read_resource', 'mcp_get_prompt']));
    expect(handlers[0].toolId).toBe('mcp');
    expect(handlers[1].toolId).toBe('mcp');
  });

  test('mcp_list_tools returns all connected servers and tools', async () => {
    const connections = (bridge as any).connections as Map<string, any>;
    connections.set('server-a', {
      id: 'server-a',
      server: { id: 'server-a', name: 'Server A' },
      status: 'connected',
      tools: [
        { name: 'tool1', description: 'Tool 1', inputSchema: { type: 'object' } },
      ],
    });
    connections.set('server-b', {
      id: 'server-b',
      server: { id: 'server-b', name: 'Server B' },
      status: 'connected',
      tools: [
        { name: 'tool2', description: 'Tool 2', inputSchema: { type: 'object' } },
        { name: 'tool3', description: 'Tool 3', inputSchema: { type: 'object' } },
      ],
    });

    const handlers = bridge.getLazyToolHandlers();
    const listTool = handlers.find(h => h.name === 'mcp_list_tools')!;

    const result = await listTool.execute({}, dummyContext) as any[];
    expect(result).toHaveLength(2);
    expect(result[0].server_id).toBe('server-a');
    expect(result[0].tools).toHaveLength(1);
    expect(result[1].server_id).toBe('server-b');
    expect(result[1].tools).toHaveLength(2);
  });

  test('mcp_list_tools filters by server_id', async () => {
    const connections = (bridge as any).connections as Map<string, any>;
    connections.set('server-a', {
      id: 'server-a',
      server: { id: 'server-a', name: 'Server A' },
      status: 'connected',
      tools: [{ name: 'tool1', description: 'Tool 1', inputSchema: {} }],
    });
    connections.set('server-b', {
      id: 'server-b',
      server: { id: 'server-b', name: 'Server B' },
      status: 'connected',
      tools: [{ name: 'tool2', description: 'Tool 2', inputSchema: {} }],
    });

    const handlers = bridge.getLazyToolHandlers();
    const listTool = handlers.find(h => h.name === 'mcp_list_tools')!;

    const result = await listTool.execute({ server_id: 'server-b' }, dummyContext) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].server_id).toBe('server-b');
  });

  test('mcp_list_tools returns message for unknown server', async () => {
    const connections = (bridge as any).connections as Map<string, any>;
    connections.set('server-a', {
      id: 'server-a',
      server: { id: 'server-a', name: 'A' },
      status: 'connected',
      tools: [],
    });

    const handlers = bridge.getLazyToolHandlers();
    const listTool = handlers.find(h => h.name === 'mcp_list_tools')!;

    const result = await listTool.execute({ server_id: 'nonexistent' }, dummyContext) as any;
    expect(result.message).toContain('not found');
  });

  test('skips disconnected servers in listing', async () => {
    const connections = (bridge as any).connections as Map<string, any>;
    connections.set('up', {
      id: 'up',
      server: { id: 'up', name: 'Up' },
      status: 'connected',
      tools: [{ name: 't1', description: 'd1', inputSchema: {} }],
    });
    connections.set('down', {
      id: 'down',
      server: { id: 'down', name: 'Down' },
      status: 'disconnected',
      tools: [{ name: 't2', description: 'd2', inputSchema: {} }],
    });

    const handlers = bridge.getLazyToolHandlers();
    const listTool = handlers.find(h => h.name === 'mcp_list_tools')!;

    const result = await listTool.execute({}, dummyContext) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].server_id).toBe('up');
  });

  test('getToolHandlers still returns expanded tools (for API use)', () => {
    const connections = (bridge as any).connections as Map<string, any>;
    connections.set('srv', {
      id: 'srv',
      server: { id: 'srv', name: 'Srv' },
      status: 'connected',
      tools: [
        { name: 'a', description: 'A', inputSchema: { type: 'object' } },
        { name: 'b', description: 'B', inputSchema: { type: 'object' } },
      ],
    });

    // Expanded: one handler per MCP tool
    const expanded = bridge.getToolHandlers();
    expect(expanded).toHaveLength(2);
    expect(expanded[0].name).toBe('mcp_srv_a');
    expect(expanded[1].name).toBe('mcp_srv_b');

    // Lazy: always 2 meta-tools
    const lazy = bridge.getLazyToolHandlers();
    expect(lazy).toHaveLength(5);
  });
});

describe('MCPBridge config persistence', () => {
  test('rolls back an in-memory add when durable persistence fails', async () => {
    const bridge = new MCPBridge();
    (bridge as any).saveConfig = vi.fn().mockRejectedValue(new Error('database unavailable'));
    await expect(bridge.addServer({ id: 'a', name: 'A', command: 'a', isEnabled: true }))
      .rejects.toThrow('database unavailable');
    expect(bridge.getServerConfigs()).toEqual([]);
  });

  test('serializes concurrent mutations so a rollback cannot erase a later update', async () => {
    const bridge = new MCPBridge();
    let calls = 0;
    (bridge as any).saveConfig = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('first write failed');
    });
    const first = bridge.addServer({ id: 'a', name: 'A', command: 'a', isEnabled: true });
    const second = bridge.addServer({ id: 'b', name: 'B', command: 'b', isEnabled: true });
    await expect(first).rejects.toThrow('first write failed');
    await expect(second).resolves.toBeUndefined();
    expect(bridge.getServerConfigs().map((server) => server.id)).toEqual(['b']);
  });
});

test('MCP discovery bounds schemas and retrieves an exact tool only on demand', async () => {
  const bridge = new MCPBridge();
  (bridge as any).connections.set('server', { id: 'server', server: { name: 'Server' }, status: 'connected',
    tools: Array.from({ length: 100 }, (_, i) => ({ name: `tool_${String(i).padStart(3, '0')}`, description: 'd'.repeat(1000),
      inputSchema: { type: 'object', properties: { payload: { type: 'string' } } } })) });
  const list = bridge.getLazyToolHandlers().find(h => h.name === 'mcp_list_tools')!;
  const first = await list.execute({}, dummyContext) as any[];
  expect(first[0].tools).toHaveLength(15);
  expect(first[0].tools[0].description).toHaveLength(240);
  expect(first[0].tools[0].parameters).toBeUndefined();
  const next = await list.execute({ offset: 15 }, dummyContext) as any[];
  expect(next[0].tools[0].name).toBe('tool_015');
  const exact = await list.execute({ server_id: 'server', tool_name: 'tool_099' }, dummyContext) as any[];
  expect(exact[0].tools).toHaveLength(1);
  expect(exact[0].tools[0].parameters.properties.payload.type).toBe('string');
});
