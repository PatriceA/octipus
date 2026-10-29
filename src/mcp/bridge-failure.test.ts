import { describe, expect, it, vi } from 'vitest';
import { MCPBridge } from './bridge';
import type { MCPServer } from '@/core/types';
import type { MCPTransport, ErrorHandler, MessageHandler, CloseHandler } from './transports/interface';

const server: MCPServer = { id: 'broken', name: 'Broken integration', command: 'missing-mcp-server', isEnabled: true };

function fakeTransport(failOnConnect = false) {
  let onError: ErrorHandler = () => {};
  let onMessage: MessageHandler = () => {};
  let onClose: CloseHandler = () => {};
  const failure = new Error('MCP endpoint unavailable');
  const transport: MCPTransport = {
    connect: async () => { if (failOnConnect) onError(failure); },
    onError: handler => { onError = handler; },
    onMessage: handler => { onMessage = handler; },
    onClose: handler => { onClose = handler; },
    send: () => { queueMicrotask(() => onError(failure)); },
    close: vi.fn(),
  };
  return { transport, failure, fail: () => onError(failure), reply: (message: string) => onMessage(message),
    finish: () => onClose(),
    succeed: () => { transport.send = message => {
      const request = JSON.parse(message);
      if (request.id !== undefined) queueMicrotask(() => onMessage(JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: { capabilities: {} },
      })));
    }; } };
}

describe('MCP connection failures stay local to the integration', () => {
  it.each([true, false])('rejects startup errors promptly without an error-event subscriber (during connect: %s)', async early => {
    const bridge = new MCPBridge();
    const fake = fakeTransport(early);
    vi.spyOn(bridge as any, 'createTransport').mockReturnValue(fake.transport);
    await expect(bridge.connect(server)).rejects.toThrow('MCP endpoint unavailable');
    expect(fake.transport.close).toHaveBeenCalledOnce();
    expect(bridge.isConnected(server.id)).toBe(false);
  });

  it('preserves the existing error event for subscribers', async () => {
    const bridge = new MCPBridge();
    const fake = fakeTransport();
    vi.spyOn(bridge as any, 'createTransport').mockReturnValue(fake.transport);
    const listener = vi.fn();
    bridge.on('error', listener);
    await expect(bridge.connect(server)).rejects.toBe(fake.failure);
    expect(listener).toHaveBeenCalledWith(server.id, fake.failure);
  });

  it('rejects a transport that closes before initialize is sent', async () => {
    const bridge = new MCPBridge();
    const fake = fakeTransport();
    fake.transport.connect = async () => { fake.finish(); };
    const send = vi.spyOn(fake.transport, 'send');
    vi.spyOn(bridge as any, 'createTransport').mockReturnValue(fake.transport);
    await expect(bridge.connect(server)).rejects.toThrow('closed during initialization');
    expect(send).not.toHaveBeenCalled();
    expect(fake.transport.close).toHaveBeenCalledOnce();
  });

  it('does not declare success after an optional catalog request loses the transport', async () => {
    const bridge = new MCPBridge();
    const fake = fakeTransport();
    fake.transport.send = message => {
      const request = JSON.parse(message);
      if (request.method === 'resources/templates/list') { queueMicrotask(fake.fail); return; }
      if (request.id === undefined) return;
      queueMicrotask(() => fake.reply(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: request.method === 'initialize' ? { capabilities: { resources: true } } : { resources: [] },
      })));
    };
    vi.spyOn(bridge as any, 'createTransport').mockReturnValue(fake.transport);
    await expect(bridge.connect(server)).rejects.toThrow('MCP endpoint unavailable');
    expect(bridge.isConnected(server.id)).toBe(false);
  });

  it('fails an in-flight request without crashing an already connected bridge', async () => {
    const bridge = new MCPBridge();
    const fake = fakeTransport();
    fake.succeed();
    vi.spyOn(bridge as any, 'createTransport').mockReturnValue(fake.transport);
    const connection = await bridge.connect(server);
    const request = connection.protocol.sendRequest(() => {}, 'tools/call');
    expect(() => fake.fail()).not.toThrow();
    await expect(request).rejects.toBe(fake.failure);
    expect(connection.status).toBe('error');
    expect(connection.error).toBe(fake.failure.message);
  });

  it('rejects a real missing executable without an uncaught error', async () => {
    const bridge = new MCPBridge();
    await expect(bridge.connect(server)).rejects.toThrow(/ENOENT/);
  });
});
