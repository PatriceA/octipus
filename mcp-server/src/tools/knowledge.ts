/**
 * Knowledge/RAG tools — search and index the knowledge base.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerKnowledgeTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_search_knowledge',
    'Search the assistant knowledge base (RAG) for relevant stored information.',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().describe('Max results (default: 5)'),
    },
    async ({ query, limit }) => {
      try {
        const result = await client.searchKnowledge(query, limit);
        if (!result.results || result.results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No relevant knowledge found.' }] };
        }
        const formatted = result.results.map((r: any, i: number) =>
          `**${i + 1}.** [${r.similarity}] ${r.sourceType}${r.filePath ? ` — ${r.filePath}` : ''}\n${r.content.slice(0, 500)}`
        ).join('\n\n');
        return { content: [{ type: 'text' as const, text: formatted }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'assistant_index_file',
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
