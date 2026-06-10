/**
 * Memory tools — the user's long-term facts. Read/forget via the memory API.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

export function registerMemoryTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_list_memories',
    "List the user's long-term memory facts, newest first.",
    {
      factType: z.string().optional().describe('Filter by fact type'),
      limit: z.number().optional().describe('Max rows (default 100, max 500)'),
      includeHistory: z.boolean().optional().describe('Include superseded (historical) facts'),
    },
    async ({ factType, limit, includeHistory }) => {
      try {
        const res = await client.listMemories({ factType, limit, includeHistory });
        if (!res.memories?.length) {
          return { content: [{ type: 'text' as const, text: 'No memories stored.' }] };
        }
        const formatted = res.memories
          .map((m) => `- [${m.factType}] ${m.content} (id: ${m.id})`)
          .join('\n');
        return { content: [{ type: 'text' as const, text: `${res.total} memories:\n${formatted}` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'octipus_forget_memory',
    'Delete a long-term memory fact by id.',
    { id: z.string().describe('Memory id') },
    async ({ id }) => {
      try {
        // deleteMemory throws on a 404 (not-found), so reaching here means it
        // was deleted.
        await client.deleteMemory(id);
        return { content: [{ type: 'text' as const, text: `Deleted memory ${id}` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
