import { describe, expect, test } from 'vitest';
import type { ConnectorDefinition, UserConnectorStatus } from './types';
import { ATLASSIAN_CONNECTOR } from './atlassian/definition';

describe('connector types', () => {
  test('ConnectorDefinition shape compiles', () => {
    const def: ConnectorDefinition = {
      id: 'test',
      name: 'Test',
      description: 'Test connector',
      logoUrl: '/logos/test.svg',
      mcpEndpoint: 'https://example.com/mcp',
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

describe('atlassian definition', () => {
  test('has required fields', () => {
    expect(ATLASSIAN_CONNECTOR.id).toBe('atlassian');
    expect(ATLASSIAN_CONNECTOR.mcpEndpoint).toBe('https://mcp.atlassian.com/v1/mcp/authv2');
    expect(ATLASSIAN_CONNECTOR.oauthScopes.length).toBeGreaterThan(0);
  });
});

import { ConnectorRegistry } from './registry';

describe('ConnectorRegistry', () => {
  test('getUserToolHandlers returns empty array when user has no connectors', async () => {
    const mockGetToken = async (_connectorId: string, _userId: string): Promise<string | null> => null;
    const registry = new ConnectorRegistry(mockGetToken);
    const handlers = await registry.getUserToolHandlers('user-without-connectors');
    expect(handlers).toHaveLength(0);
  });

  test('getUserToolHandlers returns two meta-tools when user has connector', async () => {
    const mockGetToken = async (_connectorId: string, _userId: string): Promise<string | null> => 'valid-token';
    const registry = new ConnectorRegistry(mockGetToken);
    const handlers = await registry.getUserToolHandlers('user-with-atlassian');
    expect(handlers.length).toBeGreaterThanOrEqual(2);
    const names = handlers.map(h => h.name);
    expect(names).toContain('connector_list_tools');
    expect(names).toContain('connector_call_tool');
  });

  test('allowedConnectorIds filters out connectors not bound to the role (W7 gating)', async () => {
    const mockGetToken = async (): Promise<string | null> => 'valid-token';
    const registry = new ConnectorRegistry(mockGetToken);
    // Role binds a connector the user does NOT have → no handlers exposed.
    const handlers = await registry.getUserToolHandlers('user-with-atlassian', new Set(['some-other-connector']));
    expect(handlers).toHaveLength(0);
  });

  test('allowedConnectorIds includes the bound connector → meta-tools exposed', async () => {
    const mockGetToken = async (): Promise<string | null> => 'valid-token';
    const registry = new ConnectorRegistry(mockGetToken);
    const handlers = await registry.getUserToolHandlers('user-with-atlassian', new Set(['atlassian']));
    expect(handlers.length).toBeGreaterThanOrEqual(2);
  });

  test('undefined allowedConnectorIds preserves backward-compatible all-connectors behaviour', async () => {
    const mockGetToken = async (): Promise<string | null> => 'valid-token';
    const registry = new ConnectorRegistry(mockGetToken);
    const handlers = await registry.getUserToolHandlers('user-with-atlassian', undefined);
    expect(handlers.length).toBeGreaterThanOrEqual(2);
  });
});
