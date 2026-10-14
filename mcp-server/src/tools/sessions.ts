/**
 * Session and conversation tools — browse history and messages.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

/**
 * A reply's interactive answer is stored apart and shown in the Octipus web app;
 * the message keeps a marker line `[[octi-ui:<id>|<title>]]`. An MCP client gets
 * the readable line the other non-web surfaces get.
 */
const INLINE_UI_MARKER = /^\[\[octi-ui:[0-9a-f-]{36}\|([^\]\n]*)\]\]$/gim;

export function withInlineUiLines(content: string): string {
  return content.replace(INLINE_UI_MARKER, (_m, title: string) => `▸ Interactive answer “${title}” — open this conversation in the Octipus web app to use it.`);
}

export function registerSessionTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_list_sessions',
    'List recent chat sessions with their channel, status, and message count.',
    {
      limit: z.number().optional().default(20).describe('Maximum number of sessions to return (default: 20)'),
    },
    async ({ limit }) => {
      try {
        const sessions = await client.listSessions(limit);
        return {
          content: [
            {
              type: 'text' as const,
              text: sessions.length > 0
                ? JSON.stringify(sessions, null, 2)
                : 'No sessions found.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list sessions: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'octipus_get_messages',
    'Get messages from a specific session. Useful for reviewing conversation history.',
    {
      session_id: z.string().describe('The session ID'),
      limit: z.number().optional().default(50).describe('Maximum number of messages (default: 50)'),
      offset: z.number().optional().default(0).describe('Offset for pagination (default: 0)'),
    },
    async ({ session_id, limit, offset }) => {
      try {
        const messages = (await client.getSessionMessages(session_id, limit, offset))
          .map((m) => (m.role === 'assistant' && typeof m.content === 'string' ? { ...m, content: withInlineUiLines(m.content) } : m));
        return {
          content: [
            {
              type: 'text' as const,
              text: messages.length > 0
                ? JSON.stringify(messages, null, 2)
                : 'No messages in this session.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get messages: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
