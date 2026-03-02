/**
 * Skill proxy tools — list available skills and execute any skill tool generically.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerSkillTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_list_skills',
    'List all available skills and their tools. Skills include: filesystem, shell, git, browser, websearch, docker.',
    {},
    async () => {
      try {
        const skills = await client.listSkills();
        // Format as a readable summary
        const summary = skills.map((s) => ({
          id: s.id,
          name: s.name,
          version: s.version,
          description: s.description,
          tools: s.tools.map((t) => `${s.id}.${t.name}: ${t.description}`),
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
          content: [{ type: 'text' as const, text: `Failed to list skills: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_execute_skill',
    'Execute a specific skill tool on the assistant server. Use assistant_list_skills to see available tools. Example: skill_id="filesystem", tool_name="read_file", args={"path": "/etc/hostname"}',
    {
      skill_id: z.string().describe('Skill ID (e.g., "filesystem", "shell", "git", "docker", "websearch", "browser")'),
      tool_name: z.string().describe('Tool name within the skill (e.g., "read_file", "execute", "status")'),
      args: z.record(z.unknown()).optional().default({}).describe('Arguments for the tool as a JSON object'),
    },
    async ({ skill_id, tool_name, args }) => {
      try {
        const result = await client.executeTool(skill_id, tool_name, args);
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
          content: [{ type: 'text' as const, text: `Skill execution failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
