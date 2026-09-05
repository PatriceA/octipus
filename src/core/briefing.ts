/**
 * Daily briefing — the one proactive turn every user gets by default.
 *
 * The heartbeat (`heartbeat.ts`) is deliberately silent unless something is
 * pending, and the hook *suggestions* catalogue only offers a briefing to
 * users who already connected Google or Microsoft and then went looking for
 * it. Neither tells a new user what to do today. This module seeds one
 * enabled `schedule` hook per user at registration — a weekday-morning
 * briefing whose prompt is integration-agnostic: it uses the to-do list and
 * notifications that always exist, and calendar / mail / GitHub only when
 * those tools are connected.
 *
 * The hook is an ordinary row on the Hooks page: editable, pausable,
 * deletable. `ensureDailyBriefingHook` is idempotent (keyed by user + name)
 * so re-running it never produces a second briefing.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { hooks } from '@/db/schema/hooks';
import { getNextCronDate } from '@/core/cron-runner';

export const DAILY_BRIEFING_HOOK_NAME = 'Daily Briefing';
/** Weekdays at 08:00 in the hook's timezone. */
export const DAILY_BRIEFING_CRON = '0 8 * * 1-5';

/**
 * The briefing prompt. Written so a user with nothing connected still gets a
 * useful turn (to-dos + notifications + "what next"), and so no section is
 * fabricated for an integration that is not there.
 */
export function dailyBriefingPrompt(): string {
  return [
    'Prepare my daily briefing for today. Use only what tools actually return; skip any section whose integration is not connected, and say so in one line instead of inventing content.',
    '',
    '1. To-dos: list_tasks — overdue first, then due today, then the top open items by priority. Name the ones that came from email or research so I know where they came from.',
    '2. Calendar: if a calendar tool is available, today\'s events with times; flag conflicts and anything without an agenda.',
    '3. Inbox: if a mail tool is available, unread mail since yesterday — the ones that need a reply or a decision, grouped by sender. Do not summarize newsletters.',
    '4. Code: if GitHub is available, my open pull requests (review state, failing checks) and issues assigned to me.',
    '5. Notifications: anything unread that needs me.',
    '',
    'Finish with "Next three": the three actions I should take first today, one line each, with the reason. Keep the whole briefing scannable — bullets, not paragraphs.',
  ].join('\n');
}

/**
 * Create the user's daily briefing hook if missing; re-enable it if it was
 * disabled. Returns the hook id. Idempotent — safe to call on every login.
 */
export async function ensureDailyBriefingHook(
  userId: string,
  opts: { timezone?: string; cronExpression?: string; now?: Date } = {},
): Promise<string> {
  const now = opts.now ?? new Date();
  const timezone = opts.timezone ?? 'UTC';
  const cronExpression = opts.cronExpression ?? DAILY_BRIEFING_CRON;
  const db = getDb();
  const [existing] = await db
    .select()
    .from(hooks)
    .where(and(eq(hooks.userId, userId), eq(hooks.trigger, 'schedule'), eq(hooks.name, DAILY_BRIEFING_HOOK_NAME)))
    .limit(1);

  if (existing) {
    if (!existing.isEnabled) {
      await db
        .update(hooks)
        .set({
          isEnabled: true,
          nextRunAt: getNextCronDate(
            (existing.triggerConfig?.cronExpression as string | undefined) ?? cronExpression,
            (existing.triggerConfig?.timezone as string | undefined) ?? timezone,
          ),
          lastError: null,
          updatedAt: now,
        })
        .where(eq(hooks.id, existing.id));
    }
    return existing.id;
  }

  const [row] = await db
    .insert(hooks)
    .values({
      userId,
      name: DAILY_BRIEFING_HOOK_NAME,
      description: 'Weekday-morning digest: to-dos, calendar, inbox, code, notifications — and the three things to do first.',
      trigger: 'schedule',
      triggerConfig: { cronExpression, timezone },
      action: 'spawn_agent',
      actionConfig: { agentPrompt: dailyBriefingPrompt(), orchestrated: true, notifyRoot: true },
      isEnabled: true,
      nextRunAt: getNextCronDate(cronExpression, timezone),
    })
    .returning({ id: hooks.id });
  return row.id;
}

/** Pause the user's daily briefing. Idempotent no-op when none exists. */
export async function disableDailyBriefingHook(userId: string, now: Date = new Date()): Promise<void> {
  const db = getDb();
  await db
    .update(hooks)
    .set({ isEnabled: false, updatedAt: now })
    .where(and(eq(hooks.userId, userId), eq(hooks.trigger, 'schedule'), eq(hooks.name, DAILY_BRIEFING_HOOK_NAME)));
}
