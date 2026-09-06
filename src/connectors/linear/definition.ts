import type { ConnectorDefinition } from '../types';

/**
 * Linear Remote MCP Server connector.
 *
 * Same shape as Atlassian: an OAuth 2.1 public client registered dynamically
 * against the server's own discovery document, then a Streamable HTTP MCP
 * endpoint. Linear's authorization server advertises exactly two API scopes,
 * `read` and `write`; `offline_access` is not among them, and the refresh
 * token comes from the `refresh_token` grant being supported rather than from
 * asking for a scope.
 */
export const LINEAR_CONNECTOR: ConnectorDefinition = {
  id: 'linear',
  name: 'Linear',
  description: 'Connect Linear issues, projects and cycles via the Linear Remote MCP Server',
  logoUrl: '/logos/linear.svg',
  mcpEndpoint: 'https://mcp.linear.app/mcp',
  oauthDiscoveryUrl: 'https://mcp.linear.app/.well-known/oauth-authorization-server',
  oauthScopes: ['read', 'write'],
};
