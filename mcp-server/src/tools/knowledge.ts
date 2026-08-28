/**
 * Knowledge/RAG tools — search, read, and index the knowledge base.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

export function registerKnowledgeTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_search_knowledge',
    'Search Octipus knowledge base using hybrid search (semantic + keyword). Returns abstracts — use read_knowledge for full content.',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().describe('Max results (default: 5)'),
      mode: z.enum(['hybrid', 'semantic', 'keyword']).optional().describe('Search mode (default: hybrid)'),
    },
    async ({ query, limit, mode }) => {
      try {
        const result = await client.searchKnowledge(query, limit, mode);
        if (!result.results || result.results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No relevant knowledge found.' }] };
        }
        const formatted = result.results.map((r: any, i: number) =>
          `**${i + 1}.** [${r.similarity}] ${r.purpose ?? r.sourceType ?? "document"}${r.filePath ? ` — ${r.filePath}` : ''}\nID: ${r.id}\n${r.abstract || r.content?.slice(0, 200)}`
        ).join('\n\n');
        return { content: [{ type: 'text' as const, text: `${formatted}\n\n_Use octipus_read_knowledge with an ID to get full content._` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'octipus_read_knowledge',
    'Read the full content of a knowledge entry by its ID (from search results).',
    {
      id: z.string().describe('Knowledge entry ID from search results'),
    },
    async ({ id }) => {
      try {
        const result = await client.readKnowledge(id);
        if (result.error) {
          return { content: [{ type: 'text' as const, text: result.error }] };
        }
        const header = `**${result.purpose ?? result.sourceType ?? "document"}**${result.filePath ? ` — ${result.filePath}` : ''}`;
        return { content: [{ type: 'text' as const, text: `${header}\n\n${result.content}` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'octipus_index_file',
    'Index a file into the knowledge base for future RAG retrieval.',
    {
      path: z.string().describe('Absolute path to the file'),
      type: z.string().optional().describe('Source type: document or code (default: document)'),
    },
    async ({ path, type }) => {
      try {
        const result = await client.indexFile(path, type);
        return {
          content: [{
            type: 'text' as const,
            text: `Indexed ${path}: ${result.chunks} chunks stored`,
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
