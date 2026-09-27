/**
 * The to-do status set, written once. Shared by the tasks tool, the routes,
 * the ranker and the tasks page (the web bundle imports this file directly),
 * so a status added here is a status everywhere.
 *
 *   open         — not started
 *   in_progress  — being worked on (the board's middle lane)
 *   done         — finished; `completedAt` is set
 *   archived     — out of the way without being done
 *
 * "Active" is what the next-action view ranks and what the board shows in
 * its first two columns: open and in-progress alike are still to be done.
 */
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'archived'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress'];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/** True for a status that still has work in it (open or in progress). */
export function isActiveStatus(status: string): boolean {
  return (ACTIVE_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * Who a task is assigned to on the work board: a user, a role (any agent of
 * that role may pick it up) or a specific swarm node. `assigneeRef` names it.
 */
export const TASK_ASSIGNEE_KINDS = ['user', 'role', 'node'] as const;
export type TaskAssigneeKind = (typeof TASK_ASSIGNEE_KINDS)[number];

export function isTaskAssigneeKind(value: unknown): value is TaskAssigneeKind {
  return typeof value === 'string' && (TASK_ASSIGNEE_KINDS as readonly string[]).includes(value);
}

/**
 * The assignee columns for a write. Absent both → no change; a null or empty
 * kind clears the assignee; otherwise kind and ref come together. Throws with
 * a message fit for the API's 400 / the tool's `error` field.
 */
export function assigneePatch(kind: unknown, ref: unknown): { assigneeKind?: TaskAssigneeKind | null; assigneeRef?: string | null } {
  if (kind === undefined && ref === undefined) return {};
  if (kind === null || kind === '') return { assigneeKind: null, assigneeRef: null };
  if (kind === undefined) throw new Error('assigneeKind is required with assigneeRef');
  if (!isTaskAssigneeKind(kind)) throw new Error(`Invalid assigneeKind "${String(kind)}" — expected ${TASK_ASSIGNEE_KINDS.join(' | ')}`);
  const r = typeof ref === 'string' ? ref.trim().slice(0, 200) : '';
  if (r === '') throw new Error('assigneeRef is required with assigneeKind');
  return { assigneeKind: kind, assigneeRef: r };
}

export const TASK_STATUS_TITLE: Record<TaskStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  archived: 'Archived',
};
