/**
 * Preset agent tools — list available presets and chat using a specific preset.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerPresetTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_list_presets',
    'List available agent presets. Presets are pre-configured agent roles (Researcher, Coder, Reviewer, etc.) that bypass the orchestrator for direct, focused task execution.',
    {},
    async () => {
      try {
        const presets = await client.listPresets();
        if (presets.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No presets available.' }],
          };
        }
        const summary = presets.map(p =>
          `- **${p.name}** (${p.role}) ${p.icon ? `[${p.icon}]` : ''} — ${p.description || 'No description'} [id: ${p.id}]`
        ).join('\n');
        return {
          content: [{ type: 'text' as const, text: summary }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list presets: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_chat_with_preset',
    'Send a message using a specific agent preset. This bypasses the orchestrator and routes directly to a specialized worker (e.g., Researcher, Coder, Reviewer). Use assistant_list_presets to get available preset IDs.',
    {
      message: z.string().describe('The message or task to send'),
      preset_id: z.string().describe('The preset ID to use (from assistant_list_presets)'),
      session_id: z.string().optional().describe('Session ID for conversation continuity'),
    },
    async ({ message, preset_id, session_id }) => {
      try {
        const result = await client.chatWithPreset(message, preset_id, session_id);
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
          content: [{ type: 'text' as const, text: `Preset chat failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
