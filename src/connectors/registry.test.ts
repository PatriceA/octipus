import { describe, expect, test, vi } from 'vitest';
import type { ConnectorDefinition, UserConnectorStatus } from './types';

// The registry is exercised against a stand-in connector; the real list is
// read through `vi.importActual` below.
vi.mock('./definitions', async () => (await import('@/test-helpers/connector-fixtures')).mockDefinitions());

describe('connector types', () => {
  test('ConnectorDefinition shape compiles', () => {
    const def: ConnectorDefinition = {
      id: 'test',
      name: 'Test',
      description: 'Test connector',
      logoUrl: '/logos/test.svg',
      mcpEndpoint: 'https://example.com/mcp',
      oauthDiscoveryUrl: 'https://example.com/.well-known/oauth-authorization-server',
      oauthScopes: ['read:me', 'offline_access'],
    };
    expect(def.id).toBe('test');
  });

  test('UserConnectorStatus shape compiles', () => {
    const status: UserConnectorStatus = {
      connectorId: 'test',
      connected: false,
    };
    expect(status.connected).toBe(false);
  });
});

describe('built-in definitions', () => {
  test('every connector carries a discovery URL and a unique id', async () => {
    const { ALL_CONNECTORS } = await vi.importActual<typeof import('./definitions')>('./definitions');
    // Registration is driven entirely off the discovery document, so a
    // definition without one cannot be connected at all.
    const ids = new Set<string>();
    for (const connector of ALL_CONNECTORS) {
      expect(connector.oauthDiscoveryUrl).toMatch(/^https:\/\/.+\/\.well-known\//);
      expect(ids.has(connector.id)).toBe(false);
      ids.add(connector.id);
    }
  });

  test('the removed Atlassian and Linear connectors no longer resolve', async () => {
    const { findConnector, isConnectorId } = await vi.importActual<typeof import('./definitions')>('./definitions');
    for (const id of ['atlassian', 'linear', 'gitlab', 'nope']) {
      expect(findConnector(id)).toBeUndefined();
      expect(isConnectorId(id)).toBe(false);
    }
    expect(isConnectorId('google')).toBe(false);
  });
});

import { ConnectorRegistry, getConnectorRegistry } from './registry';

describe('ConnectorRegistry', () => {
  test('getUserToolHandlers returns empty array when user has no connectors', async () => {
    const mockGetToken = async (_connectorId: string, _owner: unknown): Promise<string | null> => null;
    const registry = new ConnectorRegistry(mockGetToken);
    const handlers = await registry.getUserToolHandlers('user-without-connectors');
    expect(handlers).toHaveLength(0);
  });

  test('getUserToolHandlers returns two meta-tools when user has connector', async () => {
    const mockGetToken = async (_connectorId: string, _owner: unknown): Promise<string | null> => 'valid-token';
    const registry = new ConnectorRegistry(mockGetToken);
    const handlers = await registry.getUserToolHandlers('user-with-example');
    expect(handlers.length).toBeGreaterThanOrEqual(2);
    const names = handlers.map(h => h.name);
    expect(names).toContain('connector_list_tools');
    expect(names).toContain('connector_call_tool');
  });

  test('allowedConnectorIds filters out connectors not bound to the role (W7 gating)', async () => {
    const mockGetToken = async (): Promise<string | null> => 'valid-token';
    const registry = new ConnectorRegistry(mockGetToken);
    // Role binds a connector the user does NOT have → no handlers exposed.
    const handlers = await registry.getUserToolHandlers('user-with-example', new Set(['some-other-connector']));
    expect(handlers).toHaveLength(0);
  });

  test('allowedConnectorIds includes the bound connector → meta-tools exposed', async () => {
    const mockGetToken = async (): Promise<string | null> => 'valid-token';
    const registry = new ConnectorRegistry(mockGetToken);
    const handlers = await registry.getUserToolHandlers('user-with-example', new Set(['example']));
    expect(handlers.length).toBeGreaterThanOrEqual(2);
  });

  test('undefined allowedConnectorIds preserves backward-compatible all-connectors behaviour', async () => {
    const mockGetToken = async (): Promise<string | null> => 'valid-token';
    const registry = new ConnectorRegistry(mockGetToken);
    const handlers = await registry.getUserToolHandlers('user-with-example', undefined);
    expect(handlers.length).toBeGreaterThanOrEqual(2);
  });
});

describe('a stored id of a removed connector (atlassian, linear) is ignored', () => {
  test('a role still binding `connector:atlassian` or `connector:linear` gets no connector tools', async () => {
    const asked: string[] = [];
    const registry = new ConnectorRegistry(async (id) => { asked.push(id); return 'stale-token'; });
    expect(await registry.getUserToolHandlers('user', new Set(['atlassian', 'linear']))).toEqual([]);
    // Only defined connectors are ever looked up.
    expect(asked).toEqual([]);
  });

  test('connector_call_tool refuses a removed connector id instead of reaching for it', async () => {
    const registry = new ConnectorRegistry(async () => 'valid-token');
    const call = (await registry.getUserToolHandlers('user')).find((h) => h.name === 'connector_call_tool')!;
    await expect(call.execute({ connector_id: 'atlassian', tool_name: 'getJiraIssue' }, {} as never))
      .rejects.toThrow(/Connector 'atlassian' not found/);
  });

  test('the default token lookup returns null for them without reading the vault', async () => {
    // No vault is initialized here: a lookup that reached it would throw.
    const { getAccessToken } = getConnectorRegistry() as unknown as { getAccessToken: (id: string, owner: string) => Promise<string | null> };
    for (const id of ['atlassian', 'linear']) {
      await expect(getAccessToken(id, 'user')).resolves.toBeNull();
    }
  });
});
