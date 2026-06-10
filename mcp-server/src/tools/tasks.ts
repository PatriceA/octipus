/**
 * Tasks / to-do tools — the user's task list shown in the Tasks tab.
 * Backed by the built-in `tasks` tool.
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

export function registerTasksTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_list_tasks',
    "List the user's tasks (the Tasks tab), optionally filtered by status or due-today.",
    {
      status: z.enum(['open', 'done', 'archived']).optional().describe('Filter by status'),
      dueToday: z.boolean().optional().describe('Only tasks due by end of today'),
    },
    async ({ status, dueToday }) => {
      try {
        return asText(await client.executeTool('tasks', 'list_tasks', { status, dueToday }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.tool(
    'octipus_create_task',
    "Add a task to the user's to-do list.",
    {
      title: z.string().describe('Task title'),
      notes: z.string().optional().describe('Optional details'),
      priority: z.number().min(0).max(3).optional().describe('Priority 0 (none) to 3 (high)'),
      dueAt: z.string().optional().describe('Due date/time, ISO 8601'),
    },
    async ({ title, notes, priority, dueAt }) => {
      try {
        return asText(await client.executeTool('tasks', 'create_task', { title, notes, priority, dueAt, source: 'agent' }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.tool(
    'octipus_update_task',
    'Update an existing task (title, notes, status, priority, or due date).',
    {
      id: z.string().describe('Task id'),
      title: z.string().optional(),
      notes: z.string().optional(),
      status: z.enum(['open', 'done', 'archived']).optional(),
      priority: z.number().min(0).max(3).optional(),
      dueAt: z.string().optional().describe('Due date/time, ISO 8601'),
    },
    async ({ id, title, notes, status, priority, dueAt }) => {
      try {
        return asText(await client.executeTool('tasks', 'update_task', { id, title, notes, status, priority, dueAt }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.tool(
    'octipus_complete_task',
    'Mark a task as done.',
    { id: z.string().describe('Task id') },
    async ({ id }) => {
      try {
        return asText(await client.executeTool('tasks', 'complete_task', { id }));
      } catch (error) {
        return asError(error);
      }
    },
  );
}
