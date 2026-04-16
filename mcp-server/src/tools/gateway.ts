/**
 * Gateway tools — check status, connections, and adapters.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssistantClient } from '../client.js';

export function registerGatewayTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_gateway_status',
    'Get the current gateway status.',
    {},
    async () => {
      try {
        const status = await client.getGatewayStatus();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get gateway status: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_gateway_connections',
    'List all gateway connections.',
    {},
    async () => {
      try {
        const connections = await client.getGatewayConnections();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(connections, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get gateway connections: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_gateway_adapters',
    'List all gateway adapters.',
    {},
    async () => {
      try {
        const adapters = await client.getGatewayAdapters();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(adapters, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get gateway adapters: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
