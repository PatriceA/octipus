/**
 * Task structure helpers — pure functions over task rows, shared by the
 * tasks tool, the routes, the ranker and the tasks page (the web bundle
 * imports this file directly, so nothing here may touch the database).
 *
 * Two relations live on a task row: `parentId` (a sub-task of a phase, an
 * epic, a bigger task) and `blockedBy` (ids of tasks that must finish
 * first). The rules that make them useful rather than decorative:
 *
 *   - Only an ACTIVE blocker blocks. A blocker that is done, archived or
 *     gone is inert, so nobody has to rewrite `blockedBy` arrays when a
 *     task completes.
 *   - A parent with active children is "waiting" the same way a blocked
 *     task is: the work is in the children, and the ranker should not put
 *     a phase heading at the top of "what next".
 *   - Nesting is a view: rows stay flat in the database and the API, and
 *     `nestTasks` builds the tree from whatever set the caller has. A child
 *     whose parent is not in the set is a root of that set (filtered lists
 *     stay complete).
 */
import { isActiveStatus } from './status';

/** The subset of a task row the structure helpers read. */
export interface StructuredTask {
  id: string;
  title: string;
  status: string;
  parentId?: string | null;
  blockedBy?: readonly string[] | null;
}

export type Nested<T> = T & { children: Nested<T>[] };

/**
 * Arrange a flat set of rows into a tree, keeping the input order among
 * siblings. A row whose parent is not in the set becomes a root.
 */
export function nestTasks<T extends StructuredTask>(rows: readonly T[]): Nested<T>[] {
  const byId = new Map<string, Nested<T>>();
  for (const row of rows) byId.set(row.id, { ...row, children: [] });
  const roots: Nested<T>[] = [];
  for (const row of rows) {
    const node = byId.get(row.id)!;
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export interface WaitingOn {
  /** Active blockers, in `blockedBy` order, that are known to the lookup. */
  blockers: { id: string; title: string }[];
  /** Number of active children (sub-tasks still to do). */
  openChildren: number;
}

/**
 * What a task is waiting on, given a lookup of the tasks it may reference.
 * `lookup` is whatever set the caller has (the full active set for the
 * ranker, the current list for the page): an id missing from it does not
 * block, which is right for done/deleted blockers and conservative for a
 * blocker filtered out of view.
 */
export function waitingOn<T extends StructuredTask>(task: StructuredTask, lookup: ReadonlyMap<string, T>): WaitingOn {
  const blockers: { id: string; title: string }[] = [];
  for (const id of task.blockedBy ?? []) {
    if (id === task.id) continue;
    const blocker = lookup.get(id);
    if (blocker && isActiveStatus(blocker.status)) blockers.push({ id: blocker.id, title: blocker.title });
  }
  let openChildren = 0;
  for (const other of lookup.values()) {
    if (other.parentId === task.id && other.id !== task.id && isActiveStatus(other.status)) openChildren += 1;
  }
  return { blockers, openChildren };
}

/** True when `task` has an active blocker or an active child. */
export function isWaiting<T extends StructuredTask>(task: StructuredTask, lookup: ReadonlyMap<string, T>): boolean {
  const w = waitingOn(task, lookup);
  return w.blockers.length > 0 || w.openChildren > 0;
}

/** One-line reason for the ranker and the page: "blocked by X" or "3 sub-tasks open". */
export function waitingReason(w: WaitingOn): string | null {
  if (w.blockers.length > 0) {
    const first = w.blockers[0].title;
    const more = w.blockers.length - 1;
    return more > 0 ? `blocked by "${first}" and ${more} more` : `blocked by "${first}"`;
  }
  if (w.openChildren > 0) return `${w.openChildren} sub-task${w.openChildren === 1 ? '' : 's'} open`;
  return null;
}

export function toLookup<T extends StructuredTask>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Would making `parentId` the parent of `taskId` close a loop? Walks up
 * from the proposed parent through `lookup`; a walk that reaches `taskId`
 * (or runs past the depth cap, which only a loop can do) is a cycle.
 */
export function wouldCycle(taskId: string, parentId: string, lookup: ReadonlyMap<string, StructuredTask>, maxDepth = 50): boolean {
  let cursor: string | null | undefined = parentId;
  for (let depth = 0; cursor; depth += 1) {
    if (cursor === taskId) return true;
    if (depth >= maxDepth) return true;
    cursor = lookup.get(cursor)?.parentId;
  }
  return false;
}

/** Free-text estimate, trimmed and capped; empty → null. */
export function normalizeEstimate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const e = value.trim();
  return e === '' ? null : e.slice(0, 40);
}
