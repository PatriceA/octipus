/**
 * Health check tools — detailed health, model health, channel health, and server time.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssistantClient } from '../client.js';

export function registerHealthTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_health',
    'Get detailed health status of the assistant backend.',
    {},
    async () => {
      try {
        const health = await client.getDetailedHealth();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(health, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get health: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_health_models',
    'Get health status of all configured models.',
    {},
    async () => {
      try {
        const health = await client.getModelHealth2();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(health, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get model health: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_health_channels',
    'Get health status of all messaging channels.',
    {},
    async () => {
      try {
        const health = await client.getChannelHealth();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(health, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get channel health: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_server_time',
    'Get the current server time.',
    {},
    async () => {
      try {
        const time = await client.getServerTime();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(time, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get server time: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
