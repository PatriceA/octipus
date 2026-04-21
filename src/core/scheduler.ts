import { RedisPubSub, RedisQueue } from '@/db/redis';
import { generateId } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';
import type { Task } from './types';

const TASK_QUEUE = 'tasks:queue';
const TASK_CHANNEL = 'tasks:events';

/**
 * Wake-gate config — evaluated JUST BEFORE a scheduled task runs.
 * If the gate says "skip", the task is deferred to the next tick rather than
 * executing. Used for upstream-dependency checks, feature flags, off-hours
 * windows, low-resource signals, etc.
 */
export type WakeGate =
  | { kind: 'command'; cmd: string; timeoutMs?: number }
  | { kind: 'http'; url: string; expectStatus?: number }
  | { kind: 'tool'; toolName: string; params: Record<string, unknown> };

export interface WakeGateResult {
  run: boolean;
  reason: string;
}

/**
 * Tool evaluator hook. Optional — only required if any scheduled task uses
 * a `tool` wake-gate. Consumers wire this up at boot via `registerWakeGateToolEvaluator`.
 */
export type WakeGateToolEvaluator = (
  toolName: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export interface ScheduledTask extends Task {
  scheduledAt: Date;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  wakeGate?: WakeGate;
}

export interface TaskEvent {
  type:
    | 'created'
    | 'started'
    | 'completed'
    | 'failed'
    | 'retried'
    | 'skipped_by_wakegate';
  taskId: string;
  agentId?: string;
  payload?: unknown;
  timestamp: Date;
}

let wakeGateToolEvaluator: WakeGateToolEvaluator | null = null;

/**
 * Wire up a tool evaluator so `wakeGate.kind='tool'` gates can actually run.
 * Called at boot once the tool registry exists. Safe to call multiple times.
 */
export function registerWakeGateToolEvaluator(fn: WakeGateToolEvaluator): void {
  wakeGateToolEvaluator = fn;
}

/**
 * Evaluate a wake-gate. Throws only on programmer errors; runtime failures
 * resolve to `{run: false, reason}` so the caller can log + skip safely.
 */
export async function evaluateWakeGate(gate: WakeGate): Promise<WakeGateResult> {
  try {
    if (gate.kind === 'command') {
      const timeoutMs = gate.timeoutMs ?? 5000;
      const proc = Bun.spawn(['sh', '-c', gate.cmd], { stdout: 'pipe', stderr: 'pipe' });
      const timer = setTimeout(() => proc.kill(), timeoutMs);
      const exit = await proc.exited;
      clearTimeout(timer);
      if (exit === 0) return { run: true, reason: `command exit 0` };
      return { run: false, reason: `command exit ${exit}` };
    }
    if (gate.kind === 'http') {
      const expect = gate.expectStatus ?? 200;
      const res = await fetch(gate.url, { signal: AbortSignal.timeout(5000) });
      if (res.status === expect) return { run: true, reason: `http ${res.status}` };
      return { run: false, reason: `http ${res.status} !== ${expect}` };
    }
    if (gate.kind === 'tool') {
      if (!wakeGateToolEvaluator) {
        return { run: false, reason: 'no tool evaluator registered' };
      }
      const result = await wakeGateToolEvaluator(gate.toolName, gate.params);
      if (result) return { run: true, reason: `tool ${gate.toolName} returned truthy` };
      return { run: false, reason: `tool ${gate.toolName} returned falsy` };
    }
    return { run: false, reason: `unknown gate kind` };
  } catch (err) {
    return { run: false, reason: `gate error: ${(err as Error).message}` };
  }
}

export class Scheduler {
  private queue: RedisQueue;
  private pubsub: RedisPubSub;
  private processing: Map<string, ScheduledTask> = new Map();
  private taskHandlers: Map<string, (task: ScheduledTask) => Promise<unknown>> = new Map();

  constructor() {
    this.queue = new RedisQueue(TASK_QUEUE);
    this.pubsub = new RedisPubSub();
  }

  /**
   * Schedule a new task
   */
  async schedule(
    agentId: string,
    type: string,
    payload: Record<string, unknown>,
    options?: {
      priority?: number;
      maxAttempts?: number;
      delayMs?: number;
      wakeGate?: WakeGate;
    }
  ): Promise<string> {
    const taskId = generateId();

    const task: ScheduledTask = {
      id: taskId,
      agentId,
      type,
      priority: options?.priority || 0,
      payload,
      status: 'pending',
      createdAt: new Date(),
      scheduledAt: options?.delayMs
        ? new Date(Date.now() + options.delayMs)
        : new Date(),
      attempts: 0,
      maxAttempts: options?.maxAttempts || 3,
      backoffMs: 1000,
      ...(options?.wakeGate ? { wakeGate: options.wakeGate } : {}),
    };

    await this.queue.push(task, task.priority);

    await this.publishEvent({
      type: 'created',
      taskId,
      agentId,
      payload,
      timestamp: new Date(),
    });

    coreLogger.debug({ taskId, type, agentId, priority: task.priority }, 'Task scheduled');

    return taskId;
  }

  /**
   * Get the next task from the queue
   */
  async getNextTask(): Promise<ScheduledTask | null> {
    const task = await this.queue.pop() as ScheduledTask | null;

    if (!task) return null;

    // scheduledAt comes back as a string after Redis JSON round-trip; coerce before comparing
    const scheduledAt = task.scheduledAt instanceof Date ? task.scheduledAt : new Date(task.scheduledAt);
    if (scheduledAt > new Date()) {
      await this.queue.push(task, task.priority - 1);
      return null;
    }

    task.scheduledAt = scheduledAt;
    return task;
  }

  /**
   * Mark a task as started
   */
  async startTask(task: ScheduledTask): Promise<void> {
    task.status = 'running';
    task.startedAt = new Date();
    task.attempts++;

    this.processing.set(task.id, task);

    await this.publishEvent({
      type: 'started',
      taskId: task.id,
      agentId: task.agentId,
      timestamp: new Date(),
    });

    coreLogger.debug({ taskId: task.id, attempt: task.attempts }, 'Task started');
  }

  /**
   * Mark a task as completed
   */
  async completeTask(taskId: string, result?: unknown): Promise<void> {
    const task = this.processing.get(taskId);
    if (!task) return;

    task.status = 'completed';
    task.completedAt = new Date();
    task.result = result;

    this.processing.delete(taskId);

    await this.publishEvent({
      type: 'completed',
      taskId,
      agentId: task.agentId,
      payload: result,
      timestamp: new Date(),
    });

    coreLogger.debug({ taskId, duration: task.completedAt.getTime() - task.startedAt!.getTime() }, 'Task completed');
  }

  /**
   * Mark a task as failed
   */
  async failTask(taskId: string, error: string): Promise<void> {
    const task = this.processing.get(taskId);
    if (!task) return;

    // Check if we should retry
    if (task.attempts < task.maxAttempts) {
      await this.retryTask(task, error);
      return;
    }

    task.status = 'failed';
    task.completedAt = new Date();
    task.error = error;

    this.processing.delete(taskId);

    await this.publishEvent({
      type: 'failed',
      taskId,
      agentId: task.agentId,
      payload: { error },
      timestamp: new Date(),
    });

    coreLogger.warn({ taskId, error, attempts: task.attempts }, 'Task failed');
  }

  /**
   * Retry a failed task
   */
  private async retryTask(task: ScheduledTask, error: string): Promise<void> {
    const backoff = task.backoffMs * Math.pow(2, task.attempts - 1);

    task.status = 'pending';
    task.scheduledAt = new Date(Date.now() + backoff);
    task.backoffMs = backoff;

    this.processing.delete(task.id);

    await this.queue.push(task, task.priority);

    await this.publishEvent({
      type: 'retried',
      taskId: task.id,
      agentId: task.agentId,
      payload: { error, nextAttempt: task.scheduledAt, attempt: task.attempts },
      timestamp: new Date(),
    });

    coreLogger.debug({ taskId: task.id, attempt: task.attempts, nextAttemptIn: backoff }, 'Task scheduled for retry');
  }

  /**
   * Register a task handler
   */
  registerHandler(type: string, handler: (task: ScheduledTask) => Promise<unknown>): void {
    this.taskHandlers.set(type, handler);
    coreLogger.debug({ type }, 'Task handler registered');
  }

  /**
   * Process tasks in the queue
   */
  async processQueue(concurrency: number = 5): Promise<void> {
    const workers: Promise<void>[] = [];

    for (let i = 0; i < concurrency; i++) {
      workers.push(this.worker());
    }

    await Promise.all(workers);
  }

  /**
   * Single worker that processes tasks
   */
  private async worker(): Promise<void> {
    while (true) {
      const task = await this.getNextTask();

      if (!task) {
        // No tasks available, wait a bit
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      const handler = this.taskHandlers.get(task.type);
      if (!handler) {
        coreLogger.warn({ taskId: task.id, type: task.type }, 'No handler for task type');
        await this.failTask(task.id, `No handler for task type: ${task.type}`);
        continue;
      }

      // Wake-gate: evaluate just before execution; on skip, re-queue for next tick.
      if (task.wakeGate) {
        const gateResult = await evaluateWakeGate(task.wakeGate);
        if (!gateResult.run) {
          coreLogger.info(
            { taskId: task.id, type: task.type, reason: gateResult.reason },
            'Task skipped by wake-gate',
          );
          await this.publishEvent({
            type: 'skipped_by_wakegate',
            taskId: task.id,
            agentId: task.agentId,
            payload: { reason: gateResult.reason },
            timestamp: new Date(),
          });
          // Defer to next tick without counting as an attempt.
          task.scheduledAt = new Date(Date.now() + 30_000);
          await this.queue.push(task, task.priority);
          continue;
        }
      }

      await this.startTask(task);

      try {
        const result = await handler(task);
        await this.completeTask(task.id, result);
      } catch (error) {
        await this.failTask(task.id, (error as Error).message);
      }
    }
  }

  /**
   * Publish a task event
   */
  private async publishEvent(event: TaskEvent): Promise<void> {
    await this.pubsub.publish(TASK_CHANNEL, event);
  }

  /**
   * Subscribe to task events
   */
  async subscribeToEvents(handler: (event: TaskEvent) => void): Promise<() => void> {
    await this.pubsub.subscribe(TASK_CHANNEL, handler as (message: unknown) => void);
    return () => this.pubsub.unsubscribe(TASK_CHANNEL, handler as (message: unknown) => void);
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    queueLength: number;
    processing: number;
  }> {
    return {
      queueLength: await this.queue.length(),
      processing: this.processing.size,
    };
  }

  /**
   * Clear the queue
   */
  async clearQueue(): Promise<void> {
    await this.queue.clear();
    this.processing.clear();
    coreLogger.info('Task queue cleared');
  }
}

// Singleton instance
let schedulerInstance: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!schedulerInstance) {
    schedulerInstance = new Scheduler();
  }
  return schedulerInstance;
}
