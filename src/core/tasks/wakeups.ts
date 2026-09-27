/**
 * Dependency wakeups — what closing a task sets free (Paperclip's
 * `issue_blockers_resolved` / `issue_children_completed`).
 *
 * When a task moves from an active status (open, in progress) to a closed
 * one (done, archived), two kinds of task may have been waiting on it:
 *
 *   - `task.unblocked`: an active task whose `blockedBy` holds the closed id
 *     and which, now, has no active blocker left. One of two blockers
 *     closing wakes nobody; the last one does.
 *   - `task.children_completed`: the closed task's parent, when it is still
 *     active and none of its children is.
 *
 * "Waiting" is decided by `waitingOn` in ./structure.ts, the same rule the
 * ranker and the tasks page use, so a task is woken exactly when it stops
 * showing as blocked / waiting on sub-tasks.
 *
 * Flow: `ScopedTaskRepo.update` (the one path every close takes) detects
 * the active → closed transition and calls `onTaskClosed`, which reads the
 * candidate rows through `ScopedTaskRepo.wakeupContext` (the closed task's
 * owner and the principal's workspace scope; never another tenant), runs
 * the pure `computeWakeups`, emits typed events on `taskWakeups`, and files
 * one notification per woken task. Everything is caught and logged by the
 * caller: a wakeup never fails the write.
 *
 * Coalescing: a task is woken at most once per close (a task both
 * unblocked and parent-completed by one close gets one notification), and
 * the same wakeup (kind + task) is suppressed for COALESCE_MS so a burst of
 * closes — sub-tasks bulk-completed, two last children closed concurrently —
 * does not spam the user or double-wake an agent.
 *
 * In-process only: this works on embedded PGlite and a single server
 * process. Delivering wakeups across processes would need Postgres
 * LISTEN/NOTIFY, the way db/task-state-listener.ts fans out task_state.
 *
 * Consumers (a later slice wakes role agents) subscribe with
 * `taskWakeups.on('task.unblocked' | 'task.children_completed', handler)`
 * or `onTaskWakeup(handler)` for both; the payload type is `TaskWakeupEvent`.
 */
import { EventEmitter } from 'node:events';
import { getNotificationService } from '@/core/notification-service';
import type { Task } from '@/db/schema/tasks';
import type { Principal } from '@/security/principal';
import { coreLogger } from '@/utils/logger';
import { isActiveStatus } from './status';
import { type StructuredTask, toLookup, waitingOn } from './structure';

export const TASK_WAKEUP_TYPES = ['task.unblocked', 'task.children_completed'] as const;
export type TaskWakeupType = (typeof TASK_WAKEUP_TYPES)[number];

/** Payload of both wakeup events. */
export interface TaskWakeupEvent {
  type: TaskWakeupType;
  userId: string;
  workspaceId: string | null;
  /** The task that was woken (unblocked, or the parent whose children are all closed). */
  taskId: string;
  /** Title of the woken task, for messages. */
  title: string;
  /** The task whose close caused the wakeup. */
  triggeredBy: string;
}

type WakeupEvents = {
  [K in TaskWakeupType]: [TaskWakeupEvent];
};

/** The in-process wakeup bus. */
export const taskWakeups = new EventEmitter<WakeupEvents>();

/** Subscribe to both wakeup kinds. Returns an unsubscribe function. */
export function onTaskWakeup(handler: (event: TaskWakeupEvent) => void): () => void {
  for (const type of TASK_WAKEUP_TYPES) taskWakeups.on(type, handler);
  return () => {
    for (const type of TASK_WAKEUP_TYPES) taskWakeups.off(type, handler);
  };
}

export interface ComputedWakeups<T extends StructuredTask> {
  /** Active tasks the close left with no active blocker. */
  unblocked: T[];
  /** The closed task's parent, when it is active and has no active child left. */
  childrenCompleted: T | null;
}

/**
 * Pure: which tasks closing `closed` woke, given the rows around it.
 * `previousStatus` is the status before the write; anything but an
 * active → closed transition wakes nobody (so re-closing a done task, or
 * archiving a done one, never fires twice). `rows` should hold the
 * dependents, their blockers, the parent and its children; `closed` itself
 * (with its new status) overrides any stale copy in `rows`.
 */
export function computeWakeups<T extends StructuredTask>(
  closed: T,
  previousStatus: string,
  rows: readonly T[],
): ComputedWakeups<T> {
  const none: ComputedWakeups<T> = { unblocked: [], childrenCompleted: null };
  if (!isActiveStatus(previousStatus) || isActiveStatus(closed.status)) return none;
  const lookup = toLookup(rows);
  lookup.set(closed.id, closed);

  const unblocked: T[] = [];
  for (const row of lookup.values()) {
    if (row.id === closed.id || !isActiveStatus(row.status)) continue;
    if (!(row.blockedBy ?? []).includes(closed.id)) continue;
    if (waitingOn(row, lookup).blockers.length === 0) unblocked.push(row);
  }

  let childrenCompleted: T | null = null;
  const parent = closed.parentId ? lookup.get(closed.parentId) : undefined;
  if (parent && parent.id !== closed.id && isActiveStatus(parent.status) && waitingOn(parent, lookup).openChildren === 0) {
    childrenCompleted = parent;
  }
  return { unblocked, childrenCompleted };
}

/** Suppress a repeat of the same wakeup (kind + task) within this window. */
export const COALESCE_MS = 10_000;
const recent = new Map<string, number>();

function firstInWindow(key: string, now: number): boolean {
  for (const [k, at] of recent) if (now - at > COALESCE_MS) recent.delete(k);
  if (recent.has(key)) return false;
  recent.set(key, now);
  return true;
}

/** Test-only: forget recent wakeups. */
export function resetWakeupCoalescing(): void {
  recent.clear();
}

/**
 * Called by `ScopedTaskRepo.update` after a write moved `closed` from an
 * active status to a closed one. Reads within the principal's tenant scope,
 * emits the events, and notifies the owner once per woken task.
 */
export async function onTaskClosed(principal: Principal, closed: Task): Promise<TaskWakeupEvent[]> {
  const { scopedRepos } = await import('@/db/repositories/scoped');
  const rows = await scopedRepos(principal).tasks.wakeupContext(closed);
  // The repo only calls us on a real transition; 'open' stands in for "was active".
  const { unblocked, childrenCompleted } = computeWakeups(closed, 'open', rows);

  const now = Date.now();
  const base = { userId: closed.userId, workspaceId: closed.workspaceId ?? null, triggeredBy: closed.id };
  const events: TaskWakeupEvent[] = [];
  for (const t of unblocked) {
    if (firstInWindow(`task.unblocked:${t.id}`, now)) events.push({ ...base, type: 'task.unblocked', taskId: t.id, title: t.title });
  }
  if (childrenCompleted && firstInWindow(`task.children_completed:${childrenCompleted.id}`, now)) {
    events.push({ ...base, type: 'task.children_completed', taskId: childrenCompleted.id, title: childrenCompleted.title });
  }

  for (const event of events) {
    try {
      taskWakeups.emit(event.type, event);
    } catch (err) {
      coreLogger.error({ err, type: event.type, taskId: event.taskId }, 'Task wakeup handler failed');
    }
  }

  // One notification per woken task, even if one close woke it both ways.
  const byTask = new Map<string, TaskWakeupEvent[]>();
  for (const event of events) byTask.set(event.taskId, [...(byTask.get(event.taskId) ?? []), event]);
  const notifications = getNotificationService();
  for (const [taskId, taskEvents] of byTask) {
    const { title } = taskEvents[0];
    const kinds = taskEvents.map((e) => e.type);
    const message = kinds.includes('task.unblocked') && kinds.includes('task.children_completed')
      ? `“${title}” is unblocked and all its sub-tasks are done`
      : kinds[0] === 'task.unblocked'
        ? `“${title}” is unblocked`
        : `All sub-tasks of “${title}” are done`;
    await notifications.notify(
      closed.userId,
      kinds.includes('task.unblocked') ? 'task_unblocked' : 'task_children_completed',
      message,
      `Triggered by closing “${closed.title}”.`,
      { taskId, triggeredBy: closed.id, workspaceId: base.workspaceId, wakeups: kinds },
    );
  }
  return events;
}
