import { afterEach, describe, expect, test, vi } from 'vitest';
import { MCPBridge, type MCPServerConnection } from './bridge';
import type { AgentContext, MCPServer } from '@/core/types';
import { isToolNotExecutedResult, ToolNotExecutedError } from '@/core/tool-execution-error';

vi.mock('@/security/mcp-authorization', () => ({ authorizeMcpDispatch: vi.fn().mockResolvedValue(undefined) }));
const context = { id: 'a', userId: 'u', sessionId: 's' } as AgentContext;
afterEach(() => vi.restoreAllMocks());
function fixture(trusted = false, readOnlyHint: unknown = true) {
  const bridge = new MCPBridge();
  const server: MCPServer = { id: 's', name: 'Server', command: '', isEnabled: true, trustRecoveryHints: trusted, exposure: 'direct' };
  const sendRequest = vi.fn().mockResolvedValue({ content: [] });
  const connection = { id: 's', server, status: 'connected', resources: [], prompts: [],
    tools: [{ name: 'read', inputSchema: {}, annotations: { readOnlyHint } }],
    transport: { send: vi.fn() }, protocol: { sendRequest },
  } as unknown as MCPServerConnection;
  const state = bridge as unknown as { connections: Map<string, MCPServerConnection>; serverConfigs: MCPServer[] };
  state.connections.set('s', connection); state.serverConfigs = [server];
  vi.spyOn(bridge, 'ensureConnected').mockResolvedValue(undefined);
  return { bridge, connection, sendRequest };
}

describe('MCP recovery trust boundary', () => {
  test.each([false, true])('read annotations require explicit server trust (%s)', trusted => {
    const { bridge } = fixture(trusted);
    const handlers = [...bridge.getToolHandlers(), ...bridge.getLazyToolHandlers()];
    const calls = handlers.filter(h => ['mcp_s_read', 'mcp__s__read', 'mcp_call_tool'].includes(h.name));
    expect(calls).toHaveLength(3);
    for (const handler of calls) {
      expect(handler.replaySafety).toBeUndefined();
      expect(handler.recoverySafety?.({ server_id: 's', tool_name: 'read' })).toBe(trusted ? 'read_only' : undefined);
    }
  });
  test('unknown tools, truthy hints and forged arguments cannot declare a read', () => {
    const { bridge, connection } = fixture(true, 'true');
    const handler = bridge.getLazyToolHandlers().find(h => h.name === 'mcp_call_tool')!;
    expect(handler.recoverySafety?.({ server_id: 's', tool_name: 'read', readOnlyHint: true })).toBeUndefined();
    connection.tools[0].annotations = { readOnlyHint: true };
    expect(handler.recoverySafety?.({ server_id: 's', tool_name: 'unknown' })).toBeUndefined();
    connection.status = 'disconnected';
    expect(handler.recoverySafety?.({ server_id: 's', tool_name: 'read' })).toBeUndefined();
  });
  test.each([false, true])('not-executed metadata requires server trust (%s)', async trusted => {
    const { bridge, sendRequest } = fixture(trusted);
    const result = { isError: true, content: [{ type: 'text', text: 'refused' }], _meta: { 'octipus/recovery': { outcome: 'not_executed' } } };
    sendRequest.mockResolvedValue(result);
    expect(await bridge.callTool('s', 'read', {}, context)).toBe(result);
    expect(isToolNotExecutedResult('mcp', result)).toBe(trusted);
    expect(isToolNotExecutedResult('shell', result)).toBe(false);
  });
  test('error text and unknown outcomes remain ambiguous even on trusted servers', async () => {
    const { bridge, sendRequest } = fixture(true);
    for (const result of [{ isError: true, content: [{ text: 'refused: no execution' }] },
      { isError: true, _meta: { 'octipus/recovery': { outcome: 'uncertain' } } },
      { _meta: { 'octipus/recovery': { outcome: 'not_executed' } } }]) {
      sendRequest.mockResolvedValue(result);
      await bridge.callTool('s', 'read', {}, context);
      expect(isToolNotExecutedResult('mcp', result)).toBe(false);
    }
  });
  test('local preflight rejection proves no tool request was sent', async () => {
    const { bridge, sendRequest } = fixture();
    vi.mocked(bridge.ensureConnected).mockRejectedValue(new Error('not connected'));
    const error = await bridge.callTool('s', 'read', {}, context).catch((err: unknown) => err);
    expect(isToolNotExecutedResult('mcp', error)).toBe(true);
    expect(sendRequest).not.toHaveBeenCalled();
  });
  test('a read hint revoked while awaiting connection cannot dispatch an unjournaled write', async () => {
    const { bridge, connection, sendRequest } = fixture(true);
    vi.mocked(bridge.ensureConnected).mockImplementation(async () => {
      connection.tools[0].annotations = { readOnlyHint: false };
    });
    const error = await bridge.callTool('s', 'read', {}, context).catch((err: unknown) => err);
    expect(isToolNotExecutedResult('mcp', error)).toBe(true);
    expect(sendRequest).not.toHaveBeenCalled();
  });
  test('transport failures after dispatch retain uncertainty' , async () => {
    const { bridge, sendRequest } = fixture(true);
    const error = new Error('connection dropped'); sendRequest.mockRejectedValue(error);
    await expect(bridge.callTool('s', 'read', {}, context)).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(ToolNotExecutedError);
    expect(isToolNotExecutedResult('mcp', error)).toBe(false);
  });
});
