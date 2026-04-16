/**
 * Chat tool — send a message to the assistant orchestrator and get a response.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerChatTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_chat',
    'Send a message to the assistant and get a response. The assistant will classify the message, route it to the appropriate model, and may use tools (web search, file operations, etc.) to fulfill the request. Use expert_id to route to a specific expert. Use project_path to create a dev-mode session pinned to a project.',
    {
      message: z.string().describe('The message to send to the assistant'),
      session_id: z.string().optional().describe('Session ID for conversation continuity. Omit to create a new session.'),
      expert_id: z.string().optional().describe('Expert ID to route to a specific expert (e.g., coding, research). Use assistant_list_experts to see available experts.'),
      project_path: z.string().optional().describe('Absolute path to a project/repo to create a dev-mode session pinned to that project. Only used when session_id is not provided.'),
    },
    async ({ message, session_id, expert_id, project_path }) => {
      try {
        // Create dev-mode session if project_path is provided and no session exists
        let effectiveSessionId = session_id;
        if (!effectiveSessionId && project_path) {
          try {
            const projectName = project_path.replace(/\\/g, '/').split('/').pop() || 'project';
            const session = await client.createSession({
              channelType: 'webchat',
              title: `Dev: ${projectName}`,
              context: { devMode: true, projectPath: project_path, projectName },
            });
            effectiveSessionId = session.id;
          } catch {}
        }

        const result = await client.chat(message, effectiveSessionId, expert_id);
        const meta = [
          `Session: ${result.sessionId}`,
          result.agentId ? `Agent: ${result.agentId}` : null,
          result.classification ? `Classification: ${result.classification}` : null,
          result.metadata?.model ? `Model: ${result.metadata.model}` : null,
          result.metadata?.tokens != null ? `Tokens: ${result.metadata.tokens}` : null,
          result.metadata?.latencyMs != null ? `Latency: ${result.metadata.latencyMs}ms` : null,
          result.metadata?.cached ? `Cached: yes` : null,
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
