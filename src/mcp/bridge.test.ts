import { describe, test, expect, beforeEach } from 'bun:test';
import { MCPBridge } from './bridge';

describe('MCPBridge.getLazyToolHandlers', () => {
  let bridge: MCPBridge;

  beforeEach(() => {
    bridge = new MCPBridge();
  });

  test('returns empty array when no servers connected', () => {
    const handlers = bridge.getLazyToolHandlers();
    expect(handlers).toEqual([]);
  });

  test('returns exactly 2 meta-tools when servers are connected', async () => {
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
    expect(handlers).toHaveLength(2);
    expect(handlers[0].name).toBe('mcp_list_tools');
    expect(handlers[1].name).toBe('mcp_call_tool');
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

    const result = await listTool.execute({}) as any[];
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

    const result = await listTool.execute({ server_id: 'server-b' }) as any[];
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

    const result = await listTool.execute({ server_id: 'nonexistent' }) as any;
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

    const result = await listTool.execute({}) as any[];
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
    expect(lazy).toHaveLength(2);
  });
});
