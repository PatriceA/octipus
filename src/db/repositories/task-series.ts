/**
 * Repeating to-dos: the next occurrence of a series (core/tasks/repeat.ts).
 *
 * A series moves on when an occurrence leaves the active set — completed, or
 * skipped (archived or deleted: deleting a repeating to-do deletes that
 * occurrence; to end a series, stop its repeat). The next occurrence is a
 * new open task: same title, notes, list, priority, assignee, source and
 * rule, its steps copied open (deleted steps are not), each user's star and
 * order copied (not My Day), its notes attached (not the note line it was
 * made from: that line stays with its own occurrence, ticked), due one step
 * on in the series' zone.
 *
 * Exactly once: the next id is claimed on the finished row
 * (`repeat_next_id IS NULL`, still finished) in the same transaction as the
 * insert, so racing completions, a retry or done → done never make a second
 * one, and an occurrence reopened meanwhile makes none. If the spawn fails
 * after the completion committed, the row is left unclaimed and
 * `healRepeatSeries` (the cron sweep) makes it later: a series never ends by
 * accident.
 *
 * Taking one back: reopening a finished occurrence (an Undo) deletes its next
 * occurrence only while that is provably pristine — still open, unclaimed,
 * never edited, no comments, no step but the copied ones and none of them
 * touched, nobody's star or order changed on it, and created within
 * `RETRACT_WINDOW_MS`. Anything else is the user's work and stays (and so
 * does the link, so completing again makes no second one).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { nextOccurrence, normalizeRepeat, type TaskRepeat } from '@/core/tasks/repeat';
import { dbLogger } from '@/utils/logger';
import { getDb } from '../postgres';
import { taskComments } from '../schema/task-comments';
import { type Task, tasks, taskUserState } from '../schema/tasks';
import { copyLinksSql } from './task-note-links';

/** How long after it was made an untouched next occurrence may still be taken back by a reopen. */
export const RETRACT_WINDOW_MS = 10 * 60_000;
const FINISHED = ['done', 'archived'];

export interface SpawnResult {
  /** The finished row with `repeatNextId` set (null when the spawn did not claim one: a deleted row). */
  claimed: Task | null;
  next: Task;
}

/**
 * Make the next occurrence of `finished`. With `claim` (a row that still
 * exists) only if it is still finished and has none yet; without (a row just
 * deleted) unconditionally. Null when there is nothing to make or another
 * caller made it. `fallbackTz` is used only for a rule without its own zone.
 */
export async function spawnNextOccurrence(finished: Task, opts: { claim: boolean; fallbackTz: string; now?: Date }): Promise<SpawnResult | null> {
  let rule: TaskRepeat | null;
  try {
    rule = normalizeRepeat(finished.repeat);
  } catch (err) {
    // Only raw SQL could store a bad rule; the occurrence stays finished, without a next one.
    dbLogger.error({ err, taskId: finished.id }, 'Repeating to-do has an invalid rule; no next occurrence');
    return null;
  }
  if (!rule) return null;
  const now = opts.now ?? new Date();
  const dueAt = nextOccurrence(rule, finished.dueAt, now, opts.fallbackTz);
  const remindAt = !finished.remindAt
    ? null
    : finished.dueAt
      ? new Date(finished.remindAt.getTime() + (dueAt.getTime() - finished.dueAt.getTime()))
      : nextOccurrence(rule, finished.remindAt, now, opts.fallbackTz);
  const nextId = randomUUID();
  return getDb().transaction(async (tx) => {
    let claimed: Task | null = null;
    if (opts.claim) {
      [claimed] = await tx
        .update(tasks)
        .set({ repeatNextId: nextId })
        .where(and(eq(tasks.id, finished.id), isNull(tasks.repeatNextId), inArray(tasks.status, FINISHED)))
        .returning();
      if (!claimed) return null;
    }
    const [next] = await tx.insert(tasks).values({
      id: nextId,
      userId: finished.userId,
      workspaceId: finished.workspaceId,
      title: finished.title,
      notes: finished.notes,
      priority: finished.priority,
      category: finished.category,
      repeat: rule,
      sortOrder: finished.sortOrder,
      dueAt,
      remindAt,
      estimate: finished.estimate,
      parentId: finished.parentId,
      assigneeKind: finished.assigneeKind,
      assigneeRef: finished.assigneeRef,
      source: finished.source,
      sourceRef: finished.sourceRef,
    }).returning();
    // Deleted steps stay deleted; done ones come back open.
    const steps = await tx.select().from(tasks).where(and(eq(tasks.parentId, finished.id), ne(tasks.status, 'archived')));
    if (steps.length > 0) {
      await tx.insert(tasks).values(steps.map((step) => ({
        userId: step.userId,
        workspaceId: step.workspaceId,
        title: step.title,
        category: step.category,
        parentId: nextId,
        sortOrder: step.sortOrder,
        source: step.source,
      })));
    }
    const states = await tx.select().from(taskUserState).where(eq(taskUserState.taskId, finished.id));
    if (states.length > 0) {
      await tx.insert(taskUserState).values(states.map((s) => ({ taskId: nextId, userId: s.userId, important: s.important, sortOrder: s.sortOrder })));
    }
    await tx.execute(copyLinksSql(finished.id, nextId));
    return { claimed, next };
  });
}

/**
 * Take back `nextId`, the occurrence `predecessor` made, if it is provably
 * pristine (see the file comment). Returns the deleted row, or null when it
 * stays. Clears the predecessor's link only when it went.
 */
export async function retractNextOccurrence(predecessor: Task, nextId: string, now: Date = new Date()): Promise<Task | null> {
  return getDb().transaction(async (tx) => {
    const [next] = await tx.select().from(tasks).where(and(
      eq(tasks.id, nextId),
      eq(tasks.status, 'open'),
      isNull(tasks.checkedOutBy),
      sql`${tasks.updatedAt} = ${tasks.createdAt}`,
    )).for('update');
    if (!next || now.getTime() - next.createdAt.getTime() > RETRACT_WINDOW_MS) return null;
    const [comment] = await tx.select({ id: taskComments.id }).from(taskComments).where(eq(taskComments.taskId, nextId)).limit(1);
    if (comment) return null;
    const steps = await tx.select().from(tasks).where(eq(tasks.parentId, nextId));
    // Copied steps were inserted with the occurrence (same transaction time) and never touched.
    const madeWith = (row: { createdAt: Date; updatedAt: Date }) => row.createdAt.getTime() === next.createdAt.getTime() && row.updatedAt.getTime() === row.createdAt.getTime();
    if (steps.some((step) => !madeWith(step) || step.status !== 'open')) return null;
    const ids = [nextId, ...steps.map((s) => s.id)];
    const states = await tx.select().from(taskUserState).where(inArray(taskUserState.taskId, ids));
    if (states.some((s) => !madeWith(s))) return null;
    if (steps.length > 0) {
      const [stepComment] = await tx.select({ id: taskComments.id }).from(taskComments).where(inArray(taskComments.taskId, steps.map((s) => s.id))).limit(1);
      if (stepComment) return null;
      await tx.delete(tasks).where(eq(tasks.parentId, nextId));
    }
    await tx.delete(tasks).where(eq(tasks.id, nextId));
    await tx.update(tasks).set({ repeatNextId: null }).where(and(eq(tasks.id, predecessor.id), eq(tasks.repeatNextId, nextId)));
    return next;
  });
}

/**
 * The self-healing sweep (cron): finished repeating to-dos of the last week
 * that have no next occurrence — a spawn that failed after its completion
 * committed — get one now. Returns how many were made.
 */
export async function healRepeatSeries(
  resolveTz: (userId: string) => Promise<string>,
  onSpawned: (result: SpawnResult) => void = () => {},
  limit = 50,
): Promise<number> {
  const orphans = await getDb().select().from(tasks).where(and(
    isNotNull(tasks.repeat),
    isNull(tasks.repeatNextId),
    inArray(tasks.status, FINISHED),
    sql`${tasks.updatedAt} > now() - interval '7 days'`,
  )).limit(limit);
  let made = 0;
  for (const finished of orphans) {
    try {
      const result = await spawnNextOccurrence(finished, { claim: true, fallbackTz: await resolveTz(finished.userId) });
      if (result) {
        made += 1;
        onSpawned(result);
      }
    } catch (err) {
      dbLogger.error({ err, taskId: finished.id }, 'Repeating to-do: next occurrence still could not be made');
    }
  }
  return made;
}
