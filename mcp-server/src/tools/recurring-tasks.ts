/**
 * Recurring task management tools — CRUD for scheduled/cron tasks.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerRecurringTaskTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_list_recurring_tasks',
    'List all recurring/scheduled tasks. Shows name, schedule, status, last/next run time.',
    {},
    async () => {
      try {
        const tasks = await client.listRecurringTasks();
        if (tasks.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No recurring tasks configured.' }] };
        }
        const summary = tasks.map(t =>
          `- **${t.name}** [${t.cronExpression}] — ${t.isEnabled ? 'enabled' : 'disabled'}, runs: ${t.runCount}, next: ${t.nextRunAt || 'N/A'} [id: ${t.id}]`
        ).join('\n');
        return { content: [{ type: 'text' as const, text: summary }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'assistant_create_recurring_task',
    'Create a new recurring/scheduled task with a cron expression.',
    {
      name: z.string().describe('Task name'),
      cron_expression: z.string().describe('Cron expression (e.g., "*/30 * * * *" for every 30 min)'),
      action_type: z.string().describe('Action type: spawn_agent, execute_skill, or webhook'),
      action_config: z.string().describe('JSON string of action configuration'),
      description: z.string().optional().describe('Task description'),
      timezone: z.string().optional().describe('Timezone (default: UTC)'),
    },
    async ({ name, cron_expression, action_type, action_config, description, timezone }) => {
      try {
        const task = await client.createRecurringTask({
          name,
          cronExpression: cron_expression,
          actionType: action_type,
          actionConfig: JSON.parse(action_config),
          description,
          timezone,
        });
        return {
          content: [{
            type: 'text' as const,
            text: `Created recurring task "${task.name}" [${task.cronExpression}]\nNext run: ${task.nextRunAt}\nID: ${task.id}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'assistant_update_recurring_task',
    'Update a recurring task (enable/disable, change schedule, rename).',
    {
      task_id: z.string().describe('Task ID'),
      name: z.string().optional().describe('New name'),
      cron_expression: z.string().optional().describe('New cron expression'),
      is_enabled: z.boolean().optional().describe('Enable or disable the task'),
    },
    async ({ task_id, name, cron_expression, is_enabled }) => {
      try {
        const task = await client.updateRecurringTask(task_id, {
          name, cronExpression: cron_expression, isEnabled: is_enabled,
        });
        return {
          content: [{
            type: 'text' as const,
            text: `Updated task "${task.name}" — ${task.isEnabled ? 'enabled' : 'disabled'} [${task.cronExpression}]`,
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'assistant_delete_recurring_task',
    'Delete a recurring task by ID.',
    {
      task_id: z.string().describe('Task ID to delete'),
    },
    async ({ task_id }) => {
      try {
        await client.deleteRecurringTask(task_id);
        return { content: [{ type: 'text' as const, text: `Deleted recurring task ${task_id}` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
