import type { ConnectorDefinition } from '../types';

/**
 * Atlassian Remote MCP Server connector.
 * Endpoint: https://mcp.atlassian.com/v1/mcp/authv2
 * OAuth: discovered at https://mcp.atlassian.com/.well-known/oauth-authorization-server
 */
export const ATLASSIAN_CONNECTOR: ConnectorDefinition = {
  id: 'atlassian',
  name: 'Atlassian',
  description: 'Connect Jira and Confluence via the Atlassian Remote MCP Server',
  logoUrl: '/logos/atlassian.svg',
  mcpEndpoint: 'https://mcp.atlassian.com/v1/mcp/authv2',
  oauthScopes: [
    'read:me',
    'read:jira-work',
    'write:jira-work',
    'read:confluence-content.all',
    'write:confluence-content',
    'offline_access',
  ],
};

/** Discovery URL for OAuth metadata per MCP spec. */
export const ATLASSIAN_OAUTH_DISCOVERY_URL =
  'https://mcp.atlassian.com/.well-known/oauth-authorization-server';
