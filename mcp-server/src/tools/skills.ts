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
    'Create a new domain knowledge skill. Supports two modes: (1) Markdown content — paste a Claude Code-style .md skill definition into the "content" field, or (2) Structured — provide principles, best practices, anti-patterns, and frameworks as arrays. When content is set, it takes priority over structured fields.',
    {
      name: z.string().describe('Unique skill name (e.g., "cloud-infrastructure")'),
      description: z.string().describe('Short description of the skill domain'),
      category: z.string().optional().default('engineering').describe('Skill category (default: "engineering")'),
      content: z.string().optional().describe('Markdown content — paste a full skill definition here (Claude Code .md format). When set, this is used directly as the skill prompt instead of structured fields.'),
      principles: z.array(z.string()).optional().describe('Core principles for this domain (structured mode)'),
      bestPractices: z.array(z.string()).optional().describe('Recommended best practices (structured mode)'),
      antiPatterns: z.array(z.string()).optional().describe('Common anti-patterns to avoid (structured mode)'),
      frameworks: z.array(z.string()).optional().describe('Related frameworks or tools (structured mode)'),
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
    'Update an existing domain knowledge skill. Can update markdown content and/or structured fields.',
    {
      skill_id: z.string().describe('Skill ID to update'),
      name: z.string().optional().describe('New skill name'),
      description: z.string().optional().describe('New description'),
      category: z.string().optional().describe('New category'),
      content: z.string().optional().describe('Markdown content — paste a full skill definition (Claude Code .md format). Set to empty string to clear and use structured fields instead.'),
      principles: z.array(z.string()).optional().describe('Updated principles (structured mode)'),
      bestPractices: z.array(z.string()).optional().describe('Updated best practices (structured mode)'),
      antiPatterns: z.array(z.string()).optional().describe('Updated anti-patterns (structured mode)'),
      frameworks: z.array(z.string()).optional().describe('Updated frameworks (structured mode)'),
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
