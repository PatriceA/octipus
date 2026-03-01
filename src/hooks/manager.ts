import { EventEmitter } from 'events';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { hooks, type Hook, type NewHook } from '@/db/schema/hooks';
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
  private db = getDb();
  private hookCache: Map<TriggerType, Hook[]> = new Map();
  private scheduledJobs: Map<string, ReturnType<typeof setInterval>> = new Map();

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

    // Set up scheduled hooks
    this.setupScheduledHooks();

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

        // Update execution stats
        await this.db
          .update(hooks)
          .set({
            executionCount: hook.executionCount + 1,
            lastExecutedAt: new Date(),
          })
          .where(eq(hooks.id, hook.id));

        results.push({
          hookId: hook.id,
          hookName: hook.name,
          triggered: true,
          result,
          executionTime: Date.now() - startTime,
        });

        this.emit('executed', { hook, result, context });

        coreLogger.info(
          { hookId: hook.id, hookName: hook.name, success: result.success },
          'Hook executed'
        );
      } catch (error) {
        results.push({
          hookId: hook.id,
          hookName: hook.name,
          triggered: true,
          error: (error as Error).message,
          executionTime: Date.now() - startTime,
        });

        this.emit('error', { hook, error, context });

        coreLogger.error({ error, hookId: hook.id }, 'Hook execution failed');
      }
    }

    return results;
  }

  /**
   * Create a new hook
   */
  async createHook(data: Omit<NewHook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Hook> {
    const result = await this.db.insert(hooks).values(data).returning();
    await this.loadHooks(); // Reload cache
    return result[0];
  }

  /**
   * Update a hook
   */
  async updateHook(id: string, data: Partial<NewHook>): Promise<Hook | null> {
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
   * Set up scheduled hooks
   */
  private setupScheduledHooks(): void {
    // Clear existing scheduled jobs
    for (const job of this.scheduledJobs.values()) {
      clearInterval(job);
    }
    this.scheduledJobs.clear();

    const scheduledHooks = this.hookCache.get('schedule') || [];

    for (const hook of scheduledHooks) {
      const cronExpression = hook.triggerConfig.cronExpression;
      if (!cronExpression) continue;

      // Simple cron parsing - in production, use a proper cron library
      const interval = this.parseCronToInterval(cronExpression);
      if (!interval) continue;

      const job = setInterval(async () => {
        await this.trigger(
          { type: 'schedule', data: { hookId: hook.id }, timestamp: new Date() },
          {
            schedule: {
              cronExpression,
              scheduledTime: new Date(),
            },
          }
        );
      }, interval);

      this.scheduledJobs.set(hook.id, job);
      coreLogger.debug({ hookId: hook.id, intervalMs: interval }, 'Scheduled hook set up');
    }
  }

  /**
   * Parse cron expression to interval (simplified)
   */
  private parseCronToInterval(cron: string): number | null {
    // Very simplified cron parsing - handle common patterns
    const parts = cron.split(' ');

    // Every minute: * * * * *
    if (parts.length === 5 && parts[0] === '*') {
      return 60 * 1000;
    }

    // Every N minutes: */N * * * *
    const minuteMatch = parts[0]?.match(/^\*\/(\d+)$/);
    if (minuteMatch) {
      return parseInt(minuteMatch[1], 10) * 60 * 1000;
    }

    // Every hour: 0 * * * *
    if (parts[0] === '0' && parts[1] === '*') {
      return 60 * 60 * 1000;
    }

    // Every N hours: 0 */N * * *
    const hourMatch = parts[1]?.match(/^\*\/(\d+)$/);
    if (parts[0] === '0' && hourMatch) {
      return parseInt(hourMatch[1], 10) * 60 * 60 * 1000;
    }

    return null;
  }

  /**
   * Clean up scheduled jobs
   */
  cleanup(): void {
    for (const job of this.scheduledJobs.values()) {
      clearInterval(job);
    }
    this.scheduledJobs.clear();
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
