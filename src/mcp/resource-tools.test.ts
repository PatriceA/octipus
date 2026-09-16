import { describe, expect, test, vi } from 'vitest';
const authorize = vi.hoisted(() => vi.fn());
vi.mock('@/security/mcp-authorization', () => ({ authorizeMcpDispatch: authorize }));
import { resourceHandlers } from './resource-tools';
import type { MCPBridge } from './bridge';
import type { AgentContext } from '@/core/types';
const context = {} as AgentContext;
describe('on-demand MCP resources and prompts', () => {
  test('catalog pagination does not read resource contents', async () => {
    const read = vi.fn();
    const bridge = { readResource: read, getAllConnections: () => [{ status: 'connected', id: 's',
      resources: Array.from({ length: 25 }, (_, i) => ({ name: `r${i}`, uri: `test://${i}` })),
      templates: [{ name: 'file', uriTemplate: 'test://{path}' }], prompts: [{ name: 'review' }] }] } as unknown as MCPBridge;
    const handler = resourceHandlers(bridge)[0];
    const first = await handler.execute({}, context) as any;
    expect(first.items).toHaveLength(20); expect(first.total).toBe(27); expect(first.nextOffset).toBe(20);
    expect(read).not.toHaveBeenCalled();
  });
  test('authorization rejection prevents resource and prompt dispatch', async () => {
    authorize.mockRejectedValue(new Error('denied'));
    const readResource = vi.fn(); const getPrompt = vi.fn();
    const handlers = resourceHandlers({ readResource, getPrompt } as unknown as MCPBridge);
    await expect(handlers[1].execute({ server_id: 's', uri: 'test://private' }, context)).rejects.toThrow('denied');
    await expect(handlers[2].execute({ server_id: 's', name: 'review' }, context)).rejects.toThrow('denied');
    expect(readResource).not.toHaveBeenCalled(); expect(getPrompt).not.toHaveBeenCalled();
  });
});
