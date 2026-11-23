import { auditTaskMutation, changedTaskFields } from '@/core/tasks/audit';
import { parseQuickAdd, quickAddDueAt } from '@/core/tasks/quick-add';
import { repeatLabel } from '@/core/tasks/repeat';
import { parseTaskDate, resolveUserTimezone } from '@/core/tasks/timezone';
import { contentRepos } from '@/db/repositories/content';
import { agentPrincipal } from '@/security/principal';
import { registerCommand } from './registry';

/**
 * `/todo <text>` adds a to-do to the user's personal list, read by the same
 * capture parser as the web's capture line and `POST /api/tasks` with
 * `quick` (core/tasks/quick-add.ts): "/todo call dentist tomorrow 3pm !high
 * #personal". Goes through the gateway like every other command, so it
 * works from every channel, and through the personal task door, so the
 * to-do list hears of it at once.
 */
registerCommand({
  name: 'todo',
  description: 'Add a to-do (/todo call dentist tomorrow 3pm !high #personal)',
  async execute(ctx) {
    const text = ctx.args.trim();
    if (!text) {
      return { response: 'Usage: `/todo <text>` — adds a to-do. Dates ("tomorrow 3pm", "fri"), `!high`, `#list` and "every week" are understood.' };
    }
    // The user's own personal list, whichever room or space the command came from.
    const principal = agentPrincipal({ userId: ctx.userId, workspaceId: null });
    const repo = contentRepos(principal).tasks;
    const timezone = await resolveUserTimezone(ctx.userId);
    const parsed = parseQuickAdd(text, { timezone, lists: await repo.categories() });
    const dueAt = quickAddDueAt(parsed.due, timezone);
    const values = {
      title: parsed.title,
      priority: parsed.priority ?? 0,
      important: parsed.important,
      category: parsed.category,
      repeat: parsed.repeat,
      dueAt: dueAt ? await parseTaskDate(dueAt, 'dueAt', ctx.userId, timezone) : null,
      source: 'user',
      sourceRef: { sessionId: ctx.sessionId },
    };
    const task = await repo.create(values);
    await auditTaskMutation({ userId: ctx.userId, taskId: task.id, op: 'create', change: changedTaskFields(values), actor: { kind: 'user', id: ctx.userId }, runId: null });
    return { response: `Added to-do **${task.title}**${todoDetails(parsed, task.dueAt, timezone)}.` };
  },
});

/** " — due Tue, Nov 24 15:00 · High · #personal · Weekly", or nothing. */
export function todoDetails(parsed: ReturnType<typeof parseQuickAdd>, dueAt: Date | null, timezone: string): string {
  const parts: string[] = [];
  if (dueAt) {
    const when = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
      ...(parsed.due?.time ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}),
    }).format(dueAt);
    parts.push(`due ${when}`);
  }
  if (parsed.priority) parts.push(['', 'low priority', 'medium priority', 'high priority'][parsed.priority]);
  if (parsed.important) parts.push('important');
  if (parsed.category) parts.push(`#${parsed.category}`);
  if (parsed.repeat) parts.push(repeatLabel(parsed.repeat).toLowerCase());
  return parts.length > 0 ? ` — ${parts.join(' · ')}` : '';
}
