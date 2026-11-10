/**
 * A stand-in connector for tests of the connector framework.
 *
 * No connector ships built in, so a test that drives the registry, the OAuth
 * flow or a space connector mocks `@/connectors/definitions` with this one:
 *
 *   vi.mock('@/connectors/definitions', async () => (await import('@/test-helpers/connector-fixtures')).mockDefinitions());
 */
import type { ConnectorDefinition } from '@/connectors/types';

export const TEST_CONNECTOR: ConnectorDefinition = {
  id: 'example',
  name: 'Example',
  description: 'A connector that exists only in tests',
  logoUrl: '/logos/example.svg',
  mcpEndpoint: 'https://mcp.example.test/mcp',
  oauthDiscoveryUrl: 'https://mcp.example.test/.well-known/oauth-authorization-server',
  oauthScopes: ['read', 'offline_access'],
};

/** The `@/connectors/definitions` module with `TEST_CONNECTOR` as its only connector. */
export function mockDefinitions() {
  const all: readonly ConnectorDefinition[] = [TEST_CONNECTOR];
  return {
    ALL_CONNECTORS: all,
    findConnector: (id: string) => all.find((c) => c.id === id),
    isConnectorId: (id: string) => all.some((c) => c.id === id),
  };
}
