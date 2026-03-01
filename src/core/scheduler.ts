import { RedisQueue, RedisPubSub } from '@/db/redis';
import { coreLogger } from '@/utils/logger';
import type { Task } from './types';
import { generateId } from '@/utils/crypto';

const TASK_QUEUE = 'tasks:queue';
const TASK_CHANNEL = 'tasks:events';

export interface ScheduledTask extends Task {
  scheduledAt: Date;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
}

export interface TaskEvent {
  type: 'created' | 'started' | 'completed' | 'failed' | 'retried';
  taskId: string;
  agentId?: string;
  payload?: unknown;
  timestamp: Date;
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

    // Check if it's time to execute
    if (task.scheduledAt > new Date()) {
      // Re-queue with adjusted priority
      await this.queue.push(task, task.priority - 1);
      return null;
    }

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
