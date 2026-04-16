/**
 * Expert agent tools — list available experts and chat using a specific expert.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerExpertTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_list_experts',
    'List available expert agents. Experts are pre-configured agent roles (Researcher, Coder, Reviewer, etc.) with domain knowledge that bypass the orchestrator for direct, focused task execution.',
    {},
    async () => {
      try {
        const experts = await client.listExperts();
        if (experts.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No experts available.' }],
          };
        }
        const summary = experts.map(p =>
          `- **${p.name}** (${p.role}) ${p.icon ? `[${p.icon}]` : ''} — ${p.description || 'No description'} [id: ${p.id}]`
        ).join('\n');
        return {
          content: [{ type: 'text' as const, text: summary }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list experts: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_chat_with_expert',
    'Send a message using a specific expert agent. This bypasses the orchestrator and routes directly to a specialized worker (e.g., Researcher, Coder, Reviewer). Use assistant_list_experts to get available expert IDs.',
    {
      message: z.string().describe('The message or task to send'),
      expert_id: z.string().describe('The expert ID to use (from assistant_list_experts)'),
      session_id: z.string().optional().describe('Session ID for conversation continuity'),
    },
    async ({ message, expert_id, session_id }) => {
      try {
        const result = await client.chatWithExpert(message, expert_id, session_id);
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
          content: [{ type: 'text' as const, text: `Expert chat failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
