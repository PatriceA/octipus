/**
 * Dependency wakeups — what closing a task sets free (Paperclip's
 * `issue_blockers_resolved` / `issue_children_completed`).
 *
 * When a task leaves the active set (open, in progress) — closed as done
 * or archived, or deleted while still active — two kinds of task may have
 * been waiting on it:
 *
 *   - `task.unblocked`: an active task whose `blockedBy` holds that id and
 *     which, now, has no active blocker left. One of two blockers closing
 *     wakes nobody; the last one does.
 *   - `task.children_completed`: its parent, when the parent is still active
 *     and none of its children is.
 *
 * "Waiting" is decided by `waitingOn` in ./structure.ts, the rule the ranker
 * and the tasks page use, so a task is woken exactly when it stops showing
 * as blocked / waiting on sub-tasks. One difference, on purpose: a blocker
 * id that exists but that the owner cannot read (`unknownIds`) counts as an
 * active blocker here — a wakeup must never be a false positive.
 *
 * Flow: `ScopedTaskRepo.update` / `.delete` (the only ways out of the active
 * set) detect the transition atomically (a guarded UPDATE, DELETE …
 * RETURNING), then `scheduleWakeup` runs, detached from the request: the repo
 * loads the candidate rows for the task's owner (`wakeupContext`) and calls
 * `dispatchWakeups`, which runs the pure `computeWakeups`, emits one typed
 * event per woken task and files one notification per woken task. Errors are
 * caught and logged; nothing here can fail or slow the write. Tests await
 * `flushWakeups()`.
 *
 * In-process only: this works on embedded PGlite and a single server
 * process. Delivering wakeups across processes would need Postgres
 * LISTEN/NOTIFY, the way db/task-state-listener.ts fans out task_state.
 *
 * Consumers (a later slice wakes role agents) subscribe with
 * `taskWakeups.on('task.unblocked' | 'task.children_completed', handler)` or
 * `onTaskWakeup(handler)` for both; the payload type is `TaskWakeupEvent`.
 * Listeners are called one by one; a throw or a rejected promise from one is
 * logged and never reaches the others or the write.
 */
import { EventEmitter } from 'node:events';
import { getNotificationService } from '@/core/notification-service';
import type { Task } from '@/db/schema/tasks';
import { coreLogger } from '@/utils/logger';
import { isActiveStatus } from './status';
import { type StructuredTask, toLookup, waitingOn } from './structure';

export const TASK_WAKEUP_TYPES = ['task.unblocked', 'task.children_completed'] as const;
export type TaskWakeupType = (typeof TASK_WAKEUP_TYPES)[number];

/** How the triggering task left the active set. */
export type WakeupCause = 'closed' | 'deleted';

/** Payload of both wakeup events. */
export interface TaskWakeupEvent {
  type: TaskWakeupType;
  userId: string;
  workspaceId: string | null;
  /** The task that was woken (unblocked, or the parent whose children are all closed). */
  taskId: string;
  /** Title of the woken task, for messages. */
  title: string;
  /** The task whose close (or delete) caused the wakeup. */
  triggeredBy: string;
  cause: WakeupCause;
}

type WakeupEvents = {
  [K in TaskWakeupType]: [TaskWakeupEvent];
};

/** The in-process wakeup bus. Emit through `emitSafely`, not `.emit`. */
export const taskWakeups = new EventEmitter<WakeupEvents>();

/** Subscribe to both wakeup kinds. Returns an unsubscribe function. */
export function onTaskWakeup(handler: (event: TaskWakeupEvent) => unknown): () => void {
  for (const type of TASK_WAKEUP_TYPES) taskWakeups.on(type, handler);
  return () => {
    for (const type of TASK_WAKEUP_TYPES) taskWakeups.off(type, handler);
  };
}

/**
 * Call each listener on its own: a sync throw is caught, a returned promise
 * gets a `.catch`, so one bad listener cannot stop the rest or surface as an
 * unhandled rejection.
 */
export function emitSafely(event: TaskWakeupEvent): void {
  for (const listener of taskWakeups.listeners(event.type)) {
    const fail = (err: unknown) => coreLogger.error({ err, type: event.type, taskId: event.taskId }, 'Task wakeup listener failed');
    try {
      const result: unknown = (listener as (e: TaskWakeupEvent) => unknown)(event);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(result).catch(fail);
      }
    } catch (err) {
      fail(err);
    }
  }
}

export interface ComputedWakeups<T extends StructuredTask> {
  /** Active tasks the close left with no active blocker. */
  unblocked: T[];
  /** The closed task's parent, when it is active and has no active child left. */
  childrenCompleted: T | null;
}

/**
 * Pure: which tasks `closed` leaving the active set woke, given the rows
 * around it. `previousStatus` is the status before the write; anything but
 * an active → closed transition wakes nobody, so re-closing a done task
 * never fires twice. `rows` should hold the dependents, their blockers, the
 * parent and its active children; `closed` (with its new status) overrides
 * any stale copy. `unknownIds` are blocker ids that exist but are unreadable:
 * they count as active. For a delete, pass `closed` with a non-active status.
 */
export function computeWakeups<T extends StructuredTask>(
  closed: T,
  previousStatus: string,
  rows: readonly T[],
  unknownIds: readonly string[] = [],
): ComputedWakeups<T> {
  const none: ComputedWakeups<T> = { unblocked: [], childrenCompleted: null };
  if (!isActiveStatus(previousStatus) || isActiveStatus(closed.status)) return none;
  const lookup = toLookup<StructuredTask>(rows);
  for (const id of unknownIds) if (!lookup.has(id)) lookup.set(id, { id, title: '(unknown)', status: 'open' });
  lookup.set(closed.id, closed);

  const unblocked: T[] = [];
  for (const row of rows) {
    if (row.id === closed.id || !isActiveStatus(row.status)) continue;
    if (!(row.blockedBy ?? []).includes(closed.id)) continue;
    if (waitingOn(row, lookup).blockers.length === 0 && !unblocked.includes(row)) unblocked.push(row);
  }

  let childrenCompleted: T | null = null;
  const parent = closed.parentId ? rows.find((r) => r.id === closed.parentId) : undefined;
  if (parent && parent.id !== closed.id && isActiveStatus(parent.status) && waitingOn(parent, lookup).openChildren === 0) {
    childrenCompleted = parent;
  }
  return { unblocked, childrenCompleted };
}

// ── Detached execution ─────────────────────────────────────────────────

const pending = new Set<Promise<void>>();

/** Run `work` detached from the caller; errors are logged, never thrown. */
export function scheduleWakeup(work: () => Promise<void>): void {
  const run = Promise.resolve()
    .then(work)
    .catch((err) => coreLogger.error({ err }, 'Task wakeups failed'))
    .finally(() => pending.delete(run));
  pending.add(run);
}

/** Wait for every scheduled wakeup (tests, graceful shutdown). */
export async function flushWakeups(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

// ── Dispatch ───────────────────────────────────────────────────────────

export interface WakeupInput {
  closed: Task;
  previousStatus: string;
  cause: WakeupCause;
  rows: Task[];
  unknownIds: string[];
}

/**
 * Compute, emit and notify for one close. At most one event per woken task
 * and kind, and one notification per woken task (a task both unblocked and
 * parent-completed by one close gets a single, combined notification).
 */
export async function dispatchWakeups(input: WakeupInput): Promise<TaskWakeupEvent[]> {
  const { closed, previousStatus, cause, rows, unknownIds } = input;
  const subject = cause === 'deleted' ? { ...closed, status: 'deleted' } : closed;
  const { unblocked, childrenCompleted } = computeWakeups(subject, previousStatus, rows, unknownIds);

  const base = { userId: closed.userId, workspaceId: closed.workspaceId ?? null, triggeredBy: closed.id, cause };
  const events: TaskWakeupEvent[] = unblocked.map((t) => ({ ...base, type: 'task.unblocked', taskId: t.id, title: t.title }));
  if (childrenCompleted) {
    events.push({ ...base, type: 'task.children_completed', taskId: childrenCompleted.id, title: childrenCompleted.title });
  }
  for (const event of events) emitSafely(event);

  const byTask = new Map<string, TaskWakeupEvent[]>();
  for (const event of events) byTask.set(event.taskId, [...(byTask.get(event.taskId) ?? []), event]);
  const notifications = getNotificationService();
  for (const [taskId, taskEvents] of byTask) {
    const { title } = taskEvents[0];
    const kinds = taskEvents.map((e) => e.type);
    const unblockedToo = kinds.includes('task.unblocked');
    const message = unblockedToo && kinds.includes('task.children_completed')
      ? `“${title}” is unblocked and all its sub-tasks are done`
      : unblockedToo
        ? `“${title}” is unblocked`
        : `All sub-tasks of “${title}” are done`;
    await notifications.notify(
      closed.userId,
      unblockedToo ? 'task_unblocked' : 'task_children_completed',
      message,
      `Triggered by ${cause === 'deleted' ? 'deleting' : 'closing'} “${closed.title}”.`,
      { taskId, triggeredBy: closed.id, workspaceId: base.workspaceId, wakeups: kinds, cause },
    );
  }
  return events;
}
