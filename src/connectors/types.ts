export interface ConnectorDefinition {
  id: string;
  name: string;
  description: string;
  logoUrl: string;
  /** Full MCP endpoint URL, e.g. https://mcp.atlassian.com/v1/mcp/authv2 */
  mcpEndpoint: string;
  /**
   * OAuth authorization-server metadata document, per the MCP spec. The
   * client is registered dynamically against its `registration_endpoint`, so
   * this URL is all that is needed to add a connector — there is no
   * per-connector OAuth code.
   */
  oauthDiscoveryUrl: string;
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
