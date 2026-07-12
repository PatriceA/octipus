import { desc, eq, or, sql } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getDb } from '@/db/postgres';
import { scopedRepos } from '@/db/repositories/scoped';
import { hookExecutions } from '@/db/schema/hook-executions';
import { hooks as hooksTable } from '@/db/schema/hooks';
import { recurringTasks } from '@/db/schema/recurring-tasks';
import { getHookManager } from '@/hooks/manager';
import { getHookSuggestions } from '@/hooks/suggestions';
import { isAuthenticated } from '@/security/principal';

const VALID_TRIGGERS = ['message_received', 'agent_started', 'agent_completed', 'agent_failed', 'tool_executed', 'permission_requested', 'schedule', 'webhook', 'heartbeat'] as const;
const VALID_ACTIONS = ['notify', 'spawn_agent', 'webhook', 'n8n_workflow', 'execute_tool'] as const;

/**
 * Hooks — Phase 1a multi-user conversion.
 *
 * The hookManager itself stays the source of truth for cron scheduling
 * and triggered execution. Each route handler now resolves the hook
 * through `scopedRepos(principal).hooks.findById`, which returns null
 * for cross-tenant lookups. Mutations go through hookManager only after
 * the scope check confirms ownership; cross-tenant attempts surface as
 * "Hook not found" instead of "Not authorized" so attackers can't
 * enumerate hook ids.
 */
export const hookRoutes = new Elysia({ prefix: '/hooks' })
  .use(apiContext)
  // List user's hooks
  .get(
    '/',
    async ({ user, principal }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const hooks = await scopedRepos(principal).hooks.listOwn();
      return { hooks };
    },
    { detail: { tags: ['hooks'] } }
  )

  // Get hook by ID
  .get(
    '/:id',
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const hook = await scopedRepos(principal).hooks.findById(params.id);
      if (!hook) {
        return { error: 'Hook not found' };
      }
      return hook;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Create hook
  .post(
    '/',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      if (!VALID_TRIGGERS.includes(body.trigger as any)) return { error: `Invalid trigger type: ${body.trigger}` };
      if (!VALID_ACTIONS.includes(body.action as any)) return { error: `Invalid action type: ${body.action}` };

      const hookManager = getHookManager();

      const hook = await hookManager.createHook({
        userId: user.id,
        name: body.name,
        description: body.description,
        trigger: body.trigger as any,
        triggerConfig: body.triggerConfig,
        action: body.action as any,
        actionConfig: body.actionConfig,
        conditions: body.conditions,
        isEnabled: body.isEnabled ?? true,
        priority: body.priority ?? 0,
        maxExecutions: body.maxExecutions,
        cooldownMs: body.cooldownMs,
      });

      return hook;
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        trigger: t.String(),
        triggerConfig: t.Any(),
        action: t.String(),
        actionConfig: t.Any(),
        conditions: t.Optional(t.Array(t.Any())),
        isEnabled: t.Optional(t.Boolean()),
        priority: t.Optional(t.Number()),
        // null = unlimited; accept it on create too, for parity with PATCH
        maxExecutions: t.Optional(t.Union([t.Number(), t.Null()])),
        cooldownMs: t.Optional(t.Number()),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Update hook
  .patch(
    '/:id',
    async ({ user, principal, params, body }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const existing = await scopedRepos(principal).hooks.findById(params.id);
      if (!existing) {
        return { error: 'Hook not found' };
      }

      const hookManager = getHookManager();
      const hook = await hookManager.updateHook(params.id, body as any);
      return hook;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
        triggerConfig: t.Optional(t.Any()),
        actionConfig: t.Optional(t.Any()),
        conditions: t.Optional(t.Array(t.Any())),
        isEnabled: t.Optional(t.Boolean()),
        priority: t.Optional(t.Number()),
        // null = unlimited; the edit form clears run-once by sending null
        maxExecutions: t.Optional(t.Union([t.Number(), t.Null()])),
        cooldownMs: t.Optional(t.Number()),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Delete hook
  .delete(
    '/:id',
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const existing = await scopedRepos(principal).hooks.findById(params.id);
      if (!existing) {
        return { error: 'Hook not found' };
      }

      const hookManager = getHookManager();
      const deleted = await hookManager.deleteHook(params.id);
      return { deleted };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Enable/disable hook
  .post(
    '/:id/toggle',
    async ({ user, principal, params, body }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const existing = await scopedRepos(principal).hooks.findById(params.id);
      if (!existing) {
        return { error: 'Hook not found' };
      }

      const hookManager = getHookManager();
      const success = await hookManager.setEnabled(params.id, body.enabled);
      return { success, enabled: body.enabled };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        enabled: t.Boolean(),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Get hook suggestions based on configured integrations
  .get(
    '/suggestions',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };

      const suggestions = await getHookSuggestions(user.id);

      // Filter out suggestions that match existing hooks
      const hookManager = getHookManager();
      const existingHooks = await hookManager.getUserHooks(user.id);
      const existingNames = new Set(existingHooks.map(h => h.name));
      const filtered = suggestions.filter(s => !existingNames.has(s.name));

      return { suggestions: filtered };
    },
    { detail: { tags: ['hooks'] } },
  )

  // Apply a hook suggestion (create hook from template)
  .post(
    '/suggestions/:suggestionId/apply',
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };

      const suggestions = await getHookSuggestions(user.id);
      const suggestion = suggestions.find(s => s.id === params.suggestionId);
      if (!suggestion) return { error: 'Suggestion not found' };

      if (!(VALID_TRIGGERS as readonly string[]).includes(suggestion.trigger)) return { error: `Invalid trigger type: ${suggestion.trigger}` };
      if (!(VALID_ACTIONS as readonly string[]).includes(suggestion.action)) return { error: `Invalid action type: ${suggestion.action}` };

      const hookManager = getHookManager();
      const hook = await hookManager.createHook({
        userId: user.id,
        name: suggestion.name,
        description: suggestion.description,
        trigger: suggestion.trigger as any,
        triggerConfig: suggestion.triggerConfig,
        action: suggestion.action as any,
        actionConfig: suggestion.actionConfig,
        isEnabled: false, // Create disabled, user enables manually
      });

      return hook;
    },
    {
      params: t.Object({ suggestionId: t.String() }),
      detail: { tags: ['hooks'] },
    },
  )

  // Get execution history for a hook
  .get(
    '/:id/executions',
    async ({ user, principal, params, query }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };

      const hook = await scopedRepos(principal).hooks.findById(params.id);
      if (!hook) return { error: 'Hook not found' };

      const limit = query.limit ? parseInt(query.limit, 10) : 50;
      const offset = query.offset ? parseInt(query.offset, 10) : 0;

      const hookManager = getHookManager();
      const { executions, total } = await hookManager.getExecutions({
        hookId: params.id,
        limit,
        offset,
      });

      return { executions, total };
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Test hook (trigger manually)
  .post(
    '/:id/test',
    async ({ user, principal, params, body }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const hook = await scopedRepos(principal).hooks.findById(params.id);
      if (!hook) {
        return { error: 'Hook not found' };
      }

      const hookManager = getHookManager();
      // Trigger the hook with test context
      const results = await hookManager.trigger(
        { type: hook.trigger, data: body.data || {}, timestamp: new Date() },
        body.context || {}
      );

      return { results };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        data: t.Optional(t.Any()),
        context: t.Optional(t.Any()),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Get all execution history (across all hooks and recurring tasks for this user)
  .get(
    '/executions/all',
    async ({ user, query }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();
      const limit = query.limit ? parseInt(query.limit, 10) : 50;
      const offset = query.offset ? parseInt(query.offset, 10) : 0;

      // Get IDs of user's hooks and recurring tasks
      const userHooks = await db.select({ id: hooksTable.id }).from(hooksTable).where(eq(hooksTable.userId, user.id));
      const userTasks = await db.select({ id: recurringTasks.id }).from(recurringTasks).where(eq(recurringTasks.userId, user.id));

      const hookIds = userHooks.map(h => h.id);
      const taskIds = userTasks.map(t => t.id);

      if (hookIds.length === 0 && taskIds.length === 0) {
        return { executions: [], total: 0 };
      }

      // Build conditions
      const conditions = [];
      if (hookIds.length > 0) {
        conditions.push(sql`${hookExecutions.hookId} = ANY(ARRAY[${sql.join(hookIds.map(id => sql`${id}::uuid`), sql`, `)}])`);
      }
      if (taskIds.length > 0) {
        conditions.push(sql`${hookExecutions.recurringTaskId} = ANY(ARRAY[${sql.join(taskIds.map(id => sql`${id}::uuid`), sql`, `)}])`);
      }

      const where = conditions.length === 1 ? conditions[0] : or(...conditions);

      const [executions, countResult] = await Promise.all([
        db
          .select({
            id: hookExecutions.id,
            hookId: hookExecutions.hookId,
            recurringTaskId: hookExecutions.recurringTaskId,
            source: hookExecutions.source,
            status: hookExecutions.status,
            triggerType: hookExecutions.triggerType,
            actionType: hookExecutions.actionType,
            result: hookExecutions.result,
            error: hookExecutions.error,
            durationMs: hookExecutions.durationMs,
            triggerContext: hookExecutions.triggerContext,
            createdAt: hookExecutions.createdAt,
            hookName: hooksTable.name,
          })
          .from(hookExecutions)
          .leftJoin(hooksTable, eq(hookExecutions.hookId, hooksTable.id))
          .where(where)
          .orderBy(desc(hookExecutions.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql`count(*)::int` })
          .from(hookExecutions)
          .where(where),
      ]);

      return { executions, total: (countResult[0]?.count as number) || 0 };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
      detail: { tags: ['hooks'] },
    }
  );
