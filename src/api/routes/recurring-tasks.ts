import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { scopedRepos } from '@/db/repositories/scoped';
import { getHookManager } from '@/hooks/manager';
import { isAuthenticated } from '@/security/principal';

/**
 * Recurring tasks API — compatibility layer over schedule-triggered hooks.
 *
 * Phase 1a: scope every per-id lookup through `scopedRepos(principal).hooks`.
 * The previous handlers each did a manual `if (!user.isAdmin && hook.userId
 * !== user.id) return 'Not authorized'`; cross-tenant ids now surface as
 * "Task not found" so they're indistinguishable from real misses.
 */
export const recurringTaskRoutes = new Elysia({ prefix: '/recurring-tasks' })
  .use(apiContext)

  .get('/', async ({ user, principal }) => {
    if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
    const allHooks = await scopedRepos(principal).hooks.listOwn();
    const tasks = allHooks
      .filter(h => h.trigger === 'schedule')
      .map(hookToTask);
    return { tasks };
  }, { detail: { tags: ['recurring-tasks'] } })

  .get('/:id', async ({ user, principal, params }) => {
    if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
    const hook = await scopedRepos(principal).hooks.findById(params.id);
    if (!hook || hook.trigger !== 'schedule') return { error: 'Task not found' };
    return { task: hookToTask(hook) };
  }, { params: t.Object({ id: t.String() }), detail: { tags: ['recurring-tasks'] } })

  .post('/', async ({ user, body }) => {
    if (!user) return { error: 'Not authenticated' };
    const hookManager = getHookManager();

    const hook = await hookManager.createHook({
      userId: user.id,
      name: body.name,
      description: body.description,
      trigger: 'schedule',
      triggerConfig: {
        cronExpression: body.cronExpression,
        timezone: body.timezone || 'UTC',
      },
      action: (body.actionType === 'spawn_agent' || body.actionType === 'execute_tool' || body.actionType === 'webhook')
        ? body.actionType
        : 'spawn_agent',
      actionConfig: body.actionConfig,
      isEnabled: true,
    });

    return { task: hookToTask(hook) };
  }, {
    body: t.Object({
      name: t.String({ minLength: 1 }),
      description: t.Optional(t.String()),
      cronExpression: t.String({ minLength: 1 }),
      timezone: t.Optional(t.String()),
      actionType: t.String({ minLength: 1 }),
      actionConfig: t.Any(),
    }),
    detail: { tags: ['recurring-tasks'] },
  })

  .patch('/:id', async ({ user, principal, params, body }) => {
    if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
    const existing = await scopedRepos(principal).hooks.findById(params.id);
    if (!existing || existing.trigger !== 'schedule') return { error: 'Task not found' };

    const updateData: Record<string, unknown> = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.isEnabled !== undefined) {
      updateData.isEnabled = body.isEnabled;
      if (body.isEnabled) updateData.lastError = null;
    }
    if (body.cronExpression !== undefined) {
      updateData.triggerConfig = {
        ...existing.triggerConfig,
        cronExpression: body.cronExpression,
        timezone: body.timezone || existing.triggerConfig?.timezone || 'UTC',
      };
    }

    const hookManager = getHookManager();
    const hook = await hookManager.updateHook(params.id, updateData as any);
    if (!hook) return { error: 'Task not found' };
    return { task: hookToTask(hook) };
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      name: t.Optional(t.String()),
      description: t.Optional(t.String()),
      cronExpression: t.Optional(t.String()),
      timezone: t.Optional(t.String()),
      isEnabled: t.Optional(t.Boolean()),
    }),
    detail: { tags: ['recurring-tasks'] },
  })

  .get('/:id/executions', async ({ user, principal, params, query }) => {
    if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
    const hook = await scopedRepos(principal).hooks.findById(params.id);
    if (!hook || hook.trigger !== 'schedule') return { error: 'Task not found' };

    const limit = query.limit ? parseInt(query.limit as string, 10) : 20;
    const offset = query.offset ? parseInt(query.offset as string, 10) : 0;

    const hookManager = getHookManager();
    const { executions, total } = await hookManager.getExecutions({
      hookId: params.id,
      limit,
      offset,
    });

    return { executions, total };
  }, {
    params: t.Object({ id: t.String() }),
    query: t.Object({
      limit: t.Optional(t.String()),
      offset: t.Optional(t.String()),
    }),
    detail: { tags: ['recurring-tasks'] },
  })

  .delete('/:id', async ({ user, principal, params }) => {
    if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
    const existing = await scopedRepos(principal).hooks.findById(params.id);
    if (!existing || existing.trigger !== 'schedule') return { error: 'Task not found' };

    const hookManager = getHookManager();
    const deleted = await hookManager.deleteHook(params.id);
    return { deleted };
  }, { params: t.Object({ id: t.String() }), detail: { tags: ['recurring-tasks'] } });


/** Map a schedule hook to the old recurring task shape */
function hookToTask(hook: any) {
  return {
    id: hook.id,
    userId: hook.userId,
    name: hook.name,
    description: hook.description,
    cronExpression: hook.triggerConfig?.cronExpression || '',
    timezone: hook.triggerConfig?.timezone || 'UTC',
    actionType: hook.action,
    actionConfig: hook.actionConfig,
    isEnabled: hook.isEnabled,
    lastRunAt: hook.lastExecutedAt,
    nextRunAt: hook.nextRunAt,
    runCount: hook.executionCount,
    lastError: hook.lastError,
    status: !hook.isEnabled ? 'paused' : hook.lastError ? 'error' : 'active',
    createdAt: hook.createdAt,
    updatedAt: hook.updatedAt,
  };
}
