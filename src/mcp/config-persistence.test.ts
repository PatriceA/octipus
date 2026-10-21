import { beforeEach, expect, test, vi } from 'vitest';
import type { MCPServer } from '@/core/types';

const storage = vi.hoisted(() => ({ servers: [] as MCPServer[] }));
vi.mock('@/config', () => ({ getConfig: () => ({ mcp: {} }) }));
vi.mock('@/config/settings-service', () => ({ getSettingsService: () => ({
  getFresh: async () => structuredClone(storage.servers),
  update: async (_key: string, transform: (stored: unknown) => unknown) => {
    storage.servers = transform(structuredClone(storage.servers)) as MCPServer[];
    return structuredClone(storage.servers);
  },
}) }));
import { MCPBridge } from './bridge';

beforeEach(() => { storage.servers = [{ id: 'a', name: 'A', command: 'node', isEnabled: false }]; });

test('a stale bridge preserves externally edited paths and newly added servers on save and reload', async () => {
  const bridge = new MCPBridge();
  await bridge.loadConfig();
  storage.servers[0].command = '/external/node';
  storage.servers.push({ id: 'b', name: 'B', command: 'python', isEnabled: false });
  await bridge.setDescription('a', 'New description');
  expect(storage.servers[0]).toMatchObject({ command: '/external/node', description: 'New description' });
  expect(storage.servers).toHaveLength(2);
  const restarted = new MCPBridge();
  await restarted.loadConfig();
  expect(restarted.getServerConfigs()).toEqual(storage.servers);
});

test('editing persists without connecting or disconnecting, and does not expose credentials', async () => {
  storage.servers[0].headers = { Authorization: 'secret' };
  const bridge = new MCPBridge();
  const connect = vi.spyOn(bridge, 'connect');
  const disconnect = vi.spyOn(bridge, 'disconnect');
  const view = (await bridge.getEditableConfig('a'))!;
  expect(view).not.toHaveProperty('headers');
  await bridge.editServer('a', { revision: view.revision, command: '/new/node' });
  expect(storage.servers[0]).toMatchObject({ command: '/new/node', headers: { Authorization: 'secret' } });
  expect(connect).not.toHaveBeenCalled();
  expect(disconnect).not.toHaveBeenCalled();
});

test('a conflicting external change is not overwritten and opening the editor reloads it', async () => {
  const bridge = new MCPBridge();
  const view = (await bridge.getEditableConfig('a'))!;
  storage.servers[0].command = '/external/node';
  await expect(bridge.editServer('a', { revision: view.revision, command: '/ui/node' })).rejects.toThrow('changed in storage');
  expect(storage.servers[0].command).toBe('/external/node');
  const refreshed = (await bridge.getEditableConfig('a'))!;
  expect(refreshed.command).toBe('/external/node');
  await bridge.editServer('a', { revision: refreshed.revision, command: '/ui/node' });
  expect(storage.servers[0].command).toBe('/ui/node');
});

test('automatic reconnect uses the edited configuration instead of its captured snapshot', async () => {
  vi.useFakeTimers();
  try {
    storage.servers[0].isEnabled = true;
    const bridge = new MCPBridge();
    const view = (await bridge.getEditableConfig('a'))!;
    const old = bridge.getServerConfigs()[0];
    await bridge.editServer('a', { revision: view.revision, command: '/updated/node' });
    const connect = vi.spyOn(bridge, 'connect').mockRejectedValue(new Error('test connection unavailable'));
    const seam = bridge as unknown as { scheduleReconnect: (server: MCPServer) => void };
    seam.scheduleReconnect(old);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ command: '/updated/node' }));
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});
