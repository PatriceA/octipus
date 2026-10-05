/**
 * The team surface of a space's tasks (docs/plans/coworking-spec.md §9.3).
 *
 * - `taskChanged` publishes `task.changed { taskId, workspaceId }` to the
 *   space's gateway subscribers (`space:<id>`, joined through
 *   `space.subscribe` after a membership check): the board refetches on it
 *   instead of polling. The event carries ids only; the board reads the task
 *   through the space door.
 * - `notifyAssigned` tells a member a task of the space was assigned to
 *   them (`task_assigned`, filed under the space), after re-reading their
 *   membership — a guest or a removed member is not told.
 * - `myWork` is `GET /api/me/work`: the caller's open tasks across their
 *   spaces and their personal workspaces, grouped by space.
 *
 * Personal tasks have none of this: a personal task can be assigned only to
 * its owner, and nobody else watches the personal board.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { workspaceMembers, workspaces } from '@/db/schema/organizations';
import { type Task, tasks } from '@/db/schema/tasks';
import { coreLogger } from '@/utils/logger';
import { ACTIVE_TASK_STATUSES } from './status';

/**
 * Tell the space's subscribers a task changed (created, edited, claimed,
 * commented, deleted). Only to current members, read now — a removed
 * member's still-open connection hears nothing — and of guests only those
 * whose scope reaches the task (S6, `taskInGuestScope`: raised from one of
 * their rooms). A deletion passes the deleted row's `sourceRef`, since the
 * row itself is gone by now.
 */
export async function taskChanged(
  workspaceId: string,
  taskId: string,
  deleted?: { sourceRef: Task['sourceRef'] },
): Promise<void> {
  const [{ eventMessage, spaceResource }, { getGatewayHub }, { storedGuestScope, taskInGuestScope }] = await Promise.all([
    import('@/core/rooms/events'), import('@/core/gateway/hub'), import('@/security/space-access'),
  ]);
  const rows = await getDb()
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role, scope: workspaceMembers.scope })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  const guests = rows.filter((r) => r.role === 'guest');
  const [task] = guests.length === 0 ? [] : deleted ? [deleted] : await getDb()
    .select({ sourceRef: tasks.sourceRef })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
    .limit(1);
  const told = new Set(rows
    .filter((r) => {
      if (r.role !== 'guest') return true;
      const scope = storedGuestScope(r.role, r.scope, { workspaceId, userId: r.userId });
      return !!task && !!scope && taskInGuestScope(task.sourceRef, scope);
    })
    .map((r) => r.userId));
  const resource = spaceResource(workspaceId);
  getGatewayHub().connectionManager.broadcast(
    eventMessage('task.changed', { taskId, workspaceId }),
    (ctx) => ctx.resources.has(resource) && told.has(ctx.userId),
  );
}

/** `taskChanged`, detached from the committed write; a failure is logged. */
export function publishTaskChanged(workspaceId: string, taskId: string, deleted?: { sourceRef: Task['sourceRef'] }): void {
  taskChanged(workspaceId, taskId, deleted).catch((err: unknown) => coreLogger.error({ err, workspaceId, taskId }, 'task.changed not published'));
}

/**
 * Notify `assigneeId` that `task` of the space `workspaceId` is theirs now,
 * unless they assigned it themselves or are no longer a member who may see
 * it (not a guest).
 */
export async function notifyAssigned(workspaceId: string, task: Pick<Task, 'id' | 'title'>, assigneeId: string, actorId: string): Promise<void> {
  if (assigneeId === actorId) return;
  const { getMembership, getSpace } = await import('@/core/spaces/service');
  const membership = await getMembership(assigneeId, workspaceId);
  if (!membership || membership.role === 'guest') return;
  const [{ getNotificationService }, { displayNames }] = await Promise.all([
    import('@/core/notification-service'), import('@/core/session-history'),
  ]);
  const actorName = (await displayNames([actorId])).get(actorId) ?? 'A member';
  const { name } = await getSpace({ userId: assigneeId }, workspaceId);
  await getNotificationService().notify(
    assigneeId,
    'task_assigned',
    `${actorName} assigned you a task in ${name}`,
    task.title,
    { taskId: task.id, assignedBy: actorId },
    { workspaceId },
  );
}

/**
 * After a write to a space task: the event, and the notice when it was
 * assigned to someone new. Detached from the write (a failure is logged,
 * never undoes the committed change).
 */
export function afterSpaceTaskWrite(
  workspaceId: string,
  task: Pick<Task, 'id' | 'title' | 'assigneeKind' | 'assigneeRef'>,
  actorId: string,
  previous: Pick<Task, 'assigneeKind' | 'assigneeRef'> | null,
): void {
  const assignee = task.assigneeKind === 'user' ? task.assigneeRef : null;
  const before = previous?.assigneeKind === 'user' ? previous.assigneeRef : null;
  void (async () => {
    await taskChanged(workspaceId, task.id);
    if (assignee && assignee !== before) await notifyAssigned(workspaceId, task, assignee, actorId);
  })().catch((err: unknown) => coreLogger.error({ err, workspaceId, taskId: task.id }, 'Space task follow-up failed'));
}

/** One group of "My work": a space, or the personal workspaces (`workspaceId` null for user-level tasks). */
export interface MyWorkGroup {
  workspaceId: string | null;
  name: string;
  kind: 'personal' | 'shared';
  tasks: Task[];
}

/**
 * The caller's open tasks: in every space they belong to (not as a guest)
 * and that is not archived (its tasks can no longer move), the tasks
 * assigned to them; in their personal workspaces, their own tasks
 * assigned to themselves. Grouped by workspace, spaces by name; tasks by
 * priority, then due date.
 */
export async function myWork(userId: string): Promise<MyWorkGroup[]> {
  const db = getDb();
  const spaces = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.kind, 'shared'), isNull(workspaces.archivedAt), sql`${workspaceMembers.role} <> 'guest'`));
  const personal = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(and(eq(workspaces.userId, userId), eq(workspaces.kind, 'personal')));
  const spaceIds = spaces.map((s) => s.id);
  const personalIds = personal.map((p) => p.id);
  const assignedToMe = and(eq(tasks.assigneeKind, 'user'), eq(tasks.assigneeRef, userId), inArray(tasks.status, [...ACTIVE_TASK_STATUSES]));
  const rows = await db
    .select()
    .from(tasks)
    .where(and(
      assignedToMe,
      or(
        spaceIds.length > 0 ? inArray(tasks.workspaceId, spaceIds) : sql`false`,
        and(eq(tasks.userId, userId), or(isNull(tasks.workspaceId), personalIds.length > 0 ? inArray(tasks.workspaceId, personalIds) : sql`false`)),
      ),
    ))
    .orderBy(sql`${tasks.priority} DESC`, sql`${tasks.dueAt} ASC NULLS LAST`, tasks.createdAt)
    .limit(500);

  const groups = new Map<string, MyWorkGroup>();
  const names = new Map([...spaces.map((s) => [s.id, s.name] as const), ...personal.map((p) => [p.id, p.name] as const)]);
  const shared = new Set(spaceIds);
  for (const row of rows) {
    const key = row.workspaceId ?? '';
    let group = groups.get(key);
    if (!group) {
      group = {
        workspaceId: row.workspaceId,
        name: row.workspaceId ? (names.get(row.workspaceId) ?? 'Workspace') : 'Personal',
        kind: row.workspaceId && shared.has(row.workspaceId) ? 'shared' : 'personal',
        tasks: [],
      };
      groups.set(key, group);
    }
    group.tasks.push(row);
  }
  return [...groups.values()].sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'personal' ? -1 : 1) || a.name.localeCompare(b.name));
}
