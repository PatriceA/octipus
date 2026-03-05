/**
 * Skills tools — list and inspect domain knowledge skills.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerSkillTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_list_skills',
    'List all domain knowledge skills available to experts. Skills contain principles, best practices, and anti-patterns for domains like architecture, testing, security, etc.',
    {},
    async () => {
      try {
        const skills = await client.listSkills();
        const summary = skills.map((s) => `- **${s.name}** (${s.category}): ${s.description}`).join('\n');
        return {
          content: [{ type: 'text' as const, text: summary || 'No skills found.' }],
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
    'assistant_get_skill',
    'Get full details of a domain knowledge skill including principles, best practices, anti-patterns, and frameworks.',
    {
      skill_id: z.string().describe('Skill ID (e.g., "software-architecture", "security-practices")'),
    },
    async ({ skill_id }) => {
      try {
        const skill = await client.getSkill(skill_id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(skill, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get skill: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
