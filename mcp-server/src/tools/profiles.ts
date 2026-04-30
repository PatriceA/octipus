/**
 * Profiles tools — manage people, organizations, and pet profiles with facts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

export function registerProfileTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_list_profiles',
    'List all people/organization/pet profiles stored for the current user.',
    {},
    async () => {
      try {
        const result = await client.executeTool('profiles', 'list_profiles', {}) as any;
        const profiles = result?.profiles || result;
        if (!Array.isArray(profiles) || profiles.length === 0) {
          return {
            content: [{ type: 'text' as const, text: result?.message || 'No profiles found.' }],
          };
        }
        const summary = profiles.map(
          (p: any) => `- **${p.name}** (${p.category}${p.relationship ? `, ${p.relationship}` : ''}) — ${p.factCount ?? 0} facts [ID: ${p.id}]`,
        ).join('\n');
        return {
          content: [{ type: 'text' as const, text: summary }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list profiles: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'octipus_get_profile',
    'Get a profile by ID or name. Returns full details including all stored facts.',
    {
      id: z.string().optional().describe('Profile ID (UUID)'),
      name: z.string().optional().describe('Profile name (fuzzy search)'),
    },
    async ({ id, name }) => {
      try {
        const args: Record<string, unknown> = {};
        if (id) args.id = id;
        if (name) args.name = name;
        const result = await client.executeTool('profiles', 'get_profile', args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get profile: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'octipus_create_profile',
    'Create a new profile for a person, organization, or pet.',
    {
      name: z.string().describe('Name of the person or entity'),
      relationship: z.string().optional().describe('Relationship to user (e.g., friend, colleague, mother, partner)'),
      category: z.string().optional().default('person').describe('Category: person, organization, or pet (default: person)'),
    },
    async ({ name, relationship, category }) => {
      try {
        const args: Record<string, unknown> = { name };
        if (relationship) args.relationship = relationship;
        if (category) args.category = category;
        const result = await client.executeTool('profiles', 'create_profile', args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create profile: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'octipus_add_profile_fact',
    'Add or update a fact on a profile. If the key already exists, it is replaced.',
    {
      id: z.string().describe('Profile ID (UUID)'),
      key: z.string().describe('Fact key (e.g., location, birthday, likes, email, phone, job, hobby)'),
      value: z.string().describe('Fact value'),
      source: z.string().optional().describe('How this fact was learned (default: "user told us")'),
    },
    async ({ id, key, value, source }) => {
      try {
        const args: Record<string, unknown> = { id, key, value };
        if (source) args.source = source;
        const result = await client.executeTool('profiles', 'add_fact', args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to add fact: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'octipus_search_profiles',
    'Search profiles by name or fact values. Use this to find people by any attribute.',
    {
      query: z.string().describe('Search query (matches name and fact values)'),
    },
    async ({ query }) => {
      try {
        const result = await client.executeTool('profiles', 'search_profiles', { query }) as any;
        const profiles = result?.profiles || result;
        if (!Array.isArray(profiles) || profiles.length === 0) {
          return {
            content: [{ type: 'text' as const, text: result?.message || 'No profiles found matching the query.' }],
          };
        }
        const formatted = profiles.map(
          (p: any) => {
            const facts = (p.facts || []).map((f: any) => `${f.key}: ${f.value}`).join(', ');
            return `- **${p.name}** (${p.category}${p.relationship ? `, ${p.relationship}` : ''}) [ID: ${p.id}]${facts ? `\n  Facts: ${facts}` : ''}`;
          },
        ).join('\n');
        return {
          content: [{ type: 'text' as const, text: formatted }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to search profiles: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
