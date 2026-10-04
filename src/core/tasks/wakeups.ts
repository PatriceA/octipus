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
 * active blocker here — a wakeup must never be a false positive. And when
 * several closes free one task (its last two blockers, a parent's last two
 * children), only the latest by (updatedAt, id) fires: see `computeWakeups`.
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
 * Across processes: `dispatchWakeups` emits on this process's bus, files
 * the notifications, then hands the events, detached, to the publisher if
 * one is set (`setWakeupPublisher`). On external Postgres the wakeup bridge
 * (./wakeup-bridge.ts, started with the server) is that publisher: it
 * `pg_notify`s the ids on `octipus_task_wakeups`, and every other server
 * process LISTENing there re-emits them on its own bus with `remote: true`
 * (a process skips its own notifications). Side effects stay once
 * cluster-wide: the notification is filed here, in the originating process
 * only, and a listener that writes the DB acts on local events only (see
 * `onRoleTaskWakeup` in core/heartbeat.ts). On embedded PGlite (one process)
 * no publisher is set and nothing changes. A notification sent while a
 * listener's socket is down is lost for it; wakeups are a shortcut, never
 * the only way work gets picked up.
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
  /**
   * The woken task's owner (in a space, its author — docs/plans/coworking-spec.md
   * §5.5), not the closer's: in a space another member's close wakes it.
   */
  userId: string;
  workspaceId: string | null;
  /** The task that was woken (unblocked, or the parent whose children are all closed). */
  taskId: string;
  /** Title of the woken task, for messages. */
  title: string;
  /** The task whose close (or delete) caused the wakeup. */
  triggeredBy: string;
  cause: WakeupCause;
  /**
   * True when another server process dispatched the wakeup and it reached
   * this one over LISTEN/NOTIFY. Its side effects (the notification, the DB
   * writes of local listeners) already ran there: act on it only in memory.
   */
  remote?: boolean;
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

/** A task row as the wakeup rule reads it: structure plus the close order. */
export interface WakeupTask extends StructuredTask {
  updatedAt?: Date | string | null;
}

export interface ComputedWakeups<T extends WakeupTask> {
  /** Active tasks the close left with no active blocker. */
  unblocked: T[];
  /** The closed task's parent, when it is active and has no active child left. */
  childrenCompleted: T | null;
}

/**
 * The total order on closes every reader agrees on: (updatedAt, id). Stored
 * values, so clock skew between writers cannot make two readers disagree.
 */
export function closedAfter(a: WakeupTask, b: WakeupTask): boolean {
  const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
  const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
  return ta !== tb ? ta > tb : a.id > b.id;
}

/** True when `subject` is the latest of `candidates` that are closed. */
function isLatestClosed(subject: WakeupTask, candidates: Iterable<WakeupTask | undefined>): boolean {
  for (const other of candidates) {
    if (!other || other.id === subject.id || isActiveStatus(other.status)) continue;
    if (!closedAfter(subject, other)) return false;
  }
  return true;
}

/**
 * Pure: which tasks `closed` leaving the active set woke, given the rows
 * around it. `previousStatus` is the status before the write; anything but
 * an active → closed transition wakes nobody, so re-closing a done task
 * never fires twice. `rows` should hold the dependents, their blockers, the
 * parent, its active children and its latest-closed child; `closed` (with
 * its new status) overrides any stale copy. `unknownIds` are blocker ids
 * that exist but are unreadable: they count as active. For a delete, pass
 * `closed` with a non-active status and the delete time as `updatedAt`.
 *
 * Sibling rule: two blockers of one task (or the last two children of one
 * parent) can close back to back, and each detached wakeup may read after
 * both writes, seeing the other already closed. So a close wakes a task only
 * if it is the latest, by `closedAfter`, of that task's closed blockers (of
 * the parent's closed children). Every reader that sees both closes agrees
 * on which one that is, so exactly one of them fires.
 */
export function computeWakeups<T extends WakeupTask>(
  closed: T,
  previousStatus: string,
  rows: readonly T[],
  unknownIds: readonly string[] = [],
): ComputedWakeups<T> {
  const none: ComputedWakeups<T> = { unblocked: [], childrenCompleted: null };
  if (!isActiveStatus(previousStatus) || isActiveStatus(closed.status)) return none;
  const lookup = toLookup<WakeupTask>(rows);
  for (const id of unknownIds) if (!lookup.has(id)) lookup.set(id, { id, title: '(unknown)', status: 'open' });
  lookup.set(closed.id, closed);

  const unblocked: T[] = [];
  for (const row of rows) {
    if (row.id === closed.id || !isActiveStatus(row.status) || unblocked.includes(row)) continue;
    const blockedBy = row.blockedBy ?? [];
    if (!blockedBy.includes(closed.id)) continue;
    if (waitingOn(row, lookup).blockers.length > 0) continue;
    if (isLatestClosed(closed, blockedBy.map((id) => lookup.get(id)))) unblocked.push(row);
  }

  let childrenCompleted: T | null = null;
  const parent = closed.parentId ? rows.find((r) => r.id === closed.parentId) : undefined;
  if (parent && parent.id !== closed.id && isActiveStatus(parent.status) && waitingOn(parent, lookup).openChildren === 0) {
    const siblings = [...lookup.values()].filter((r) => r.parentId === parent.id);
    if (isLatestClosed(closed, siblings)) childrenCompleted = parent;
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

// ── Close listeners ────────────────────────────────────────────────────

/** A task that just left the active set: closed (done, archived) or deleted. */
export interface TaskClosedEvent {
  task: Task;
  previousStatus: string;
  cause: WakeupCause;
}

const closeListeners = new Set<(event: TaskClosedEvent) => unknown>();

/**
 * Called once for every task that leaves the active set, detached from the
 * write, in the process that wrote it (no cross-process copy): a listener may
 * act on the outside world, e.g. post a line in the chat the task came from.
 * Returns an unsubscribe function.
 */
export function onTaskClosed(handler: (event: TaskClosedEvent) => unknown): () => void {
  closeListeners.add(handler);
  return () => {
    closeListeners.delete(handler);
  };
}

/** Run the close listeners; one failing never reaches the others or the write. */
export async function notifyTaskClosed(event: TaskClosedEvent): Promise<void> {
  for (const listener of closeListeners) {
    try {
      await listener(event);
    } catch (err) {
      coreLogger.error({ err, taskId: event.task.id }, 'Task close listener failed');
    }
  }
}

// ── Cross-process publishing ───────────────────────────────────────────

/** Sends locally dispatched events to other server processes. */
export type WakeupPublisher = (events: readonly TaskWakeupEvent[]) => Promise<void>;

let publisher: WakeupPublisher | null = null;

/** Set (or clear, with null) the cross-process publisher. The wakeup bridge owns it. */
export function setWakeupPublisher(next: WakeupPublisher | null): void {
  publisher = next;
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

  const base = { workspaceId: closed.workspaceId ?? null, triggeredBy: closed.id, cause };
  const events: TaskWakeupEvent[] = unblocked.map((t) => ({ ...base, userId: t.userId, type: 'task.unblocked', taskId: t.id, title: t.title }));
  if (childrenCompleted) {
    events.push({ ...base, userId: childrenCompleted.userId, type: 'task.children_completed', taskId: childrenCompleted.id, title: childrenCompleted.title });
  }
  for (const event of events) emitSafely(event);
  try {
    await notifyWoken(closed, cause, events, [...unblocked, ...(childrenCompleted ? [childrenCompleted] : [])]);
  } finally {
    // Then to the other server processes (Postgres only; see the header),
    // detached so the local path's latency is unchanged. A failed NOTIFY is
    // logged and costs only the remote shortcut. `flushWakeups` waits for it.
    if (events.length > 0 && publisher) {
      const publish = publisher;
      scheduleWakeup(() => publish(events).catch((err: unknown) => {
        coreLogger.warn({ err, triggeredBy: closed.id }, 'Task wakeup publish to other processes failed');
      }));
    }
  }
  return events;
}

/**
 * The people a woken task's notification goes to, decided at send time.
 *
 * - A personal task: its owner, and nobody else. A 'user' assignee there can
 *   only be the owner (`TaskRepo` refuses anyone else), and a stored ref is
 *   never trusted as a recipient: it would let a user send notifications of
 *   their choosing to anyone.
 * - A space task: its author and, when assigned to another user, that
 *   assignee — each only while they are still a member (not a guest), read
 *   from the database now (I1, I5): a removed author or assignee hears
 *   nothing more of the space.
 *
 * Role assignees are personal automation and get nothing here.
 */
async function recipientsOf(
  task: Pick<Task, 'userId' | 'workspaceId' | 'assigneeKind' | 'assigneeRef'> | undefined,
  fallback: { userId: string; workspaceId: string | null },
): Promise<string[]> {
  const owner = task?.userId ?? fallback.userId;
  const workspaceId = task ? task.workspaceId ?? null : fallback.workspaceId;
  const { getMembership, isSharedWorkspace } = await import('@/core/spaces/service');
  if (!workspaceId || !(await isSharedWorkspace(workspaceId))) return [owner];
  const candidates = [owner];
  if (task?.assigneeKind === 'user' && task.assigneeRef && task.assigneeRef !== owner) candidates.push(task.assigneeRef);
  const out: string[] = [];
  for (const userId of candidates) {
    const member = await getMembership(userId, workspaceId);
    if (member && member.role !== 'guest') out.push(userId);
  }
  return out;
}

/**
 * One notification per woken task and recipient (a task woken both ways gets
 * one, combined), sent to the woken task's people — not the closer: in a
 * space the member who closed the blocker is often someone else.
 */
async function notifyWoken(closed: Task, cause: WakeupCause, events: TaskWakeupEvent[], woken: Task[] = []): Promise<void> {
  const workspaceId = closed.workspaceId ?? null;
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
    const task = woken.find((t) => t.id === taskId);
    for (const recipient of await recipientsOf(task, { userId: taskEvents[0].userId, workspaceId })) {
      await notifications.notify(
        recipient,
        unblockedToo ? 'task_unblocked' : 'task_children_completed',
        message,
        `Triggered by ${cause === 'deleted' ? 'deleting' : 'closing'} “${closed.title}”.`,
        { taskId, triggeredBy: closed.id, workspaceId, wakeups: kinds, cause },
      );
    }
  }
}
