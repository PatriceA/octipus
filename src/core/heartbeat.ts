/**
 * Heartbeat loop (WS2) — a periodic per-user agent turn that reviews standing
 * context and either acts or stays silent.
 *
 * Built on the LIVE hooks/cron path (not the unused queue Scheduler): a per-user
 * hook with `trigger='heartbeat'` becomes "due" on an interval; `maybeRunHeartbeats`
 * (called each cron tick) runs a **cheap deterministic gate BEFORE any LLM tokens
 * are spent** — quiet hours → skip; daily cap → skip; user out of token budget →
 * skip; then an "anything pending?" probe over due tasks + unread notifications.
 * Only a non-empty probe spawns an orchestrated turn on the `heartbeat` channel,
 * seeded with the pending checklist + the user's standing `HEARTBEAT` note.
 *
 * Silence is the default: an empty probe spends zero tokens.
 */
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { getConfig } from '@/config';
import type { HeartbeatConfig } from '@/config/schema';
import { getDb } from '@/db/postgres';
import { type Hook, hooks } from '@/db/schema/hooks';
import { notifications } from '@/db/schema/notifications';
import { tasks } from '@/db/schema/tasks';
import { coreLogger } from '@/utils/logger';

/** Root agent channel + note slug for standing instructions. */
export const HEARTBEAT_CHANNEL = 'heartbeat';
export const HEARTBEAT_NOTE_SLUG = 'heartbeat';

// ── Time helpers (tz-aware, `now` injected so they're pure + testable) ──────

/** Local hour [0,23] for `now` in IANA `tz`, falling back to UTC on bad tz. */
export function localHour(now: Date, tz: string): number {
  try {
    const s = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(now);
    const h = Number.parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/** `YYYY-MM-DD` for `now` in `tz` — the calendar-day key for the daily cap. */
export function localDayKey(now: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * True when `now`'s local hour is inside the quiet-hours window `[start, end)`.
 * Handles a window that wraps midnight (e.g. 22→7). Equal start/end = disabled.
 */
export function isWithinQuietHours(config: HeartbeatConfig, now: Date): boolean {
  const { quietHoursStart: s, quietHoursEnd: e, quietHoursTimezone: tz } = config;
  if (s === e) return false;
  const h = localHour(now, tz);
  return s < e ? h >= s && h < e : h >= s || h < e;
}

// ── Probe (deterministic "anything pending?" — no LLM) ──────────────────────

export interface HeartbeatProbe {
  dueTasks: Array<{ title: string; dueAt: Date | null }>;
  unreadNotifications: Array<{ title: string; type: string }>;
}

export function probeHasWork(p: HeartbeatProbe): boolean {
  return p.dueTasks.length > 0 || p.unreadNotifications.length > 0;
}

async function probePendingWork(userId: string, now: Date): Promise<HeartbeatProbe> {
  const db = getDb();
  // "Pending now" = open tasks with a due date at/before `now`. The dueAt filter
  // is pushed into SQL (uses the tasks_user_status_due_idx index) so a user with
  // many open-but-not-due tasks can't push the due ones past the LIMIT.
  const [due, unread] = await Promise.all([
    db
      .select({ title: tasks.title, dueAt: tasks.dueAt })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.status, 'open'), isNotNull(tasks.dueAt), lte(tasks.dueAt, now)))
      .limit(50),
    db
      .select({ title: notifications.title, type: notifications.type })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)))
      .limit(50),
  ]);
  return { dueTasks: due, unreadNotifications: unread };
}

/** Render the probe findings as a compact checklist for the agent prompt. */
export function renderChecklist(p: HeartbeatProbe): string {
  const lines: string[] = [];
  if (p.dueTasks.length > 0) {
    lines.push(`Due tasks (${p.dueTasks.length}):`);
    for (const t of p.dueTasks.slice(0, 10)) {
      lines.push(`- ${t.title}${t.dueAt ? ` (due ${t.dueAt.toISOString().slice(0, 10)})` : ''}`);
    }
  }
  if (p.unreadNotifications.length > 0) {
    lines.push(`Unread notifications (${p.unreadNotifications.length}):`);
    for (const n of p.unreadNotifications.slice(0, 10)) {
      lines.push(`- [${n.type}] ${n.title}`);
    }
  }
  return lines.join('\n');
}

/** Standing instructions live in the user's pinned `HEARTBEAT` note (best-effort). */
async function readStandingInstructions(userId: string): Promise<string> {
  try {
    const { getNoteRepository } = await import('@/db/repositories/note-repository');
    const note = await getNoteRepository().getBySlug(userId, null, HEARTBEAT_NOTE_SLUG);
    return note?.body?.trim() ?? '';
  } catch (err) {
    coreLogger.debug({ err, userId }, 'heartbeat: standing-note read failed (proceeding without)');
    return '';
  }
}

async function buildHeartbeatMessage(userId: string, checklist: string): Promise<string> {
  const standing = await readStandingInstructions(userId);
  const parts = [
    'Heartbeat check-in. Review the standing instructions and the pending items below.',
    'Act only where genuinely warranted. If nothing needs action, END THE TURN SILENTLY — do not message the user.',
  ];
  if (standing) parts.push(`\n## Standing instructions\n${standing}`);
  parts.push(`\n## Pending\n${checklist}`);
  return parts.join('\n');
}

// ── The gate ────────────────────────────────────────────────────────────────

export type HeartbeatSkipReason = 'disabled' | 'quiet_hours' | 'daily_cap' | 'quota' | 'nothing_pending';
export type HeartbeatDecision =
  | { run: true; message: string }
  | { run: false; reason: HeartbeatSkipReason };

interface GateEvaluation {
  decision: HeartbeatDecision;
  /** Runs already recorded today (post day-rollover reset), for the caller to persist. */
  runsToday: number;
  dayKey: string;
}

/** Read the per-hook daily-run counter, resetting it when the calendar day rolls over. */
function readRunCounter(hook: Hook, dayKey: string): number {
  const cfg = (hook.triggerConfig ?? {}) as Record<string, unknown>;
  return cfg.heartbeatDayKey === dayKey ? Number(cfg.heartbeatRunsToday ?? 0) : 0;
}

/**
 * Cheap-first gate. Ordered so the cheapest checks (config, quiet hours, cap)
 * run before the DB probe, and NO LLM work happens until a non-empty probe.
 */
export async function evaluateHeartbeatGate(
  hook: Hook,
  config: HeartbeatConfig,
  now: Date,
): Promise<GateEvaluation> {
  const dayKey = localDayKey(now, config.quietHoursTimezone);
  const runsToday = readRunCounter(hook, dayKey);
  const skip = (reason: HeartbeatSkipReason): GateEvaluation => ({ decision: { run: false, reason }, runsToday, dayKey });

  if (!config.enabled) return skip('disabled');
  if (isWithinQuietHours(config, now)) return skip('quiet_hours');
  if (runsToday >= config.maxRunsPerDay) return skip('daily_cap');

  // Already out of daily token budget → don't even probe.
  try {
    const { getQuotaManager } = await import('@/security/quotas');
    const q = await getQuotaManager().willExceed(hook.userId, 'tokensPerDay', 0);
    if (!q.allowed) return skip('quota');
  } catch (err) {
    coreLogger.debug({ err }, 'heartbeat: quota check unavailable (not blocking)');
  }

  const probe = await probePendingWork(hook.userId, now);
  if (!probeHasWork(probe)) return skip('nothing_pending');

  const message = await buildHeartbeatMessage(hook.userId, renderChecklist(probe));
  return { decision: { run: true, message }, runsToday, dayKey };
}

// ── Per-user enablement ─────────────────────────────────────────────────────

/**
 * Ensure the caller has exactly one enabled heartbeat hook (idempotent). This is
 * the per-user "enable heartbeat" action — a settings toggle calls it. The
 * global `config.heartbeat.enabled` switch still gates whether any hook runs.
 * Returns the hook id.
 */
export async function ensureHeartbeatHook(userId: string, now: Date = new Date()): Promise<string> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(hooks)
    .where(and(eq(hooks.trigger, 'heartbeat'), eq(hooks.userId, userId)))
    .limit(1);

  if (existing) {
    if (!existing.isEnabled) {
      await db.update(hooks).set({ isEnabled: true, nextRunAt: now, updatedAt: now }).where(eq(hooks.id, existing.id));
    }
    return existing.id;
  }

  const [row] = await db
    .insert(hooks)
    .values({
      userId,
      name: 'Heartbeat',
      description: 'Periodic check-in that reviews standing context and acts or stays silent.',
      trigger: 'heartbeat',
      triggerConfig: {},
      action: 'spawn_agent',
      actionConfig: { orchestrated: true, agentPrompt: '' },
      isEnabled: true,
      nextRunAt: now, // due on the next tick
    })
    .returning({ id: hooks.id });
  return row.id;
}

/** Disable the caller's heartbeat hook(s). Idempotent no-op if none exist. */
export async function disableHeartbeatHook(userId: string, now: Date = new Date()): Promise<void> {
  const db = getDb();
  await db
    .update(hooks)
    .set({ isEnabled: false, updatedAt: now })
    .where(and(eq(hooks.trigger, 'heartbeat'), eq(hooks.userId, userId)));
}

// ── Cron entry point ────────────────────────────────────────────────────────

/** A heartbeat hook is due when it has never run or its interval has elapsed. */
function isDue(hook: Hook, now: Date): boolean {
  return hook.nextRunAt == null || hook.nextRunAt <= now;
}

/**
 * Process all enabled heartbeat hooks: advance each hook's `nextRunAt` by the
 * interval, run the gate, and fire an orchestrated turn only when the gate says
 * so. Called once per cron tick (before the schedule query's early return).
 * No-op when the heartbeat feature is disabled.
 */
export async function maybeRunHeartbeats(now: Date = new Date()): Promise<void> {
  const config = getConfig().heartbeat;
  if (!config?.enabled) return;

  const db = getDb();
  const candidates = await db
    .select()
    .from(hooks)
    .where(and(eq(hooks.trigger, 'heartbeat'), eq(hooks.isEnabled, true)));

  const due = candidates.filter((h) => isDue(h, now));
  if (due.length === 0) return;

  const { getHookManager } = await import('@/hooks/manager');
  const hookManager = getHookManager();
  const nextRunAt = new Date(now.getTime() + config.intervalMinutes * 60_000);

  for (const hook of due) {
    try {
      const gate = await evaluateHeartbeatGate(hook, config, now);

      // Persist nextRunAt + the (possibly reset) day counter BEFORE firing, so a
      // long orchestrated turn can't cause a duplicate fire on the next tick.
      const runsToday = gate.decision.run ? gate.runsToday + 1 : gate.runsToday;
      await db
        .update(hooks)
        .set({
          nextRunAt,
          triggerConfig: { ...(hook.triggerConfig ?? {}), heartbeatDayKey: gate.dayKey, heartbeatRunsToday: runsToday },
          updatedAt: now,
        })
        .where(eq(hooks.id, hook.id));

      if (!gate.decision.run) {
        coreLogger.debug({ hookId: hook.id, userId: hook.userId, reason: gate.decision.reason }, 'Heartbeat skipped');
        continue;
      }

      // Fire-and-forget the orchestrated turn (can take minutes) with the probe
      // checklist + standing instructions as the message. `executeSpawnAgent`
      // routes it on the 'heartbeat' channel (via hook.trigger).
      hookManager
        .trigger(
          { type: 'heartbeat', data: { hookId: hook.id }, timestamp: now },
          {
            // Carry the rendered heartbeat message so executeSpawnAgent uses it
            // verbatim. channelType is a placeholder — the root agent channel
            // is set to 'heartbeat' by executeSpawnAgent from hook.trigger.
            message: {
              id: `heartbeat-${hook.id}-${now.getTime()}`,
              channelType: 'api',
              channelId: hook.userId,
              userId: hook.userId,
              content: gate.decision.message,
              timestamp: now,
            },
          },
        )
        .catch((err) => coreLogger.error({ err, hookId: hook.id }, 'Heartbeat run failed'));

      coreLogger.info({ hookId: hook.id, userId: hook.userId }, 'Heartbeat triggered');
    } catch (err) {
      coreLogger.error({ err, hookId: hook.id }, 'Heartbeat processing failed');
    }
  }
}
