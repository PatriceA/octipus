/**
 * Model information tools — list available models and check health.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssistantClient } from '../client.js';

export function registerModelTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_list_models',
    'List all available AI models with their provider, capabilities, and status.',
    {},
    async () => {
      try {
        const models = await client.listModels();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(models, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list models: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_model_health',
    'Get health status of all configured models (connectivity, response times).',
    {},
    async () => {
      try {
        const health = await client.getModelHealth();
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
}
