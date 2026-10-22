/**
 * Follow-ups ("Wiedervorlagen", docs/CASES.md): a task whose `remindAt` has
 * passed comes back to its assignee's attention, once.
 *
 * The cron loop calls `fireDueReminders` every tick. One guarded UPDATE
 * claims the due rows (`reminded_at IS NULL`, `FOR UPDATE SKIP LOCKED`), so
 * two server processes never notify for the same task twice; a claimed row
 * whose notification then fails is logged and not retried (the task itself
 * still shows as due). Rows of closed tasks are claimed as well, so they
 * leave the due set for good, and tell nobody. Changing `remindAt` clears
 * `remindedAt` (`TaskRepo.update`), which re-arms the reminder.
 *
 * Who hears of it: the assigned user when there is one, else the author. In
 * a space the recipient must still be a member who is not a guest — a member
 * who left gets nothing, and the author is told instead while they are still
 * a member. Only active tasks (open, in progress) remind.
 */
import { getNotificationService } from '@/core/notification-service';
import { queryRaw } from '@/db/postgres';
import { coreLogger } from '@/utils/logger';
import { isActiveStatus } from './status';

/** Upper bound of reminders one tick sends; the rest wait for the next tick. */
const REMINDERS_PER_TICK = 100;

interface DueReminder {
  id: string;
  title: string;
  status: string;
  user_id: string;
  workspace_id: string | null;
  workspace_kind: string | null;
  assignee_kind: string | null;
  assignee_ref: string | null;
  remind_at: Date;
  due_at: Date | null;
}

/**
 * Claim every task whose follow-up date has passed (up to a bound) and
 * notify its recipient. Returns how many reminders were sent.
 */
export async function fireDueReminders(now: Date = new Date(), limit = REMINDERS_PER_TICK): Promise<number> {
  // i2: due follow-ups of every task, notified to their assignee or author
  // only; the space recipient is re-checked against the membership below.
  const { rows } = await queryRaw(
    `UPDATE tasks t SET reminded_at = now()
       FROM (
         SELECT id FROM tasks
          WHERE remind_at IS NOT NULL AND remind_at <= $1 AND reminded_at IS NULL
          ORDER BY remind_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       ) due
      WHERE t.id = due.id
     RETURNING t.id, t.title, t.status, t.user_id, t.workspace_id,
       (SELECT w.kind FROM workspaces w WHERE w.id = t.workspace_id) AS workspace_kind,
       t.assignee_kind, t.assignee_ref, t.remind_at, t.due_at`,
    [now.toISOString(), limit],
  );
  // A closed task's follow-up is stamped too, so it leaves the due set, but
  // tells nobody.
  const due = (rows as DueReminder[]).filter((r) => isActiveStatus(r.status));
  if (due.length === 0) return 0;
  const caseIds = await linkedCases(due.map((r) => r.id));
  let sent = 0;
  for (const task of due) {
    try {
      const recipient = await recipientOf(task);
      if (!recipient) {
        coreLogger.info({ taskId: task.id }, 'Follow-up due, but nobody in the space to tell');
        continue;
      }
      const shared = task.workspace_kind === 'shared';
      await getNotificationService().notify(
        recipient,
        'task_reminder',
        `Follow-up: ${task.title}`,
        task.due_at ? `Due ${new Date(task.due_at).toISOString()}` : undefined,
        { taskId: task.id, remindAt: new Date(task.remind_at).toISOString(), caseIds: caseIds.get(task.id) ?? [] },
        { workspaceId: shared ? task.workspace_id : null },
      );
      sent += 1;
    } catch (err) {
      coreLogger.error({ err, taskId: task.id }, 'Follow-up reminder failed');
    }
  }
  return sent;
}

/** The user a due task reminds: its assigned user, else its author; in a space, only while a member. */
async function recipientOf(task: DueReminder): Promise<string | null> {
  const assignee = task.assignee_kind === 'user' && task.assignee_ref ? task.assignee_ref : null;
  if (task.workspace_kind !== 'shared' || !task.workspace_id) return assignee ?? task.user_id;
  const { getMembership } = await import('@/core/spaces/service');
  for (const candidate of [assignee, task.user_id]) {
    if (!candidate) continue;
    const member = await getMembership(candidate, task.workspace_id);
    if (member && member.role !== 'guest') return candidate;
  }
  return null;
}

/** Case ids each task is linked to (core/cases/links.ts), for the notification's link back. */
async function linkedCases(taskIds: string[]): Promise<Map<string, string[]>> {
  const { rows } = await queryRaw(
    `SELECT entity_id::text AS task_id, case_id::text AS case_id FROM case_links
      WHERE entity_type = 'task' AND entity_id = ANY($1::uuid[])`,
    [taskIds],
  );
  const out = new Map<string, string[]>();
  for (const r of rows as Array<{ task_id: string; case_id: string }>) {
    out.set(r.task_id, [...(out.get(r.task_id) ?? []), r.case_id]);
  }
  return out;
}
