/**
 * Web search tools — search the web and fetch pages via Octipus's SearXNG integration.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

export function registerSearchTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_search',
    'Search the web using Octipus\'s SearXNG search engine. Returns results with titles, URLs, and snippets.',
    {
      query: z.string().describe('Search query'),
      max_results: z.number().optional().default(10).describe('Maximum number of results (default: 10)'),
    },
    async ({ query, max_results }) => {
      try {
        const result = await client.search(query, max_results);
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
          content: [{ type: 'text' as const, text: `Search failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'octipus_fetch_page',
    'Fetch a web page and extract its text content. Uses a real browser for JavaScript-rendered pages.',
    {
      url: z.string().url().describe('URL to fetch'),
      max_length: z.number().optional().default(10000).describe('Maximum text length to return (default: 10000)'),
    },
    async ({ url, max_length }) => {
      try {
        const result = await client.fetchPage(url, max_length);
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
          content: [{ type: 'text' as const, text: `Page fetch failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
