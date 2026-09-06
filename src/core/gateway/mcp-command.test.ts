/**
 * `/mcp` — the terminal's only way to see MCP servers and to reconnect one
 * after restarting it (the bridge's auto-reconnect gives up after 6 attempts,
 * ~1 minute, and a longer outage leaves the server dead until someone asks).
 * Pins the admin gate and that reconnect really re-dials.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as bridgeModule from '@/mcp/bridge';
import * as breakerModule from '@/mcp/circuit-breaker';
import { CommandRegistry, registerBuiltinCommands } from './commands';

const server = (id: string, name: string, isEnabled = true) => ({ id, name, command: 'x', isEnabled });

function stubBridge(overrides: Record<string, unknown> = {}) {
  const bridge = {
    getServerConfigs: () => [server('files', 'Filesystem'), server('vault', 'Vault', false)],
    getConnection: (id: string) =>
      id === 'files' ? { id, status: 'connected', tools: [{ name: 'a' }, { name: 'b' }] } : undefined,
    disconnect: vi.fn(async () => {}),
    connect: vi.fn(async () => ({ tools: [{ name: 'a' }] })),
    ...overrides,
  };
  vi.spyOn(bridgeModule, 'getMCPBridge').mockReturnValue(bridge as never);
  return bridge;
}

describe('/mcp', () => {
  let registry: CommandRegistry;
  const local = { userId: 'local', sessionId: 's1', clientType: 'tui', trustLevel: 'local' as const };
  const plainUser = { ...local, userId: 'u1', trustLevel: 'user' as const };

  beforeEach(() => {
    vi.restoreAllMocks();
    registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    vi.spyOn(breakerModule, 'getMcpCircuitBreaker').mockReturnValue({ reset: vi.fn() } as never);
  });

  test('bare /mcp lists every server with its status', async () => {
    stubBridge();
    const text = (await registry.execute('/mcp', local))!.text;
    expect(text).toContain('Filesystem (files) — connected · 2 tool(s)');
    expect(text).toContain('Vault (vault) — disabled');
  });

  test('no servers configured says so instead of an empty list', async () => {
    stubBridge({ getServerConfigs: () => [] });
    expect((await registry.execute('/mcp', local))!.text).toContain('No MCP servers configured');
  });

  test('reconnect re-dials the named server', async () => {
    const bridge = stubBridge();
    const text = (await registry.execute('/mcp reconnect files', local))!.text;
    expect(bridge.disconnect).toHaveBeenCalledWith('files');
    expect(bridge.connect).toHaveBeenCalledWith(expect.objectContaining({ id: 'files' }));
    expect(text).toContain('Filesystem — 1 tool(s)');
  });

  test('reconnect with no server takes every ENABLED server, not the disabled one', async () => {
    const bridge = stubBridge();
    await registry.execute('/mcp reconnect', local);
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(bridge.connect).toHaveBeenCalledWith(expect.objectContaining({ id: 'files' }));
  });

  test('a non-admin user can look but not reconnect', async () => {
    const bridge = stubBridge();
    const list = await registry.execute('/mcp', plainUser);
    expect(list!.text).toContain('Filesystem');

    const denied = await registry.execute('/mcp reconnect files', plainUser);
    expect(denied!.text).toContain('admin');
    expect(bridge.connect).not.toHaveBeenCalled();
  });

  test('a signed-in admin off-loopback (trust "user") may reconnect', async () => {
    const bridge = stubBridge();
    await registry.execute('/mcp reconnect files', { ...plainUser, metadata: { isAdmin: true } });
    expect(bridge.connect).toHaveBeenCalled();
  });

  test('a failing reconnect reports the error instead of throwing', async () => {
    stubBridge({ connect: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    const text = (await registry.execute('/mcp reconnect files', local))!.text;
    expect(text).toContain('ECONNREFUSED');
  });

  test('an unknown server name resolves nothing', async () => {
    const bridge = stubBridge();
    const text = (await registry.execute('/mcp reconnect nope', local))!.text;
    expect(text).toContain('No MCP server matches');
    expect(bridge.connect).not.toHaveBeenCalled();
  });
});
