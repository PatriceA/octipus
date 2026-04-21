import type { ToolManifest } from '@/core/types';
import { getHookManager } from '@/hooks/manager';
import { BaseTool, createParameterSchema } from '../base-tool';

export class SchedulingTool extends BaseTool {
  readonly id = 'scheduling';
  readonly name = 'Scheduling';
  readonly version = '1.0.0';
  readonly description = 'Create, list, update, and delete scheduled tasks (hooks). Use this instead of writing cron scripts.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'List hooks and tasks', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Create, update, delete hooks', defaultLevel: 'ASK' },
      ],
      tools: [
        { name: 'list_hooks', description: 'List all scheduled tasks/hooks for the current user', parameters: {}, returns: 'List of hooks' },
        { name: 'create_hook', description: 'Create a new scheduled task or event hook', parameters: { name: { type: 'string', description: 'Hook name', required: true }, trigger: { type: 'string', description: 'Trigger type', required: true }, action: { type: 'string', description: 'Action type', required: true } }, returns: 'Created hook' },
        { name: 'update_hook', description: 'Update an existing hook', parameters: { id: { type: 'string', description: 'Hook ID', required: true } }, returns: 'Updated hook' },
        { name: 'delete_hook', description: 'Delete a hook', parameters: { id: { type: 'string', description: 'Hook ID', required: true } }, returns: 'Deletion result' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'list_hooks',
      'List all hooks/scheduled tasks for the current user. Returns name, trigger, schedule, status, last run.',
      createParameterSchema({}),
      async (_args, context) => {
        const hookManager = getHookManager();
        const hooks = await hookManager.getUserHooks(context.userId);

        if (hooks.length === 0) {
          return { hooks: [], message: 'No hooks configured.' };
        }

        return {
          hooks: hooks.map(h => ({
            id: h.id,
            name: h.name,
            description: h.description,
            trigger: h.trigger,
            triggerConfig: h.triggerConfig,
            action: h.action,
            actionConfig: h.actionConfig,
            isEnabled: h.isEnabled,
            executionCount: h.executionCount,
            lastExecutedAt: h.lastExecutedAt,
            nextRunAt: h.nextRunAt,
            lastError: h.lastError,
          })),
        };
      },
      { permissionAction: 'read' },
    );

    this.registerTool(
      'create_hook',
      'Create a new hook (scheduled task or event-triggered automation). For scheduled tasks, provide a cron expression. The hook will notify the user on their linked channels by default.',
      createParameterSchema({
        name: { type: 'string', description: 'Hook name', required: true },
        description: { type: 'string', description: 'What this hook does' },
        trigger: { type: 'string', description: 'Trigger type: schedule, webhook, message_received, agent_completed, agent_failed, tool_executed', required: true },
        cron_expression: { type: 'string', description: 'Cron expression for schedule triggers (e.g. "*/30 * * * *", "0 9 * * *", "0 9 * * 1-5")' },
        action: { type: 'string', description: 'Action type: notify, spawn_agent, webhook, execute_tool', required: true },
        notify_message: { type: 'string', description: 'Message template for notify action. Use {{field.path}} for variables.' },
        agent_prompt: { type: 'string', description: 'Prompt for spawn_agent action' },
        orchestrated: { type: 'boolean', description: 'Route through orchestrator (for spawn_agent)', default: true },
        max_executions: { type: 'number', description: 'Maximum number of times to execute (1 = one-time event, null = unlimited)' },
        is_enabled: { type: 'boolean', description: 'Enable the hook immediately', default: true },
      }),
      async (args, context) => {
        const hookManager = getHookManager();

        const trigger = args.trigger as string;
        const action = args.action as string;

        const triggerConfig: Record<string, unknown> = {};
        if (trigger === 'schedule' && args.cron_expression) {
          triggerConfig.cronExpression = args.cron_expression;
        }

        const actionConfig: Record<string, unknown> = {};
        if (action === 'notify') {
          actionConfig.notifyOwner = true;
          if (args.notify_message) actionConfig.notifyMessage = args.notify_message;
        }
        if (action === 'spawn_agent') {
          if (args.agent_prompt) actionConfig.agentPrompt = args.agent_prompt;
          actionConfig.orchestrated = args.orchestrated !== false;
          actionConfig.notifyOwner = true;
        }

        const hook = await hookManager.createHook({
          userId: context.userId,
          name: args.name as string,
          description: (args.description as string) || null,
          trigger: trigger as any,
          triggerConfig,
          action: action as any,
          actionConfig,
          isEnabled: args.is_enabled !== false,
          ...(args.max_executions != null ? { maxExecutions: args.max_executions as number } : {}),
        });

        return {
          id: hook.id,
          name: hook.name,
          trigger: hook.trigger,
          action: hook.action,
          isEnabled: hook.isEnabled,
          nextRunAt: hook.nextRunAt,
          message: `Created hook "${hook.name}"${hook.nextRunAt ? ` — next run: ${hook.nextRunAt}` : ''}`,
        };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'update_hook',
      'Update an existing hook. Only provided fields are changed.',
      createParameterSchema({
        id: { type: 'string', description: 'Hook ID', required: true },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        cron_expression: { type: 'string', description: 'New cron expression (for schedule hooks)' },
        is_enabled: { type: 'boolean', description: 'Enable or disable' },
        notify_message: { type: 'string', description: 'New message template (for notify action)' },
        agent_prompt: { type: 'string', description: 'New agent prompt (for spawn_agent action)' },
      }),
      async (args, context) => {
        const hookManager = getHookManager();
        const existing = await hookManager.getHook(args.id as string);

        if (!existing) return { error: 'Hook not found' };
        if (existing.userId !== context.userId) return { error: 'Not authorized' };

        const update: Record<string, unknown> = {};
        if (args.name) update.name = args.name;
        if (args.description !== undefined) update.description = args.description;
        if (args.is_enabled !== undefined) update.isEnabled = args.is_enabled;

        if (args.cron_expression) {
          update.triggerConfig = { ...existing.triggerConfig, cronExpression: args.cron_expression };
        }
        if (args.notify_message !== undefined) {
          update.actionConfig = { ...existing.actionConfig, notifyMessage: args.notify_message };
        }
        if (args.agent_prompt !== undefined) {
          update.actionConfig = { ...(update.actionConfig || existing.actionConfig), agentPrompt: args.agent_prompt };
        }

        const hook = await hookManager.updateHook(args.id as string, update);

        return {
          id: hook?.id,
          name: hook?.name,
          isEnabled: hook?.isEnabled,
          message: `Updated hook "${hook?.name}"`,
        };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'delete_hook',
      'Delete a hook by ID.',
      createParameterSchema({
        id: { type: 'string', description: 'Hook ID to delete', required: true },
      }),
      async (args, context) => {
        const hookManager = getHookManager();
        const existing = await hookManager.getHook(args.id as string);

        if (!existing) return { error: 'Hook not found' };
        if (existing.userId !== context.userId) return { error: 'Not authorized' };

        const deleted = await hookManager.deleteHook(args.id as string);
        return { deleted, message: deleted ? `Deleted hook "${existing.name}"` : 'Failed to delete' };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'toggle_hook',
      'Enable or disable a hook.',
      createParameterSchema({
        id: { type: 'string', description: 'Hook ID', required: true },
        enabled: { type: 'boolean', description: 'true to enable, false to disable', required: true },
      }),
      async (args, context) => {
        const hookManager = getHookManager();
        const existing = await hookManager.getHook(args.id as string);

        if (!existing) return { error: 'Hook not found' };
        if (existing.userId !== context.userId) return { error: 'Not authorized' };

        await hookManager.setEnabled(args.id as string, args.enabled as boolean);
        return { id: args.id, enabled: args.enabled, message: `Hook "${existing.name}" ${args.enabled ? 'enabled' : 'disabled'}` };
      },
      { permissionAction: 'write' },
    );
  }
}

export const schedulingTool = new SchedulingTool();
