/**
 * Chat tool — send a message to the assistant orchestrator and get a response.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerChatTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_chat',
    'Send a message to the assistant and get a response. The assistant will classify the message, route it to the appropriate model, and may use tools (web search, file operations, etc.) to fulfill the request.',
    {
      message: z.string().describe('The message to send to the assistant'),
      session_id: z.string().optional().describe('Session ID for conversation continuity. Omit to create a new session.'),
    },
    async ({ message, session_id }) => {
      try {
        const result = await client.chat(message, session_id);
        const meta = [
          `Session: ${result.sessionId}`,
          result.agentId ? `Agent: ${result.agentId}` : null,
          result.classification ? `Classification: ${result.classification}` : null,
        ]
          .filter(Boolean)
          .join(' | ');

        return {
          content: [
            {
              type: 'text' as const,
              text: `${result.response}\n\n---\n${meta}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Chat failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
