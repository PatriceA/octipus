import { and, desc, eq, sql } from 'drizzle-orm';
import { EventEmitter } from 'events';
import type { TriggerType } from '@/core/types';
import { getDb } from '@/db/postgres';
import { hookExecutions } from '@/db/schema/hook-executions';
import { type Hook, hooks, type NewHook, SERVER_TRIGGER_CONFIG_KEYS } from '@/db/schema/hooks';
import { coreLogger } from '@/utils/logger';
import { type ActionResult, executeAction } from './actions';
import { checkConditions, matchesTrigger, type TriggerContext, type TriggerEvent } from './triggers';

export interface HookExecutionResult {
  hookId: string;
  hookName: string;
  triggered: boolean;
  result?: ActionResult;
  error?: string;
  executionTime: number;
}

export interface RunHookOptions {
  /**
   * A manual test fire (POST /api/hooks/:id/test). It bypasses cooldown and
   * maxExecutions, does not count as a real run (executionCount /
   * lastExecutedAt untouched), and is logged with source 'manual_test'.
   */
  manualTest?: boolean;
}

export interface TriggerHookOptions extends RunHookOptions {
  /**
   * The hook row the caller has just read from the database and claimed for
   * this run. Used instead of re-reading, and its isEnabled is not rechecked:
   * the cron-runner disables a one-shot (scheduledAt) hook *before* firing
   * it, so a fresh read would wrongly skip the run it just claimed. Must be
   * the row for `hookId`.
   */
  claimedRow?: Hook;
}

export class HookManager extends EventEmitter {
  private get db() { return getDb(); }
  private hookCache: Map<TriggerType, Hook[]> = new Map();

  /**
   * Load hooks from database
   */
  async loadHooks(): Promise<void> {
    const allHooks = await this.db
      .select()
      .from(hooks)
      .where(eq(hooks.isEnabled, true))
      .orderBy(desc(hooks.priority));

    // Group by trigger type
    this.hookCache.clear();
    for (const hook of allHooks) {
      if (!this.hookCache.has(hook.trigger)) {
        this.hookCache.set(hook.trigger, []);
      }
      this.hookCache.get(hook.trigger)!.push(hook);
    }

    coreLogger.info({ count: allHooks.length }, 'Hooks loaded');
  }

  /**
   * Trigger hooks for an event.
   *
   * The cache holds every user's enabled hooks, so this fans out across
   * tenants. That is only correct for callers that either target one hook
   * (`event.data.hookId`, as the cron-runner, heartbeat and incoming-webhook
   * routes do) or carry no user identity at all. As defence in depth, when the
   * context names a user (`context.message.userId` / `context.agent.userId`),
   * hooks owned by anyone else are skipped (see {@link runHook}). There is no
   * notion of global/admin hooks (`hooks.user_id` is NOT NULL), so no
   * legitimate cross-user fan-out is lost.
   *
   * To fire one specific hook (e.g. a manual test), use {@link triggerHook}.
   */
  async trigger(event: TriggerEvent, context: TriggerContext): Promise<HookExecutionResult[]> {
    const relevantHooks = this.hookCache.get(event.type) || [];
    const results: HookExecutionResult[] = [];

    for (const hook of relevantHooks) {
      const result = await this.runHook(hook, event, context);
      if (result) results.push(result);
    }

    return results;
  }

  /**
   * Fire exactly one hook, by id. Applies the same gates as {@link trigger}
   * (trigger match, conditions, cooldown, max executions, owner check) but
   * never evaluates any other hook. The row is read fresh from the database
   * (not the cache), so a hook disabled or exhausted directly in the DB —
   * e.g. a one-shot the cron-runner just switched off — cannot be re-fired
   * from a stale cache entry. Disabled or unknown hooks produce no result.
   *
   * Callers are responsible for authorising access to `hookId` (the test
   * route loads it through `scopedRepos` first).
   */
  async triggerHook(
    hookId: string,
    event: TriggerEvent,
    context: TriggerContext,
    { claimedRow, ...options }: TriggerHookOptions = {},
  ): Promise<HookExecutionResult[]> {
    let hook: Hook | null;
    if (claimedRow) {
      if (claimedRow.id !== hookId) return [];
      hook = claimedRow;
    } else {
      hook = await this.getHook(hookId);
      if (!hook || !hook.isEnabled) return [];
    }
    const result = await this.runHook(hook, event, context, options);
    return result ? [result] : [];
  }

  /**
   * Evaluate and, if it passes every gate, execute a single hook.
   * Returns null when the hook was skipped.
   */
  private async runHook(
    hook: Hook,
    event: TriggerEvent,
    context: TriggerContext,
    { manualTest = false }: RunHookOptions = {},
  ): Promise<HookExecutionResult | null> {
    const startTime = Date.now();

    // Tenancy guard: a context that names a user only ever runs that user's hooks.
    const contextUserIds = [context.message?.userId, context.agent?.userId].filter(Boolean);
    if (contextUserIds.some((uid) => uid !== hook.userId)) {
      return null;
    }

    // Check if hook matches
    if (!matchesTrigger(hook, event, context)) {
      return null;
    }

    // Check conditions
    if (!checkConditions(hook.conditions, context)) {
      return null;
    }

    // Check cooldown (a manual test is not a real run, so it isn't throttled)
    if (!manualTest && hook.cooldownMs && hook.lastExecutedAt) {
      const elapsed = Date.now() - new Date(hook.lastExecutedAt).getTime();
      if (elapsed < hook.cooldownMs) {
        coreLogger.debug({ hookId: hook.id, cooldownRemaining: hook.cooldownMs - elapsed }, 'Hook in cooldown');
        return null;
      }
    }

    // Check max executions
    if (!manualTest && hook.maxExecutions && hook.executionCount >= hook.maxExecutions) {
      coreLogger.debug({ hookId: hook.id }, 'Hook max executions reached');
      return null;
    }

    // Execute the action
    try {
      const result = await executeAction(hook, context);
      const executionTime = Date.now() - startTime;

      // Update execution stats (real runs only)
      if (!manualTest) await this.recordRun(hook);

      // Log execution
      await this.logExecution({
        hookId: hook.id,
        source: manualTest ? 'manual_test' : 'hook',
        status: result.success ? 'success' : 'error',
        triggerType: event.type,
        actionType: hook.action,
        result: result.data as Record<string, unknown> | undefined,
        error: result.error || undefined,
        durationMs: executionTime,
        triggerContext: this.sanitizeContext(context),
      });

      this.emit('executed', { hook, result, context });

      coreLogger.info(
        { hookId: hook.id, hookName: hook.name, success: result.success },
        'Hook executed'
      );

      return {
        hookId: hook.id,
        hookName: hook.name,
        triggered: true,
        result,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      // Log failed execution
      await this.logExecution({
        hookId: hook.id,
        source: manualTest ? 'manual_test' : 'hook',
        status: 'error',
        triggerType: event.type,
        actionType: hook.action,
        error: (error as Error).message,
        durationMs: executionTime,
        triggerContext: this.sanitizeContext(context),
      }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in manager')); // Don't fail the hook if logging fails

      this.emit('error', { hook, error, context });

      coreLogger.error({ error, hookId: hook.id }, 'Hook execution failed');

      return {
        hookId: hook.id,
        hookName: hook.name,
        triggered: true,
        error: (error as Error).message,
        executionTime,
      };
    }
  }

  /**
   * Trigger pre/post tool-use hooks.
   * Returns 'allow' if all hooks pass, 'deny' if any hook blocks, with optional message.
   * Hooks with trigger type 'tool_pre' or 'tool_post' are evaluated.
   *
   * Inspired by claw-code-parity's hook system:
   * - Pre-tool hooks can block execution (action: 'deny')
   * - Post-tool hooks can log/notify
   *
   * Only hooks owned by `userId` (the user on whose behalf the tool runs) are
   * evaluated: another tenant's hook must never see this user's tool args or
   * be able to deny this user's tools. When no user is known (`userId` is
   * empty — a system context), no user hooks run at all; there are no
   * global hooks to apply instead.
   */
  async triggerToolHooks(
    userId: string | null | undefined,
    phase: 'tool_pre' | 'tool_post',
    toolName: string,
    toolId: string,
    args: Record<string, unknown>,
    result?: { output?: unknown; error?: string },
  ): Promise<{ decision: 'allow' | 'deny'; message?: string }> {
    if (!userId) return { decision: 'allow' };
    const matchingHooks = (this.hookCache.get(phase) || []).filter((h) => h.userId === userId);
    if (matchingHooks.length === 0) return { decision: 'allow' };

    for (const hook of matchingHooks) {
      // Check if hook matches this tool (triggerConfig.toolPattern)
      const config = hook.triggerConfig as Record<string, unknown> | null;
      const pattern = config?.toolPattern as string | undefined;
      if (pattern && pattern !== '*') {
        if (pattern.endsWith(':*')) {
          const prefix = pattern.slice(0, -2);
          if (!toolId.startsWith(prefix) && !toolName.startsWith(prefix)) continue;
        } else if (pattern !== toolId && pattern !== toolName) {
          continue;
        }
      }

      if (!hook.isEnabled) continue;

      const context: TriggerContext = {
        tool: { name: toolName, toolId, args, result: result?.output },
      };

      try {
        const actionResult = await executeAction(hook, context);

        // Update execution stats
        await this.recordRun(hook);

        // If the hook action is 'deny' or returns a deny signal, block the tool
        if ((actionResult.data as any)?.deny) {
          return { decision: 'deny', message: actionResult.error || (actionResult.data as any)?.message || `Blocked by hook: ${hook.name}` };
        }
      } catch (err) {
        coreLogger.error({ err, hookId: hook.id, tool: toolName, phase }, 'Tool hook execution failed');
      }
    }

    return { decision: 'allow' };
  }

  /**
   * Persist one more run of `hook` and mirror the new counters into the
   * cached copy (and `hook` itself, which may be a fresh DB row), so cooldown
   * and maxExecutions hold between cache reloads.
   */
  private async recordRun(hook: Hook): Promise<void> {
    const executionCount = hook.executionCount + 1;
    const lastExecutedAt = new Date();
    await this.db.update(hooks).set({ executionCount, lastExecutedAt }).where(eq(hooks.id, hook.id));
    hook.executionCount = executionCount;
    hook.lastExecutedAt = lastExecutedAt;
    const cached = (this.hookCache.get(hook.trigger) || []).find((h) => h.id === hook.id);
    if (cached && cached !== hook) {
      cached.executionCount = executionCount;
      cached.lastExecutedAt = lastExecutedAt;
    }
  }

  /**
   * Get webhook hooks that match a given path.
   * Returns matched hooks so callers can inspect triggerConfig (e.g. webhookSecret).
   */
  getWebhookHooksByPath(path: string): Hook[] {
    const webhookHooks = this.hookCache.get('webhook') || [];
    return webhookHooks.filter(h => h.triggerConfig?.webhookPath === path && h.isEnabled);
  }

  /**
   * Create a new hook
   */
  async createHook(data: Omit<NewHook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Hook> {
    // For schedule triggers, compute nextRunAt
    if (data.trigger === 'schedule') {
      if (data.triggerConfig?.scheduledAt) {
        // One-time datetime task — nextRunAt is the scheduled time
        (data as any).nextRunAt = new Date(data.triggerConfig.scheduledAt as string);
        // Force single execution
        if (!data.maxExecutions) data.maxExecutions = 1;
      } else if (data.triggerConfig?.cronExpression) {
        const { getNextCronDate } = await import('@/core/cron-runner');
        const timezone = (data.triggerConfig.timezone as string) || 'UTC';
        (data as any).nextRunAt = getNextCronDate(data.triggerConfig.cronExpression as string, timezone);
      }
    }
    const result = await this.db.insert(hooks).values(data).returning();
    await this.loadHooks(); // Reload cache
    return result[0];
  }

  /**
   * Update a hook
   */
  async updateHook(id: string, data: Partial<NewHook>): Promise<Hook | null> {
    // If triggerConfig changes for a schedule hook, recompute nextRunAt
    if (data.triggerConfig?.scheduledAt) {
      (data as any).nextRunAt = new Date(data.triggerConfig.scheduledAt as string);
    } else if (data.triggerConfig?.cronExpression) {
      const { getNextCronDate } = await import('@/core/cron-runner');
      const timezone = (data.triggerConfig.timezone as string) || 'UTC';
      (data as any).nextRunAt = getNextCronDate(data.triggerConfig.cronExpression as string, timezone);
    }
    // triggerConfig: the caller's keys replace the user-editable part; the
    // server-owned keys are taken from the row in this same statement, never
    // from the caller (which may have read the row before a lease or counter
    // changed). See SERVER_TRIGGER_CONFIG_KEYS.
    const { triggerConfig, ...rest } = data;
    const set: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    if (triggerConfig !== undefined) {
      const userKeys: Record<string, unknown> = { ...(triggerConfig ?? {}) };
      for (const key of SERVER_TRIGGER_CONFIG_KEYS) delete userKeys[key];
      const serverKeyList = sql.join(SERVER_TRIGGER_CONFIG_KEYS.map((k) => sql`${k}`), sql`, `);
      set.triggerConfig = sql`${JSON.stringify(userKeys)}::jsonb || coalesce((SELECT jsonb_object_agg(kv.key, kv.value) FROM jsonb_each(${hooks.triggerConfig}) AS kv WHERE kv.key IN (${serverKeyList})), '{}'::jsonb)`;
    }
    const result = await this.db
      .update(hooks)
      .set(set as Partial<NewHook>)
      .where(eq(hooks.id, id))
      .returning();

    if (result[0]) {
      await this.loadHooks(); // Reload cache
    }

    return result[0] ?? null;
  }

  /**
   * Delete a hook
   */
  async deleteHook(id: string): Promise<boolean> {
    const result = await this.db.delete(hooks).where(eq(hooks.id, id)).returning();

    if (result.length > 0) {
      await this.loadHooks(); // Reload cache
      return true;
    }

    return false;
  }

  /**
   * Enable/disable a hook
   */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const result = await this.db
      .update(hooks)
      .set({ isEnabled: enabled, updatedAt: new Date() })
      .where(eq(hooks.id, id))
      .returning();

    if (result.length > 0) {
      await this.loadHooks(); // Reload cache
      return true;
    }

    return false;
  }

  /**
   * Get hooks for a user
   */
  async getUserHooks(userId: string): Promise<Hook[]> {
    return this.db.select().from(hooks).where(eq(hooks.userId, userId)).orderBy(desc(hooks.priority));
  }

  /**
   * Get hook by ID
   */
  async getHook(id: string): Promise<Hook | null> {
    const result = await this.db.select().from(hooks).where(eq(hooks.id, id)).limit(1);
    return result[0] ?? null;
  }

  /**
   * Log an execution to the hook_executions table
   */
  async logExecution(data: {
    hookId?: string;
    recurringTaskId?: string;
    source: 'hook' | 'recurring_task' | 'manual_test';
    status: 'success' | 'error' | 'skipped';
    triggerType?: string;
    actionType?: string;
    result?: Record<string, unknown>;
    error?: string;
    durationMs?: number;
    triggerContext?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.db.insert(hookExecutions).values(data);
    } catch (err) {
      coreLogger.error({ err }, 'Failed to log hook execution');
    }
  }

  /**
   * Get execution history for a hook or recurring task
   */
  async getExecutions(opts: {
    hookId?: string;
    recurringTaskId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ executions: typeof hookExecutions.$inferSelect[]; total: number }> {
    const { sql: sqlFn } = await import('drizzle-orm');
    const conditions = [];
    if (opts.hookId) conditions.push(eq(hookExecutions.hookId, opts.hookId));
    if (opts.recurringTaskId) conditions.push(eq(hookExecutions.recurringTaskId, opts.recurringTaskId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [executions, countResult] = await Promise.all([
      this.db
        .select()
        .from(hookExecutions)
        .where(where)
        .orderBy(desc(hookExecutions.createdAt))
        .limit(opts.limit || 50)
        .offset(opts.offset || 0),
      this.db
        .select({ count: sqlFn`count(*)::int` })
        .from(hookExecutions)
        .where(where),
    ]);

    return { executions, total: (countResult[0]?.count as number) || 0 };
  }

  /**
   * Sanitize context for storage — remove large or sensitive fields
   */
  private sanitizeContext(context: TriggerContext): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    if (context.message) {
      sanitized.message = {
        channelType: context.message.channelType,
        channelId: context.message.channelId,
        userId: context.message.userId,
        content: (context.message.content || '').slice(0, 500),
      };
    }
    if (context.agent) {
      sanitized.agent = {
        id: context.agent.id,
        sessionId: context.agent.sessionId,
        topic: context.agent.topic,
        status: context.agent.status,
      };
    }
    if (context.tool) {
      sanitized.tool = { name: context.tool.name, toolId: context.tool.toolId };
    }
    if (context.schedule) {
      sanitized.schedule = context.schedule;
    }
    if (context.webhook) {
      sanitized.webhook = {
        path: context.webhook.path,
        method: context.webhook.method,
      };
    }
    return sanitized;
  }

}

// Singleton instance
let managerInstance: HookManager | null = null;

export function getHookManager(): HookManager {
  if (!managerInstance) {
    managerInstance = new HookManager();
  }
  return managerInstance;
}
