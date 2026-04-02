import { EventEmitter } from 'events';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { hooks, type Hook, type NewHook } from '@/db/schema/hooks';
import { hookExecutions } from '@/db/schema/hook-executions';
import { matchesTrigger, checkConditions, type TriggerEvent, type TriggerContext } from './triggers';
import { executeAction, type ActionResult } from './actions';
import { coreLogger } from '@/utils/logger';
import type { TriggerType } from '@/core/types';

export interface HookExecutionResult {
  hookId: string;
  hookName: string;
  triggered: boolean;
  result?: ActionResult;
  error?: string;
  executionTime: number;
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
   * Trigger hooks for an event
   */
  async trigger(event: TriggerEvent, context: TriggerContext): Promise<HookExecutionResult[]> {
    const relevantHooks = this.hookCache.get(event.type) || [];
    const results: HookExecutionResult[] = [];

    for (const hook of relevantHooks) {
      const startTime = Date.now();

      // Check if hook matches
      if (!matchesTrigger(hook, event, context)) {
        continue;
      }

      // Check conditions
      if (!checkConditions(hook.conditions, context)) {
        continue;
      }

      // Check cooldown
      if (hook.cooldownMs && hook.lastExecutedAt) {
        const elapsed = Date.now() - new Date(hook.lastExecutedAt).getTime();
        if (elapsed < hook.cooldownMs) {
          coreLogger.debug({ hookId: hook.id, cooldownRemaining: hook.cooldownMs - elapsed }, 'Hook in cooldown');
          continue;
        }
      }

      // Check max executions
      if (hook.maxExecutions && hook.executionCount >= hook.maxExecutions) {
        coreLogger.debug({ hookId: hook.id }, 'Hook max executions reached');
        continue;
      }

      // Execute the action
      try {
        const result = await executeAction(hook, context);
        const executionTime = Date.now() - startTime;

        // Update execution stats
        await this.db
          .update(hooks)
          .set({
            executionCount: hook.executionCount + 1,
            lastExecutedAt: new Date(),
          })
          .where(eq(hooks.id, hook.id));

        // Log execution
        await this.logExecution({
          hookId: hook.id,
          source: 'hook',
          status: result.success ? 'success' : 'error',
          triggerType: event.type,
          actionType: hook.action,
          result: result.data as Record<string, unknown> | undefined,
          error: result.error || undefined,
          durationMs: executionTime,
          triggerContext: this.sanitizeContext(context),
        });

        results.push({
          hookId: hook.id,
          hookName: hook.name,
          triggered: true,
          result,
          executionTime,
        });

        this.emit('executed', { hook, result, context });

        coreLogger.info(
          { hookId: hook.id, hookName: hook.name, success: result.success },
          'Hook executed'
        );
      } catch (error) {
        const executionTime = Date.now() - startTime;

        // Log failed execution
        await this.logExecution({
          hookId: hook.id,
          source: 'hook',
          status: 'error',
          triggerType: event.type,
          actionType: hook.action,
          error: (error as Error).message,
          durationMs: executionTime,
          triggerContext: this.sanitizeContext(context),
        }).catch(() => {}); // Don't fail the hook if logging fails

        results.push({
          hookId: hook.id,
          hookName: hook.name,
          triggered: true,
          error: (error as Error).message,
          executionTime,
        });

        this.emit('error', { hook, error, context });

        coreLogger.error({ error, hookId: hook.id }, 'Hook execution failed');
      }
    }

    return results;
  }

  /**
   * Trigger pre/post tool-use hooks.
   * Returns 'allow' if all hooks pass, 'deny' if any hook blocks, with optional message.
   * Hooks with trigger type 'tool_pre' or 'tool_post' are evaluated.
   *
   * Inspired by claw-code-parity's hook system:
   * - Pre-tool hooks can block execution (action: 'deny')
   * - Post-tool hooks can log/notify
   */
  async triggerToolHooks(
    phase: 'tool_pre' | 'tool_post',
    toolName: string,
    toolId: string,
    args: Record<string, unknown>,
    result?: { output?: unknown; error?: string },
  ): Promise<{ decision: 'allow' | 'deny'; message?: string }> {
    const hooks = this.hookCache.get(phase) || [];
    if (hooks.length === 0) return { decision: 'allow' };

    for (const hook of hooks) {
      // Check if hook matches this tool (triggerConfig.toolPattern)
      const pattern = hook.triggerConfig?.toolPattern as string | undefined;
      if (pattern && pattern !== '*') {
        if (pattern.endsWith(':*')) {
          if (!toolId.startsWith(pattern.slice(0, -2)) && !toolName.startsWith(pattern.slice(0, -2))) continue;
        } else if (pattern !== toolId && pattern !== toolName) {
          continue;
        }
      }

      if (!hook.isEnabled) continue;

      // Execute hook action
      const context: TriggerContext = {
        sessionId: '',
        metadata: { toolName, toolId, args, phase, ...result },
      };

      try {
        const actionResult = await executeAction(hook, context);

        // Update stats
        await this.db.update(hooks).set({
          executionCount: hook.executionCount + 1,
          lastExecutedAt: new Date(),
        }).where(eq(hooksTable.id, hook.id));

        // If the hook action is 'deny' or returns a deny signal, block the tool
        if (hook.action === 'deny' || (actionResult.data as any)?.deny) {
          return { decision: 'deny', message: actionResult.error || (actionResult.data as any)?.message || `Blocked by hook: ${hook.name}` };
        }
      } catch (err) {
        coreLogger.error({ err, hookId: hook.id, tool: toolName, phase }, 'Tool hook execution failed');
      }
    }

    return { decision: 'allow' };
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
    const result = await this.db
      .update(hooks)
      .set({ ...data, updatedAt: new Date() })
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
