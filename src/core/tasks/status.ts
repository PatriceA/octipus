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

export const TASK_STATUS_TITLE: Record<TaskStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  archived: 'Archived',
};
