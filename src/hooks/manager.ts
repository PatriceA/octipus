import { and, desc, eq, sql } from 'drizzle-orm';
import { withAgentOrigin } from '@/core/agent-origin';
import { EventEmitter } from 'events';
import type { TriggerType } from '@/core/types';
import { getDb } from '@/db/postgres';
import { hookExecutions } from '@/db/schema/hook-executions';
import { type Hook, hooks, type NewHook, SERVER_TRIGGER_CONFIG_KEYS } from '@/db/schema/hooks';
import { users } from '@/db/schema/users';
import { coreLogger } from '@/utils/logger';
import { type ActionResult, executeAction } from './actions';
import { gateCheckChange } from './event-changes';
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
  /**
   * Record a cooldown or maxExecutions skip as a hook_executions row with
   * status 'skipped', so a dropped event is visible. Set for one targeted
   * hook ({@link HookManager.triggerHook}: webhook, cron, heartbeat), not for
   * the event fan-out of {@link HookManager.trigger}, where every message
   * would write a row for every hook in cooldown.
   */
  logSkips?: boolean;
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
    // Every agent this hook starts records it (Mission control's "Started by").
    const source = options.manualTest ? 'manual' : hook.trigger === 'heartbeat' ? 'heartbeat' : hook.trigger === 'webhook' ? 'webhook' : 'schedule';
    const result = await withAgentOrigin({ source, hookId: hook.id, hookName: hook.name }, () => this.runHook(hook!, event, context, { logSkips: true, ...options }));
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
    { manualTest = false, logSkips = false }: RunHookOptions = {},
  ): Promise<HookExecutionResult | null> {
    const startTime = Date.now();
    const skipped = async (reason: string, detail: Record<string, unknown> = {}): Promise<null> => {
      // One row per webhook delivery (each is an event that was dropped). A
      // schedule or heartbeat tick repeats the same skip every interval, so
      // it is logged only when the hook's latest row is not already that skip.
      if (logSkips && event.type !== 'webhook' && (await this.lastSkipReason(hook.id)) === reason) return null;
      if (logSkips) {
        await this.logExecution({
          hookId: hook.id, source: 'hook', status: 'skipped', triggerType: event.type, actionType: hook.action,
          error: reason, result: { skipped: reason, ...detail }, durationMs: Date.now() - startTime,
          triggerContext: this.sanitizeContext(context),
        });
      }
      return null;
    };

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

    // An `onlyOnChange` hook skips check deliveries that change nothing, and
    // defers a change into its merge window (hooks/event-changes.ts). Decided
    // before cooldown and the reservation, so a skipped delivery uses neither.
    // The merged turn comes back through triggerHook, gate already decided.
    if (!manualTest) {
      const gated = await gateCheckChange(hook, context, async (merged) => {
        await this.triggerHook(hook.id, event, merged);
      });
      if ('result' in gated) {
        await this.logExecution({
          hookId: hook.id, source: 'hook', status: 'success', triggerType: event.type, actionType: hook.action,
          result: gated.result.data as Record<string, unknown> | undefined, durationMs: Date.now() - startTime,
          triggerContext: this.sanitizeContext(context),
        });
        return { hookId: hook.id, hookName: hook.name, triggered: false, result: gated.result, executionTime: Date.now() - startTime };
      }
      context = gated.context;
    }

    // Check cooldown (a manual test is not a real run, so it isn't throttled)
    if (!manualTest && hook.cooldownMs && hook.lastExecutedAt) {
      const elapsed = Date.now() - new Date(hook.lastExecutedAt).getTime();
      if (elapsed < hook.cooldownMs) {
        coreLogger.debug({ hookId: hook.id, cooldownRemaining: hook.cooldownMs - elapsed }, 'Hook in cooldown');
        return skipped('cooldown', { cooldownRemainingMs: hook.cooldownMs - elapsed });
      }
    }

    // Check max executions
    if (!manualTest && hook.maxExecutions && hook.executionCount >= hook.maxExecutions) {
      coreLogger.debug({ hookId: hook.id }, 'Hook max executions reached');
      return skipped('max_executions', { executionCount: hook.executionCount, maxExecutions: hook.maxExecutions });
    }

    // A deactivated owner's hooks never fire — scheduled, heartbeat, webhook
    // or event alike. Read at fire time: the flag can change between ticks.
    const [owner] = await this.db
      .select({ isActive: users.isActive })
      .from(users)
      .where(eq(users.id, hook.userId))
      .limit(1);
    if (!owner?.isActive) {
      coreLogger.info({ hookId: hook.id, userId: hook.userId }, 'Hook skipped: owner is deactivated');
      return null;
    }

    // Reserve the run before executing: one conditional UPDATE stamps
    // lastExecutedAt and bumps executionCount only while cooldown and
    // maxExecutions still allow it, so concurrent triggers (two webhook
    // deliveries, two API processes) can't both get past the checks above.
    // A manual test is not a real run and reserves nothing.
    const previousLastExecutedAt = hook.lastExecutedAt;
    const reservedAt = manualTest ? null : await this.reserveRun(hook);
    if (!manualTest && !reservedAt) {
      coreLogger.debug({ hookId: hook.id }, 'Hook run not reserved (cooldown or max executions)');
      return skipped('not_reserved');
    }

    // Execute the action
    try {
      const result = await executeAction(hook, context);
      const executionTime = Date.now() - startTime;

      // Refused before any work started (capacity / quota): hand the
      // reservation back, so a retry of the same event is not then skipped
      // by the cooldown or maxExecutions this run never used.
      // A run a user's /stop dropped from the session queue never started either.
      if ((result.notStarted || result.droppedByStop) && reservedAt) await this.unreserveRun(hook, reservedAt, previousLastExecutedAt);

      // Log execution
      await this.logExecution({
        hookId: hook.id,
        source: manualTest ? 'manual_test' : 'hook',
        status: result.success ? 'success' : result.droppedByStop ? 'skipped' : 'error',
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

      // EventEmitter throws on an 'error' event nobody listens to, which
      // would make triggerHook reject after the action already ran.
      if (this.listenerCount('error') > 0) this.emit('error', { hook, error, context });

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
    this.mirrorCounters(hook, executionCount, lastExecutedAt);
  }

  /**
   * Atomically claim one run of `hook`: bump executionCount and stamp
   * lastExecutedAt, but only if the row still passes maxExecutions and
   * cooldown (evaluated by the database, so two concurrent callers can't both
   * pass). Returns this run's lastExecutedAt stamp, or null when another run
   * got there first. Semantics match
   * the in-memory checks in runHook: a null or 0 maxExecutions / cooldownMs
   * means unlimited / none.
   */
  private async reserveRun(hook: Hook): Promise<Date | null> {
    const rows = await this.db
      .update(hooks)
      .set({
        executionCount: sql`${hooks.executionCount} + 1`,
        lastExecutedAt: sql`now()`,
      })
      .where(
        and(
          eq(hooks.id, hook.id),
          sql`(${hooks.maxExecutions} IS NULL OR ${hooks.maxExecutions} <= 0 OR ${hooks.executionCount} < ${hooks.maxExecutions})`,
          sql`(${hooks.cooldownMs} IS NULL OR ${hooks.cooldownMs} <= 0 OR ${hooks.lastExecutedAt} IS NULL
               OR ${hooks.lastExecutedAt} <= now() - ${hooks.cooldownMs} * interval '1 millisecond')`,
        ),
      )
      .returning({ executionCount: hooks.executionCount, lastExecutedAt: hooks.lastExecutedAt });
    const row = rows[0];
    if (!row) return null;
    const stamp = row.lastExecutedAt ?? new Date();
    this.mirrorCounters(hook, row.executionCount, stamp);
    return stamp;
  }

  /** The reason of the hook's latest execution row when it is a skip, else null. */
  private async lastSkipReason(hookId: string): Promise<string | null> {
    try {
      const [last] = await this.db
        .select({ status: hookExecutions.status, error: hookExecutions.error })
        .from(hookExecutions)
        .where(eq(hookExecutions.hookId, hookId))
        .orderBy(desc(hookExecutions.createdAt))
        .limit(1);
      return last?.status === 'skipped' ? last.error : null;
    } catch {
      return null;
    }
  }

  /**
   * Undo {@link reserveRun} for a run that never started. The execution count
   * is always given back. lastExecutedAt is rewound to its value before this
   * run only while it still holds this run's own stamp (`reservedAt`, from
   * reserveRun, not the shared hook object), so a run reserved since keeps
   * its cooldown.
   */
  private async unreserveRun(hook: Hook, reservedAt: Date, previous: Date | null): Promise<void> {
    try {
      const rows = await this.db
        .update(hooks)
        .set({
          executionCount: sql`GREATEST(${hooks.executionCount} - 1, 0)`,
          // The column keeps microseconds, the Date read back only milliseconds.
          lastExecutedAt: sql`CASE WHEN date_trunc('milliseconds', ${hooks.lastExecutedAt}) = ${reservedAt.toISOString()}::timestamptz
                               THEN ${previous ? new Date(previous).toISOString() : null}::timestamptz ELSE ${hooks.lastExecutedAt} END`,
        })
        .where(eq(hooks.id, hook.id))
        .returning({ executionCount: hooks.executionCount, lastExecutedAt: hooks.lastExecutedAt });
      if (rows[0]) this.mirrorCounters(hook, rows[0].executionCount, rows[0].lastExecutedAt);
    } catch (err) {
      coreLogger.warn({ err, hookId: hook.id }, 'Could not hand back the run reservation of a hook run that never started');
    }
  }

  /**
   * Mirror new counters into `hook` (which may be a fresh DB row) and the
   * cached copy, so the in-memory cooldown / maxExecutions checks hold
   * between cache reloads.
   */
  private mirrorCounters(hook: Hook, executionCount: number, lastExecutedAt: Date | null): void {
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
