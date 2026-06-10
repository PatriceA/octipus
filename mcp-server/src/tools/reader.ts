/**
 * Reader tools — fetch a URL into a clean, sanitized article and run AI
 * actions on it (summarize / simplify / translate / action_items / ask).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

export function registerReaderTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_read_url',
    'Fetch a URL and return a clean, reader-formatted article (title, text, byline).',
    { url: z.string().describe('The URL to read') },
    async ({ url }) => {
      try {
        const doc = await client.readUrl(url);
        return { content: [{ type: 'text' as const, text: JSON.stringify(doc, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'octipus_reader_action',
    'Run an AI action on a URL (fetched + extracted) or on supplied text.',
    {
      action: z.enum(['summarize', 'simplify', 'translate', 'action_items', 'ask']).describe('The action to run'),
      url: z.string().optional().describe('URL to act on (or supply text)'),
      text: z.string().optional().describe('Text to act on (or supply url)'),
      argument: z.string().optional().describe('Target language (translate) or question (ask)'),
    },
    async ({ action, url, text, argument }) => {
      try {
        const res = await client.readerAction(action, { url, text, argument });
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
