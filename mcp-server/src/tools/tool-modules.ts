/**
 * Tool proxy tools — list available tools and execute any tool generically.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

export function registerToolModuleTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_list_tools',
    'List all available tools and their sub-tools. Tools include: filesystem, shell, git, browser, browser-ext, websearch, docker, knowledge.',
    {},
    async () => {
      try {
        const tools = await client.listTools();
        // Format as a readable summary
        const summary = tools.map((s: any) => ({
          id: s.id,
          name: s.name,
          version: s.version,
          description: s.description,
          status: s.status || 'active',
          statusReason: s.statusReason,
          tools: s.tools.map((t: any) => `${s.id}.${t.name}: ${t.description}`),
        }));

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(summary, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list tools: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'octipus_execute_tool',
    'Execute a specific tool on Octipus server. Use octipus_list_tools to see available tools. Example: tool_id="filesystem", tool_name="read_file", args={"path": "/etc/hostname"}',
    {
      tool_id: z.string().describe('Tool ID (e.g., "filesystem", "shell", "git", "docker", "websearch", "browser", "browser-ext", "knowledge")'),
      tool_name: z.string().describe('Tool name within the tool module (e.g., "read_file", "execute", "status", "get_tabs", "screenshot", "extract_content")'),
      args: z.record(z.unknown()).optional().default({}).describe('Arguments for the tool as a JSON object'),
    },
    async ({ tool_id, tool_name, args }) => {
      try {
        const result = await client.executeTool(tool_id, tool_name, args);
        return {
          content: [
            {
              type: 'text' as const,
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Tool execution failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
