/**
 * Hook management tools — CRUD for scheduled tasks & event automations.
 * Replaces the old recurring-tasks tools. All hooks are managed through
 * the unified hooks system (schedule, webhook, message_received, etc.).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

export function registerRecurringTaskTools(server: McpServer, client: OctiClient): void {
  // ─── List hooks ───

  server.tool(
    'octipus_list_recurring_tasks',
    'List all hooks (scheduled tasks & event automations). Shows name, trigger, action, schedule, status, last/next run time.',
    {},
    async () => {
      try {
        const hooks = await client.listHooks();
        if (hooks.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No hooks configured.' }] };
        }
        const summary = hooks.map(h => {
          const cron = h.triggerConfig?.cronExpression ? ` [${h.triggerConfig.cronExpression}]` : '';
          return `- **${h.name}** (${h.trigger}→${h.action})${cron} — ${h.isEnabled ? 'enabled' : 'disabled'}, runs: ${h.executionCount}, next: ${h.nextRunAt || 'N/A'} [id: ${h.id}]`;
        }).join('\n');
        return { content: [{ type: 'text' as const, text: summary }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  // ─── Create hook ───

  server.tool(
    'octipus_create_recurring_task',
    `Create a new hook (scheduled task or event automation).

Triggers: schedule, webhook, message_received, agent_completed, agent_failed, tool_executed
Actions: notify, spawn_agent, webhook, execute_tool

For scheduled tasks, set trigger to "schedule" and include cronExpression in trigger_config.
For notify actions, set notifyOwner: true in action_config to notify the user on their linked channels.`,
    {
      name: z.string().describe('Hook name'),
      trigger: z.string().describe('Trigger type: schedule, webhook, message_received, agent_completed, agent_failed, tool_executed'),
      trigger_config: z.string().describe('JSON string of trigger config (e.g., {"cronExpression": "0 9 * * *"} for schedule)'),
      action: z.string().describe('Action type: notify, spawn_agent, webhook, execute_tool'),
      action_config: z.string().describe('JSON string of action config (e.g., {"notifyOwner": true, "notifyMessage": "Hello"})'),
      description: z.string().optional().describe('Hook description'),
      is_enabled: z.boolean().optional().describe('Enable immediately (default: true)'),
    },
    async ({ name, trigger, trigger_config, action, action_config, description, is_enabled }) => {
      try {
        const hook = await client.createHook({
          name,
          description,
          trigger,
          triggerConfig: JSON.parse(trigger_config),
          action,
          actionConfig: JSON.parse(action_config),
          isEnabled: is_enabled ?? true,
        });
        const nextRun = (hook as any).nextRunAt;
        return {
          content: [{
            type: 'text' as const,
            text: `Created hook "${name}" (${trigger}→${action})${nextRun ? `\nNext run: ${nextRun}` : ''}\nID: ${(hook as any).id}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  // ─── Update hook ───

  server.tool(
    'octipus_update_recurring_task',
    'Update a hook (rename, change schedule, enable/disable, change action config).',
    {
      hook_id: z.string().describe('Hook ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      trigger_config: z.string().optional().describe('JSON string of new trigger config'),
      action_config: z.string().optional().describe('JSON string of new action config'),
      is_enabled: z.boolean().optional().describe('Enable or disable'),
    },
    async ({ hook_id, name, description, trigger_config, action_config, is_enabled }) => {
      try {
        const update: Record<string, unknown> = {};
        if (name !== undefined) update.name = name;
        if (description !== undefined) update.description = description;
        if (trigger_config !== undefined) update.triggerConfig = JSON.parse(trigger_config);
        if (action_config !== undefined) update.actionConfig = JSON.parse(action_config);
        if (is_enabled !== undefined) update.isEnabled = is_enabled;

        const hook = await client.updateHook(hook_id, update);
        return {
          content: [{
            type: 'text' as const,
            text: `Updated hook "${(hook as any).name}" — ${(hook as any).isEnabled ? 'enabled' : 'disabled'}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  // ─── Delete hook ───

  server.tool(
    'octipus_delete_recurring_task',
    'Delete a hook by ID.',
    {
      hook_id: z.string().describe('Hook ID to delete'),
    },
    async ({ hook_id }) => {
      try {
        await client.deleteHook(hook_id);
        return { content: [{ type: 'text' as const, text: `Deleted hook ${hook_id}` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  // ─── Toggle hook ───

  server.tool(
    'octipus_toggle_hook',
    'Enable or disable a hook.',
    {
      hook_id: z.string().describe('Hook ID'),
      enabled: z.boolean().describe('true to enable, false to disable'),
    },
    async ({ hook_id, enabled }) => {
      try {
        await client.toggleHook(hook_id, enabled);
        return { content: [{ type: 'text' as const, text: `Hook ${hook_id} ${enabled ? 'enabled' : 'disabled'}` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
