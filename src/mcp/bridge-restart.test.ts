/**
 * Restarting a server (docs/PLUGIN-PACKAGES.md#content-pinning): the old
 * process has exited before the start check (the plugin content hash) runs,
 * and concurrent connects of one server (an on-demand reconnect, the backoff
 * timer, a sync) share one check and one child.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MCPServer } from '@/core/types';
import { MCPBridge, type MCPServerConnection } from './bridge';
import type { CloseHandler, MCPTransport, MessageHandler } from './transports/interface';

const server: MCPServer = {
  id: 'plugin-demo', name: 'Demo', command: 'node', isEnabled: true,
  plugin: { package: 'demo', version: '1.0.0', tools: {}, maxProtection: 4 },
};

/** A transport that answers every request with empty capabilities. */
function fakeTransport(): MCPTransport & { finish: () => void } {
  let onMessage: MessageHandler = () => {};
  let onClose: CloseHandler = () => {};
  return {
    connect: async () => {},
    onError: () => {},
    onMessage: (h) => { onMessage = h; },
    onClose: (h) => { onClose = h; },
    send: (message) => {
      const request = JSON.parse(message);
      if (request.id !== undefined) queueMicrotask(() => onMessage(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } })));
    },
    close: vi.fn(),
    finish: () => onClose(),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup() {
  const bridge = new MCPBridge();
  (bridge as unknown as { pluginServers: MCPServer[] }).pluginServers = [server];
  const transports: Array<ReturnType<typeof fakeTransport>> = [];
  const create = vi.spyOn(bridge as unknown as { createTransport: () => MCPTransport }, 'createTransport').mockImplementation(() => {
    const t = fakeTransport();
    transports.push(t);
    return t;
  });
  const connections = (bridge as unknown as { connections: Map<string, MCPServerConnection> }).connections;
  return { bridge, create, transports, connections };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('one start at a time per server', () => {
  test('concurrent connects share one start check and one transport', async () => {
    const { bridge, create } = setup();
    const gate = deferred();
    const guard = vi.fn(async () => { await gate.promise; return null; });
    bridge.setPluginStartGuard(guard);
    const a = bridge.connect(server);
    const b = bridge.connect(server);
    const c = bridge.ensureConnected(server.id);
    gate.resolve();
    const [ca, cb] = await Promise.all([a, b, c]);
    expect(ca).toBe(cb);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(bridge.isConnected(server.id)).toBe(true);
    await bridge.disconnectAll();
  });

  test('a refused start is shared too, and the next connect checks again', async () => {
    const { bridge, create } = setup();
    const guard = vi.fn(async () => 'Modified since it was approved (hash mismatch); approve its content to run it');
    bridge.setPluginStartGuard(guard);
    const results = await Promise.allSettled([bridge.connect(server), bridge.connect(server)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    await expect(bridge.connect(server)).rejects.toThrow(/hash mismatch/);
    expect(guard).toHaveBeenCalledTimes(2);
  });
});

describe('a restart waits for the old process', () => {
  /** A registered connection whose process exits when `exit` resolves. */
  function staleConnection(connections: Map<string, MCPServerConnection>) {
    const exit = deferred();
    const closeAndWait = vi.fn(() => exit.promise);
    const transport = { ...fakeTransport(), closeAndWait };
    const protocol = { cleanup: vi.fn(), sendRequest: vi.fn() };
    connections.set(server.id, { id: server.id, server, transport, protocol, status: 'disconnected', tools: [], resources: [], prompts: [], capabilities: {} } as unknown as MCPServerConnection);
    return { exit, closeAndWait };
  }

  test('on demand: the start check runs only after the old process has exited', async () => {
    const { bridge, connections, create } = setup();
    const order: string[] = [];
    bridge.setPluginStartGuard(async () => { order.push('guard'); return null; });
    const { exit, closeAndWait } = staleConnection(connections);
    const restarting = bridge.ensureConnected(server.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(closeAndWait).toHaveBeenCalledOnce();
    expect(order).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    order.push('exited');
    exit.resolve();
    await restarting;
    expect(order).toEqual(['exited', 'guard']);
    expect(bridge.isConnected(server.id)).toBe(true);
    await bridge.disconnectAll();
  });

  test('the backoff timer and an on-demand reconnect share one restart', async () => {
    vi.useFakeTimers();
    const { bridge, connections, create } = setup();
    const guard = vi.fn(async () => null);
    bridge.setPluginStartGuard(guard);
    const { exit, closeAndWait } = staleConnection(connections);
    (bridge as unknown as { scheduleReconnect: (s: MCPServer) => void }).scheduleReconnect(server);
    await vi.advanceTimersByTimeAsync(1_000);
    // The timer is waiting for the old process; an on-demand reconnect joins it.
    const onDemand = bridge.ensureConnected(server.id);
    exit.resolve();
    await onDemand;
    expect(closeAndWait).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(bridge.isConnected(server.id)).toBe(true);
    vi.useRealTimers();
    await bridge.disconnectAll();
  });

  test('a disconnect during the wait keeps the server down', async () => {
    const { bridge, connections, create } = setup();
    bridge.setPluginStartGuard(async () => null);
    const { exit } = staleConnection(connections);
    const restarting = bridge.ensureConnected(server.id);
    const stopping = bridge.disconnect(server.id);
    exit.resolve();
    await Promise.all([restarting, stopping]);
    expect(create).not.toHaveBeenCalled();
    expect(bridge.isConnected(server.id)).toBe(false);
  });

  test('disconnect returns only once the process has exited', async () => {
    const { bridge, connections } = setup();
    const { exit } = staleConnection(connections);
    let done = false;
    const stopping = bridge.disconnect(server.id).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    exit.resolve();
    await stopping;
    expect(done).toBe(true);
  });
});
