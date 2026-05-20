import { describe, expect, test } from 'bun:test';
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
