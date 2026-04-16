/**
 * Settings management tools — list, get, update, and reset settings.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerSettingTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_list_settings',
    'List all settings and their current values.',
    {},
    async () => {
      try {
        const settings = await client.listSettings();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(settings, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list settings: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_get_setting',
    'Get the value of a specific setting by key.',
    {
      key: z.string().describe('The setting key'),
    },
    async ({ key }) => {
      try {
        const setting = await client.getSetting(key);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(setting, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get setting: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_update_setting',
    'Update a setting value by key.',
    {
      key: z.string().describe('The setting key to update'),
      value: z.string().describe('The new value for the setting (JSON string for complex values)'),
    },
    async ({ key, value }) => {
      try {
        let parsedValue: unknown;
        try {
          parsedValue = JSON.parse(value);
        } catch {
          parsedValue = value;
        }
        const result = await client.updateSetting(key, parsedValue);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to update setting: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_reset_setting',
    'Reset a setting to its default value.',
    {
      key: z.string().describe('The setting key to reset'),
    },
    async ({ key }) => {
      try {
        const result = await client.resetSetting(key);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to reset setting: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
