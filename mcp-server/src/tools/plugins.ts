/**
 * Plugin tools — list and reload assistant plugins.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerPluginTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_list_plugins',
    'List all loaded assistant plugins with their tools and metadata.',
    {},
    async () => {
      try {
        const plugins = await client.listPlugins();
        if (plugins.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No plugins loaded.' }],
          };
        }
        const summary = plugins.map((p) => {
          const toolList = p.tools.map((t) => `  - ${t.name}: ${t.description}`).join('\n');
          return `**${p.name}** v${p.version}${p.author ? ` by ${p.author}` : ''}\n${p.description}\nTools:\n${toolList}`;
        }).join('\n\n');
        return {
          content: [{ type: 'text' as const, text: summary }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list plugins: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_reload_plugin',
    'Reload a specific plugin by name. Useful during plugin development to pick up code changes without restarting the backend.',
    {
      name: z.string().describe('Plugin name to reload'),
    },
    async ({ name }) => {
      try {
        const result = await client.reloadPlugin(name);
        if (result.error) {
          return {
            content: [{ type: 'text' as const, text: `Plugin reload failed: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `${result.message}\nVersion: ${result.version}, Tools: ${result.tools}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to reload plugin: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
