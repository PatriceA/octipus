export interface ConnectorDefinition {
  id: string;
  name: string;
  description: string;
  logoUrl: string;
  /** Full MCP endpoint URL, e.g. https://mcp.atlassian.com/v1/mcp/authv2 */
  mcpEndpoint: string;
  /** OAuth 2.1 scopes to request */
  oauthScopes: string[];
}

export interface UserConnectorStatus {
  connectorId: string;
  connected: boolean;
  /** ISO timestamp; present when connected */
  connectedAt?: string;
  /** Error message from last connection attempt */
  error?: string;
}
