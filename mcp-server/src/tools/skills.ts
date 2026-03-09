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

  server.tool(
    'assistant_create_skill',
    'Create a new domain knowledge skill with principles, best practices, anti-patterns, and frameworks.',
    {
      name: z.string().describe('Unique skill name (e.g., "cloud-infrastructure")'),
      description: z.string().describe('Short description of the skill domain'),
      category: z.string().optional().default('engineering').describe('Skill category (default: "engineering")'),
      principles: z.array(z.string()).optional().describe('Core principles for this domain'),
      bestPractices: z.array(z.string()).optional().describe('Recommended best practices'),
      antiPatterns: z.array(z.string()).optional().describe('Common anti-patterns to avoid'),
      frameworks: z.array(z.string()).optional().describe('Related frameworks or tools'),
    },
    async (params) => {
      try {
        const skill = await client.createSkill(params);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(skill, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create skill: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_update_skill',
    'Update an existing domain knowledge skill.',
    {
      skill_id: z.string().describe('Skill ID to update'),
      name: z.string().optional().describe('New skill name'),
      description: z.string().optional().describe('New description'),
      category: z.string().optional().describe('New category'),
      principles: z.array(z.string()).optional().describe('Updated principles'),
      bestPractices: z.array(z.string()).optional().describe('Updated best practices'),
      antiPatterns: z.array(z.string()).optional().describe('Updated anti-patterns'),
      frameworks: z.array(z.string()).optional().describe('Updated frameworks'),
    },
    async ({ skill_id, ...fields }) => {
      try {
        const skill = await client.updateSkill(skill_id, fields);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(skill, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to update skill: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_delete_skill',
    'Delete a custom domain knowledge skill.',
    {
      skill_id: z.string().describe('Skill ID to delete'),
    },
    async ({ skill_id }) => {
      try {
        await client.deleteSkill(skill_id);
        return {
          content: [{ type: 'text' as const, text: `Skill "${skill_id}" deleted successfully.` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to delete skill: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
