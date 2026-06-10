/**
 * Email tools — process the user's inbox. Backed by the built-in
 * `email-processor` tool (Gmail / Outlook).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

function asText(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}
function asError(error: unknown) {
  return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
}

export function registerEmailTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_process_emails',
    'Fetch a batch of emails (with optional query + pagination) and return summaries.',
    {
      provider: z.enum(['gmail', 'outlook']).describe('Email provider'),
      query: z.string().optional().describe('Search query (default: is:unread)'),
      batchSize: z.number().optional().describe('How many to fetch (default: 5)'),
      pageToken: z.string().optional().describe('Continuation token from a previous call'),
    },
    async ({ provider, query, batchSize, pageToken }) => {
      try {
        return asText(await client.executeTool('email-processor', 'process_emails', {
          provider,
          query,
          batch_size: batchSize,
          page_token: pageToken,
        }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.tool(
    'octipus_get_email_summary',
    'Fetch and summarize a single email by id.',
    {
      provider: z.enum(['gmail', 'outlook']).describe('Email provider'),
      id: z.string().describe('Email id'),
    },
    async ({ provider, id }) => {
      try {
        return asText(await client.executeTool('email-processor', 'get_email_summary', { provider, id }));
      } catch (error) {
        return asError(error);
      }
    },
  );
}
