/**
 * Agent management tools — spawn, monitor, message, and stop agents.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerAgentTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_list_agents',
    'List all running agents with their status, model, and topic.',
    {},
    async () => {
      try {
        const agents = await client.listAgents();
        return {
          content: [
            {
              type: 'text' as const,
              text: agents.length > 0
                ? JSON.stringify(agents, null, 2)
                : 'No agents currently running.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list agents: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_spawn_agent',
    'Spawn a new agent to handle a task. The agent runs autonomously with access to tools (web search, filesystem, shell, etc.).',
    {
      message: z.string().describe('The task or question for the agent'),
      model: z.string().optional().describe('Model to use (e.g., "qwen3:14b", "gemma3:12b"). Uses default if not specified.'),
      topic: z.string().optional().describe('Topic hint for routing (e.g., "research", "coding", "analysis")'),
    },
    async ({ message, model, topic }) => {
      try {
        const agent = await client.spawnAgent(message, model, topic);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                agentId: agent.id,
                sessionId: agent.sessionId,
                model: agent.model,
                topic: agent.topic,
                status: agent.status,
                message: `Agent spawned. Use assistant_get_agent_events with agentId "${agent.id}" to monitor progress.`,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to spawn agent: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_stop_agent',
    'Stop a running agent by its ID.',
    {
      agent_id: z.string().describe('The agent ID to stop'),
    },
    async ({ agent_id }) => {
      try {
        await client.stopAgent(agent_id);
        return {
          content: [{ type: 'text' as const, text: `Agent ${agent_id} stopped.` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to stop agent: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_send_agent_message',
    'Send a message to a running agent and get its response.',
    {
      agent_id: z.string().describe('The agent ID to message'),
      message: z.string().describe('Message to send'),
    },
    async ({ agent_id, message }) => {
      try {
        const result = await client.sendMessage(agent_id, message);
        return {
          content: [{ type: 'text' as const, text: result.response }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to message agent: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_get_agent_events',
    'Get events from an agent (tool calls, thoughts, results). Use `after_seq` for incremental polling.',
    {
      agent_id: z.string().describe('The agent ID'),
      after_seq: z.number().optional().describe('Only return events after this sequence number (for polling)'),
    },
    async ({ agent_id, after_seq }) => {
      try {
        const events = await client.getAgentEvents(agent_id, after_seq);
        return {
          content: [
            {
              type: 'text' as const,
              text: events.length > 0
                ? JSON.stringify(events, null, 2)
                : 'No new events.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get events: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
