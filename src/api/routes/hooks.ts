import { desc, eq, or, sql } from 'drizzle-orm';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { disableDailyBriefingHook, ensureDailyBriefingHook } from '@/core/briefing';
import { roleHeartbeatHookError, sanitizeTriggerConfig } from '@/core/heartbeat';
import type { ChannelType } from '@/core/types';
import { getDb } from '@/db/postgres';
import { scopedRepos } from '@/db/repositories/scoped';
import { hookExecutions } from '@/db/schema/hook-executions';
import { type Hook as HookRow, hooks as hooksTable } from '@/db/schema/hooks';
import { recurringTasks } from '@/db/schema/recurring-tasks';
import { loadNotifyScope, type NotifyScope } from '@/channels/ownership';
import { hookConfigTargets, invalidHookTargets, notifyTargetsError } from '@/hooks/actions';
import { getHookManager } from '@/hooks/manager';
import { getHookSuggestions } from '@/hooks/suggestions';
import type { TriggerContext } from '@/hooks/triggers';
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
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Channel types a test message may claim (mirrors core ChannelType). */
const TEST_CHANNEL_TYPES = ['telegram', 'teams', 'slack', 'whatsapp', 'webchat', 'api', 'qa-demo'] as const satisfies readonly ChannelType[];

function isChannelType(v: unknown): v is ChannelType {
  return typeof v === 'string' && (TEST_CHANNEL_TYPES as readonly string[]).includes(v);
}

/** Metadata keys that carry identity; never taken from the caller. */
const IDENTITY_METADATA_KEYS = new Set(['sessionId', 'userId']);

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k.toLowerCase()] = val;
  }
  return out;
}

type TestContextInput = { message?: string; data?: unknown; context?: unknown };

/**
 * Build the trigger context for a manual test fire.
 *
 * Identity is server-controlled: the message's userId is always the hook
 * owner, there is no sessionId (in metadata or anywhere else), and no
 * agent/tool objects are accepted from the caller — only synthetic ones built
 * from the hook config. The caller may supply the non-identity fields a hook
 * can filter or condition on:
 *  - message: content (or top-level `message`), channelType / channel
 *    (validated against the channel enum), metadata minus sessionId/userId;
 *  - webhook: path, method, headers, body.
 * Returns an error string for an invalid channel type.
 */
function buildTestContext(hook: HookRow, input: TestContextInput, now: Date): TriggerContext | { error: string } {
  const config = hook.triggerConfig ?? {};
  const supplied = isPlainObject(input.context) ? input.context : {};
  const sMessage = isPlainObject(supplied.message) ? supplied.message : undefined;
  const sWebhook = isPlainObject(supplied.webhook) ? supplied.webhook : undefined;
  const context: TriggerContext = {};

  const text =
    typeof input.message === 'string'
      ? input.message
      : typeof sMessage?.content === 'string'
        ? sMessage.content
        : undefined;
  if (text !== undefined || sMessage || hook.trigger === 'message_received') {
    const requestedChannel = sMessage?.channelType ?? sMessage?.channel;
    if (requestedChannel !== undefined && !isChannelType(requestedChannel)) {
      return { error: `Invalid channel type. Allowed: ${TEST_CHANNEL_TYPES.join(', ')}` };
    }
    const metadata = isPlainObject(sMessage?.metadata)
      ? Object.fromEntries(Object.entries(sMessage.metadata).filter(([k]) => !IDENTITY_METADATA_KEYS.has(k)))
      : undefined;
    context.message = {
      id: `hook-test-${hook.id}-${now.getTime()}`,
      channelType: requestedChannel ?? 'api',
      channelId: hook.userId,
      userId: hook.userId,
      content: text ?? '',
      timestamp: now,
      ...(metadata ? { metadata } : {}),
    };
  }
  switch (hook.trigger) {
    case 'agent_started':
    case 'agent_completed':
    case 'agent_failed':
      context.agent = {
        id: `hook-test-${hook.id}`,
        // Empty: resolveHookSessionId falls through to the hook's own session.
        sessionId: '',
        userId: hook.userId,
        topic: config.sessionFilter?.topics?.[0] ?? 'hook',
        model: 'default',
        role: 'general',
        status: hook.trigger === 'agent_started' ? 'running' : hook.trigger === 'agent_failed' ? 'failed' : 'completed',
        createdAt: now,
        updatedAt: now,
        metadata: {},
      };
      break;
    case 'tool_executed':
      context.tool = {
        name: config.toolNames?.[0] ?? 'test',
        toolId: config.toolIds?.[0] ?? 'test',
        args: {},
      };
      break;
    case 'webhook': {
      const data = input.data;
      const fallbackBody = isPlainObject(data) && 'body' in data ? data.body : (data ?? {});
      context.webhook = {
        path: typeof sWebhook?.path === 'string' ? sWebhook.path : (config.webhookPath ?? hook.id),
        method: typeof sWebhook?.method === 'string' ? sWebhook.method.toUpperCase() : 'POST',
        headers: stringRecord(sWebhook?.headers),
        body: sWebhook && 'body' in sWebhook ? sWebhook.body : fallbackBody,
      };
      break;
    }
    case 'schedule':
      context.schedule = {
        cronExpression: (config.cronExpression as string | undefined) ?? '',
        scheduledTime: now,
        hookName: hook.name,
      };
      break;
    default:
      break;
  }
  return context;
}

/**
 * Annotate hooks with the outbound targets they may no longer send to
 * (`invalidTargets`: `type:id` strings), e.g. a raw web chat connection id or
 * another user's chat saved before targets were checked. One scope load per
 * owner; hooks without literal targets cost nothing.
 */
async function withInvalidTargets<T extends HookRow>(rows: T[]): Promise<(T & { invalidTargets: string[] })[]> {
  const scopes = new Map<string, Promise<NotifyScope>>();
  return Promise.all(rows.map(async (h) => {
    if (hookConfigTargets(h.actionConfig).length === 0) return { ...h, invalidTargets: [] };
    let scope = scopes.get(h.userId);
    if (!scope) { scope = loadNotifyScope(h.userId); scopes.set(h.userId, scope); }
    const invalid = await invalidHookTargets(h.userId, h.actionConfig, { scope: await scope });
    return { ...h, invalidTargets: invalid.map((i) => i.target) };
  }));
}

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
      return { hooks: await withInvalidTargets(hooks) };
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
      return (await withInvalidTargets([hook]))[0];
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
    async ({ user, body, set }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      if (!VALID_TRIGGERS.includes(body.trigger as any)) return { error: `Invalid trigger type: ${body.trigger}` };
      if (!VALID_ACTIONS.includes(body.action as any)) return { error: `Invalid action type: ${body.action}` };

      // The heartbeat's own state (daily-run counter, surfaced items) is the
      // server's to write; a role heartbeat needs a known role, one per user.
      const triggerConfig = sanitizeTriggerConfig(body.triggerConfig);
      const roleError = await roleHeartbeatHookError(user.id, body.trigger, triggerConfig);
      if (roleError) {
        set.status = 400;
        return { error: roleError };
      }

      // Explicit notify targets must be chats linked to the caller.
      const targetError = await notifyTargetsError(user.id, body.actionConfig);
      if (targetError) {
        set.status = 400;
        return { error: targetError };
      }

      const hookManager = getHookManager();

      const hook = await hookManager.createHook({
        userId: user.id,
        name: body.name,
        description: body.description,
        trigger: body.trigger as any,
        triggerConfig,
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
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const existing = await scopedRepos(principal).hooks.findById(params.id);
      if (!existing) {
        return { error: 'Hook not found' };
      }

      const patch = { ...body } as Record<string, unknown>;
      if (body.triggerConfig !== undefined) {
        // The heartbeat's state is the server's (see POST): drop it from the
        // edit, and let updateHook keep the stored keys in its one UPDATE, so
        // a lease or counter that changed since `existing` was read survives.
        patch.triggerConfig = sanitizeTriggerConfig(body.triggerConfig);
        const roleError = await roleHeartbeatHookError(existing.userId, existing.trigger, patch.triggerConfig, existing.id);
        if (roleError) {
          set.status = 400;
          return { error: roleError };
        }
      }
      if (body.actionConfig !== undefined) {
        // Only targets new in this edit: a hook that already holds a target
        // that is no longer valid stays editable (it is skipped at send time
        // and flagged by `invalidTargets` on GET).
        const targetError = await notifyTargetsError(existing.userId, body.actionConfig, existing.actionConfig);
        if (targetError) {
          set.status = 400;
          return { error: targetError };
        }
      }

      const hookManager = getHookManager();
      const hook = await hookManager.updateHook(params.id, patch as any);
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

  // Daily briefing — the seeded proactive hook. Ensure (create or re-enable)
  // for users who registered before it existed or paused it; disable to pause.
  .post(
    '/briefing',
    async ({ user, principal, body }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
      const id = await ensureDailyBriefingHook(user.id, {
        timezone: body?.timezone,
        cronExpression: body?.cronExpression,
      });
      const hook = await scopedRepos(principal).hooks.findById(id);
      return hook ?? { id };
    },
    {
      body: t.Optional(t.Object({
        timezone: t.Optional(t.String({ maxLength: 64 })),
        cronExpression: t.Optional(t.String({ maxLength: 64 })),
      })),
      detail: { tags: ['hooks'] },
    },
  )
  .delete(
    '/briefing',
    async ({ user, principal }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
      await disableDailyBriefingHook(user.id);
      return { disabled: true };
    },
    { detail: { tags: ['hooks'] } },
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
    async ({ user, params, set }) => {
      if (!user) return { error: 'Not authenticated' };

      const suggestions = await getHookSuggestions(user.id);
      const suggestion = suggestions.find(s => s.id === params.suggestionId);
      if (!suggestion) return { error: 'Suggestion not found' };

      if (!(VALID_TRIGGERS as readonly string[]).includes(suggestion.trigger)) return { error: `Invalid trigger type: ${suggestion.trigger}` };
      if (!(VALID_ACTIONS as readonly string[]).includes(suggestion.action)) return { error: `Invalid action type: ${suggestion.action}` };

      const triggerConfig = sanitizeTriggerConfig(suggestion.triggerConfig);
      const roleError = await roleHeartbeatHookError(user.id, suggestion.trigger, triggerConfig);
      if (roleError) return { error: roleError };

      const targetError = await notifyTargetsError(user.id, suggestion.actionConfig);
      if (targetError) {
        set.status = 400;
        return { error: targetError };
      }

      const hookManager = getHookManager();
      const hook = await hookManager.createHook({
        userId: user.id,
        name: suggestion.name,
        description: suggestion.description,
        trigger: suggestion.trigger as any,
        triggerConfig,
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
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const hook = await scopedRepos(principal).hooks.findById(params.id);
      if (!hook) {
        return { error: 'Hook not found' };
      }

      // Heartbeat runs are gated by src/core/heartbeat.ts (active hours, daily
      // cap, change detection); a manual fire would bypass that gate.
      if (hook.trigger === 'heartbeat') {
        set.status = 400;
        return { error: "heartbeat hooks run on their schedule; they can't be test-fired" };
      }

      const now = new Date();
      const context = buildTestContext(hook, body, now);
      if ('error' in context) {
        set.status = 400;
        return { error: context.error };
      }

      const hookManager = getHookManager();
      // Fire only this hook (ownership enforced by scopedRepos above). Using
      // trigger() here would fan out to every user's hooks of the same type.
      // The context's identity is server-built (see buildTestContext).
      // manualTest: no cooldown/maxExecutions, not counted as a real run.
      const results = await hookManager.triggerHook(
        hook.id,
        {
          type: hook.trigger,
          data: { ...(isPlainObject(body.data) ? body.data : {}), hookId: hook.id },
          timestamp: now,
        },
        context,
        { manualTest: true },
      );

      return { results };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        data: t.Optional(t.Any()),
        /** Optional text for the server-built test message. */
        message: t.Optional(t.String()),
        /**
         * Non-identity test fields only: message {content, channelType |
         * channel, metadata} and webhook {path, method, headers, body}.
         * userId/sessionId and agent/tool objects are ignored.
         */
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
