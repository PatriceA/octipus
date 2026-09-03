import { PubSub, Queue, rawStore } from '@/db/cache';
import { generateId } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';
import type { Task } from './types';
import { spawnProcess } from '@/utils/proc';

const TASK_QUEUE = 'tasks:queue';
const TASK_CHANNEL = 'tasks:events';
const HEARTBEAT_KEY = 'scheduler:heartbeat';
/** Don't hammer the storage provider: refresh the heartbeat at most this often. */
const HEARTBEAT_WRITE_INTERVAL_MS = 5_000;
/** A heartbeat older than this means the ticker is wedged or dead. */
export const HEARTBEAT_STALE_MS = 30_000;

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
  /**
   * True when the gate could not be *evaluated* (threw, timed out, or has no
   * registered evaluator) — i.e. execution-context drift, not a legitimate
   * "not now". A legitimate skip (`run:false, error:false`) may recur for
   * hours (off-hours window); a drift skip fails the task closed after a small
   * cap rather than deferring forever. See `Scheduler.worker`.
   */
  error?: boolean;
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
  /**
   * If set, a task that becomes due more than this many ms in the past (e.g.
   * the process was down across its fire time) is dropped once with a
   * `skipped_missed` event instead of running stale. Unset ⇒ run whenever due,
   * however late. Prevents a wedged/restarted scheduler from firing a burst of
   * long-overdue work.
   */
  missedGraceMs?: number;
  /** Consecutive *drift* skips (gate could not be evaluated). Reset on any run. */
  consecutiveDriftSkips: number;
  /** Cap on drift skips before the task fails closed. Legit skips never count. */
  maxDriftSkips: number;
}

export interface TaskEvent {
  type:
    | 'created'
    | 'started'
    | 'completed'
    | 'failed'
    | 'retried'
    | 'skipped_by_wakegate'
    | 'skipped_missed';
  taskId: string;
  agentId?: string;
  payload?: unknown;
  timestamp: Date;
}

/** Default drift-skip cap: ~5 min of 30s re-checks before failing closed. */
export const DEFAULT_MAX_DRIFT_SKIPS = 10;

export type WakeGateDecision = 'run' | 'defer' | 'fail_closed';

/**
 * Pure wake-gate decision — no IO, unit-testable. Given a gate result and the
 * task's current drift count, decide whether to run, defer to the next tick, or
 * fail the task closed. Only *drift* skips (gate unevaluable) accrue toward the
 * cap; a legitimate "not now" defers indefinitely and resets the counter.
 */
export function decideWakeGate(
  gate: WakeGateResult,
  consecutiveDriftSkips: number,
  maxDriftSkips: number,
): { decision: WakeGateDecision; nextDriftSkips: number } {
  if (gate.run) return { decision: 'run', nextDriftSkips: 0 };
  if (gate.error) {
    const next = consecutiveDriftSkips + 1;
    return { decision: next >= maxDriftSkips ? 'fail_closed' : 'defer', nextDriftSkips: next };
  }
  return { decision: 'defer', nextDriftSkips: 0 };
}

export type Dueness = 'not_yet' | 'due' | 'missed';

/**
 * Pure due-ness classifier — no IO, unit-testable. A task is `missed` only when
 * a grace window is configured and it is overdue beyond it; otherwise a
 * past-due task is `due` (runs however late) and a future task is `not_yet`.
 */
export function classifyDueness(scheduledAt: Date, now: Date, missedGraceMs?: number): Dueness {
  if (scheduledAt.getTime() > now.getTime()) return 'not_yet';
  if (missedGraceMs !== undefined && now.getTime() - scheduledAt.getTime() > missedGraceMs) {
    return 'missed';
  }
  return 'due';
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
      const proc = spawnProcess(['sh', '-c', gate.cmd], { stdout: 'pipe', stderr: 'pipe' });
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
        // Config drift: a tool gate exists but nothing wired an evaluator. This
        // will never pass on its own — mark it so the worker fails closed.
        return { run: false, reason: 'no tool evaluator registered', error: true };
      }
      const result = await wakeGateToolEvaluator(gate.toolName, gate.params);
      if (result) return { run: true, reason: `tool ${gate.toolName} returned truthy` };
      return { run: false, reason: `tool ${gate.toolName} returned falsy` };
    }
    return { run: false, reason: `unknown gate kind`, error: true };
  } catch (err) {
    return { run: false, reason: `gate error: ${(err as Error).message}`, error: true };
  }
}

export class Scheduler {
  private queue: Queue;
  private pubsub: PubSub;
  private processing: Map<string, ScheduledTask> = new Map();
  private taskHandlers: Map<string, (task: ScheduledTask) => Promise<unknown>> = new Map();
  private lastHeartbeatWrite = 0;
  private running = false;
  private workerLoops: Promise<void>[] = [];

  constructor() {
    this.queue = new Queue(TASK_QUEUE);
    this.pubsub = new PubSub();
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
      missedGraceMs?: number;
      maxDriftSkips?: number;
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
      consecutiveDriftSkips: 0,
      maxDriftSkips: options?.maxDriftSkips ?? DEFAULT_MAX_DRIFT_SKIPS,
      ...(options?.wakeGate ? { wakeGate: options.wakeGate } : {}),
      ...(options?.missedGraceMs !== undefined ? { missedGraceMs: options.missedGraceMs } : {}),
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

    // scheduledAt comes back as a string after the JSON round-trip through storage; coerce before comparing
    const scheduledAt = task.scheduledAt instanceof Date ? task.scheduledAt : new Date(task.scheduledAt);
    // Tasks enqueued before this field existed round-trip without it; default in.
    task.consecutiveDriftSkips ??= 0;
    task.maxDriftSkips ??= DEFAULT_MAX_DRIFT_SKIPS;

    const dueness = classifyDueness(scheduledAt, new Date(), task.missedGraceMs);
    if (dueness === 'not_yet') {
      await this.queue.push(task, task.priority - 1);
      return null;
    }
    if (dueness === 'missed') {
      // Overdue beyond its grace window — drop once, fail loud via an event.
      // Not re-queued: running long-stale work (a 9am report at 3pm) is worse
      // than skipping it, and re-queuing would just re-trip this every tick.
      const lateMs = Date.now() - scheduledAt.getTime();
      coreLogger.warn(
        { taskId: task.id, type: task.type, lateMs, missedGraceMs: task.missedGraceMs },
        'Task skipped: overdue beyond missed-grace window',
      );
      await this.publishEvent({
        type: 'skipped_missed',
        taskId: task.id,
        agentId: task.agentId,
        payload: { lateMs, missedGraceMs: task.missedGraceMs, scheduledAt },
        timestamp: new Date(),
      });
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
   * Start draining the queue with `concurrency` worker loops. Non-blocking and
   * idempotent — call once at boot. Without this, `schedule()` fills the
   * queue but nothing ever runs the tasks (e.g. artifact cleanup). Stop it with
   * `stop()` during graceful shutdown.
   */
  start(concurrency: number = 5): void {
    if (this.running) return;
    this.running = true;
    this.workerLoops = [];
    for (let i = 0; i < concurrency; i++) {
      this.workerLoops.push(this.worker());
    }
    coreLogger.info({ concurrency }, 'Scheduler worker loop started');
  }

  /**
   * Signal the worker loops to exit and await their in-flight iteration. The
   * loops check `running` each pass and the idle wait is 100ms, so this resolves
   * quickly. Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await Promise.allSettled(this.workerLoops);
    this.workerLoops = [];
    coreLogger.info('Scheduler worker loop stopped');
  }

  /**
   * Process tasks in the queue until `stop()` is called. Blocking form of
   * `start()` — mainly for tests/scripts that want to await the loops.
   */
  async processQueue(concurrency: number = 5): Promise<void> {
    this.start(concurrency);
    await Promise.all(this.workerLoops);
  }

  /**
   * Single worker that processes tasks
   */
  private async worker(): Promise<void> {
    while (this.running) {
      await this.maybeWriteHeartbeat();
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

      // Wake-gate: evaluate just before execution.
      if (task.wakeGate) {
        const gateResult = await evaluateWakeGate(task.wakeGate);
        // getNextTask() already defaulted these on any task it returns.
        const { decision, nextDriftSkips } = decideWakeGate(
          gateResult,
          task.consecutiveDriftSkips,
          task.maxDriftSkips,
        );
        task.consecutiveDriftSkips = nextDriftSkips;

        if (decision === 'fail_closed') {
          const reason = `wake-gate unevaluable ${nextDriftSkips}× (last: ${gateResult.reason})`;
          coreLogger.warn({ taskId: task.id, type: task.type, reason }, 'Task failed closed: wake-gate drift');
          await this.publishEvent({
            type: 'failed',
            taskId: task.id,
            agentId: task.agentId,
            payload: { error: reason, driftSkips: nextDriftSkips },
            timestamp: new Date(),
          });
          continue; // dropped — not re-queued
        }

        if (decision === 'defer') {
          coreLogger.info(
            { taskId: task.id, type: task.type, reason: gateResult.reason, drift: gateResult.error ?? false },
            'Task skipped by wake-gate',
          );
          await this.publishEvent({
            type: 'skipped_by_wakegate',
            taskId: task.id,
            agentId: task.agentId,
            payload: { reason: gateResult.reason, drift: gateResult.error ?? false, driftSkips: nextDriftSkips },
            timestamp: new Date(),
          });
          // Defer to next tick without counting as an attempt.
          task.scheduledAt = new Date(Date.now() + 30_000);
          await this.queue.push(task, task.priority);
          continue;
        }
        // decision === 'run' — drift already cleared to 0; fall through.
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
   * Refresh the liveness heartbeat, throttled to HEARTBEAT_WRITE_INTERVAL_MS.
   * Writing from the worker loop (even when idle) is what lets a separate
   * process — `octi doctor`, a health endpoint — tell a live-but-idle
   * scheduler from a wedged one. Best-effort: a storage blip must not kill the
   * worker loop, so failures are logged and swallowed.
   */
  private async maybeWriteHeartbeat(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHeartbeatWrite < HEARTBEAT_WRITE_INTERVAL_MS) return;
    this.lastHeartbeatWrite = now;
    try {
      await rawStore().set(HEARTBEAT_KEY, String(now));
    } catch (err) {
      coreLogger.warn({ err: (err as Error).message }, 'Scheduler heartbeat write failed');
    }
  }

  /**
   * Last heartbeat as a Date, or null if the scheduler has never ticked.
   * `stale` is true when it is older than HEARTBEAT_STALE_MS (ticker wedged).
   */
  async getHeartbeat(): Promise<{ at: Date; ageMs: number; stale: boolean } | null> {
    const raw = await rawStore().get(HEARTBEAT_KEY);
    if (!raw) return null;
    const ms = Number(raw);
    if (!Number.isFinite(ms)) return null;
    const ageMs = Date.now() - ms;
    return { at: new Date(ms), ageMs, stale: ageMs > HEARTBEAT_STALE_MS };
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    queueLength: number;
    processing: number;
    heartbeat: { at: Date; ageMs: number; stale: boolean } | null;
  }> {
    return {
      queueLength: await this.queue.length(),
      processing: this.processing.size,
      heartbeat: await this.getHeartbeat(),
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
