import type { ToolHandler } from '@/core/agent-base';
import { MCPProtocol, type MCPToolDefinition } from '@/mcp/protocol';
import type { AgentContext } from '@/core/types';
import { agentPrincipal, type Principal } from '@/security/principal';
import { coreLogger } from '@/utils/logger';
import { ALL_CONNECTORS, findConnector } from './definitions';
import { OAuthHTTPTransport } from './oauth-http-transport';
import type { ConnectorDefinition } from './types';

/**
 * Whose connection a connector call uses: a user's own (a user id), or a
 * space's (coworking §9.5) — a member's principal in the space, whose
 * membership the space access layer checks on every token read. An agent in
 * a space uses the space's connectors only, never the member's personal ones.
 */
export type ConnectorOwner = string | { space: Principal };

/** The connector owner of an agent: its space's connections inside a space, else its user's. */
export function connectorOwnerOf(context: Pick<AgentContext, 'userId' | 'workspaceId' | 'space'>): ConnectorOwner {
  return context.space ? { space: agentPrincipal(context) } : context.userId;
}

function ownerKey(owner: ConnectorOwner): string {
  return typeof owner === 'string' ? owner : `space:${owner.space.workspaceId}:${owner.space.userId}`;
}

export class ConnectorRegistry {
  constructor(
    private readonly getAccessToken: (
      connectorId: string,
      owner: ConnectorOwner,
    ) => Promise<string | null>,
  ) {}

  /**
   * Tool handlers for the user's active (authed) connectors.
   *
   * @param allowedConnectorIds When provided (non-null), only connectors whose
   *   id is in this set are exposed — this is how role↔connector binding gates
   *   connectors per role (W7). Callers derive this set from a role's
   *   `connector:<id>` toolIds (colon prefix, not `connector_`). When
   *   omitted/undefined, ALL active connectors are exposed (backward-compatible
   *   default for roles that bind none).
   */
  async getUserToolHandlers(
    owner: ConnectorOwner,
    allowedConnectorIds?: ReadonlySet<string>,
  ): Promise<ToolHandler[]> {
    const activeConnectors: ConnectorDefinition[] = [];

    for (const connector of ALL_CONNECTORS) {
      if (allowedConnectorIds && !allowedConnectorIds.has(connector.id)) continue;
      const token = await this.getAccessToken(connector.id, owner).catch(() => null);
      if (token) activeConnectors.push(connector);
    }

    if (activeConnectors.length === 0) return [];

    return [
      this.buildListToolsHandler(owner, activeConnectors),
      this.buildCallToolHandler(owner, activeConnectors),
    ];
  }

  private buildListToolsHandler(
    owner: ConnectorOwner,
    connectors: ConnectorDefinition[],
  ): ToolHandler {
    const registry = this;
    return {
      name: 'connector_list_tools',
      replaySafety: 'read_only',
      description:
        'List tools available from connected built-in connectors (e.g. Atlassian Jira/Confluence). ' +
        'Call before connector_call_tool to discover available tools and their parameters.',
      parameters: {
        type: 'object',
        properties: {
          connector_id: {
            type: 'string',
            description: 'Optional: filter by connector ID (e.g. "atlassian"). Omit to list all.',
          },
        },
      },
      toolId: 'connector',
      execute: async (args) => {
        const filterId = args.connector_id as string | undefined;
        const result: Array<{
          connector_id: string;
          connector_name: string;
          tools: Array<{ name: string; description: string; parameters?: unknown }>;
        }> = [];

        for (const connector of connectors) {
          if (filterId && connector.id !== filterId) continue;

          const tools = await registry.fetchConnectorTools(connector, owner).catch((err) => {
            coreLogger.warn({ err, connectorId: connector.id, owner: ownerKey(owner) }, 'Failed to list connector tools');
            return [] as MCPToolDefinition[];
          });

          result.push({
            connector_id: connector.id,
            connector_name: connector.name,
            tools: tools.map(t => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            })),
          });
        }

        return result.length > 0 ? result : { message: 'No connectors matched or tools available.' };
      },
    };
  }

  private buildCallToolHandler(
    owner: ConnectorOwner,
    connectors: ConnectorDefinition[],
  ): ToolHandler {
    const registry = this;
    return {
      name: 'connector_call_tool',
      description:
        'Call a tool on a built-in connector (e.g. Atlassian). ' +
        'Use connector_list_tools first to discover available tool names and parameter schemas.',
      parameters: {
        type: 'object',
        properties: {
          connector_id: { type: 'string', description: 'Connector ID (e.g. "atlassian")' },
          tool_name: { type: 'string', description: 'Tool name from connector_list_tools' },
          arguments: { type: 'object', description: 'Arguments per the tool schema' },
        },
        required: ['connector_id', 'tool_name'],
      },
      toolId: 'connector',
      execute: async (args) => {
        const connectorId = args.connector_id as string;
        const toolName = args.tool_name as string;
        const toolArgs = (args.arguments as Record<string, unknown>) ?? {};

        const connector = connectors.find(c => c.id === connectorId);
        if (!connector) {
          throw new Error(`Connector '${connectorId}' not found or not connected for this user.`);
        }

        return registry.callConnectorTool(connector, owner, toolName, toolArgs);
      },
    };
  }

  /**
   * The remote server's own tool list.
   *
   * Public because the named connector tools (`src/tools/atlassian`) resolve
   * a capability against it rather than hard-coding a remote tool name that
   * the vendor is free to rename.
   */
  async fetchConnectorTools(
    connector: ConnectorDefinition,
    owner: ConnectorOwner,
  ): Promise<MCPToolDefinition[]> {
    const { transport, protocol, send } = await this.openConnection(connector, owner);
    try {
      await transport.connect();
      await protocol.sendRequest(send, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'octipus-connector', version: '1.0.0' },
      });
      protocol.sendNotification(send, 'notifications/initialized');
      const res = await protocol.sendRequest(send, 'tools/list') as { tools: MCPToolDefinition[] };
      return res.tools ?? [];
    } finally {
      transport.close();
      protocol.cleanup();
    }
  }

  /** Invoke one tool on a connector. Public for the same reason as above. */
  async callConnectorTool(
    connector: ConnectorDefinition,
    owner: ConnectorOwner,
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<unknown> {
    const { transport, protocol, send } = await this.openConnection(connector, owner);
    try {
      await transport.connect();
      await protocol.sendRequest(send, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'octipus-connector', version: '1.0.0' },
      });
      protocol.sendNotification(send, 'notifications/initialized');
      return await protocol.sendRequest(send, 'tools/call', { name: toolName, arguments: toolArgs });
    } finally {
      transport.close();
      protocol.cleanup();
    }
  }

  private async openConnection(
    connector: ConnectorDefinition,
    owner: ConnectorOwner,
  ): Promise<{ transport: OAuthHTTPTransport; protocol: MCPProtocol; send: (msg: string) => void }> {
    const transport = new OAuthHTTPTransport(
      connector.mcpEndpoint,
      async () => {
        const token = await this.getAccessToken(connector.id, owner);
        if (!token) throw new Error(`No ${connector.id} token for ${typeof owner === 'string' ? `user ${owner}` : 'this space'}`);
        return token;
      },
    );

    const protocol = new MCPProtocol();
    transport.onMessage((line) => {
      try {
        const msg = protocol.parseMessage(line);
        protocol.handleMessage(msg);
      } catch (err) {
        coreLogger.error({ err, connectorId: connector.id }, 'Failed to parse connector MCP message');
      }
    });

    const send = (message: string) => transport.send(message);
    return { transport, protocol, send };
  }
}

// Singleton
let registryInstance: ConnectorRegistry | null = null;

export function getConnectorRegistry(): ConnectorRegistry {
  if (!registryInstance) {
    registryInstance = new ConnectorRegistry(
      async (connectorId, owner) => {
        // An unknown id must not reach the vault: `connector_<id>_access_token`
        // built from an arbitrary string is a lookup by attacker-chosen name.
        if (!findConnector(connectorId)) return null;
        if (typeof owner !== 'string') {
          const { spaceConnectorAccessToken } = await import('@/core/spaces/connectors');
          return spaceConnectorAccessToken(owner.space, connectorId);
        }
        // Loaded on use, not at module load: `@/security/oauth` imports back into the connectors.
        const { getConnectorAccessToken } = await import('@/security/oauth');
        return getConnectorAccessToken(connectorId, owner);
      },
    );
  }
  return registryInstance;
}
