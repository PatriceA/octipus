/**
 * Heartbeat loop (WS2) — a periodic per-user agent turn that reviews standing
 * context and either acts or stays silent.
 *
 * Built on the LIVE hooks/cron path (not the unused queue Scheduler): a per-user
 * hook with `trigger='heartbeat'` becomes "due" on an interval; `maybeRunHeartbeats`
 * (called each cron tick) runs a **cheap deterministic gate BEFORE any LLM tokens
 * are spent** — quiet hours → skip; daily cap → skip; user out of token budget →
 * skip; then an "anything pending?" probe over due tasks + unread notifications,
 * and — when enabled — the user's pull requests with failing checks and calendar
 * events about to start (`heartbeat-probes.ts`). Only a non-empty probe spawns
 * an orchestrated turn on the `heartbeat` channel, seeded with the pending
 * checklist + the user's standing `HEARTBEAT` note.
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
import {
  type CalendarProbeDeps,
  defaultCalendarDeps,
  type FailingPullRequest,
  type GithubProbeDeps,
  probeFailingPullRequests,
  probeUpcomingEvents,
  runGh,
  type UpcomingEvent,
} from './heartbeat-probes';

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
  /** Open PRs by the user whose latest checks are red (empty when the probe is off or gh is absent). */
  failingPullRequests: FailingPullRequest[];
  /** Calendar events starting within the lookahead window (empty when off or no calendar is connected). */
  upcomingEvents: UpcomingEvent[];
  /** The GitHub source could not be read this tick (its seen set must be kept, not pruned). */
  githubUnavailable?: boolean;
  /** At least one connected calendar could not be read this tick (same rule). */
  calendarPartial?: boolean;
}

/** External runners the probe uses; injectable so the gate is testable without gh or a calendar. */
export interface HeartbeatProbeDeps {
  github: GithubProbeDeps;
  calendar: CalendarProbeDeps;
  /**
   * Whether THIS user's heartbeat may read the server's `gh`. The CLI's
   * identity belongs to whoever authenticated it — the operator — so the
   * probe is limited to admin users, and a stored DENY on `github/read`
   * still wins. A per-user GitHub credential is enterprise-track work
   * (org-level connectors); until then a non-admin's heartbeat must not be
   * fed another person's pull requests.
   */
  githubAllowed: (userId: string) => Promise<boolean>;
}

async function defaultGithubAllowed(userId: string): Promise<boolean> {
  try {
    const { userRepository } = await import('@/db/repositories/user-repository');
    const user = await userRepository.findById(userId);
    if (!user?.isAdmin) return false;
    const { getPermissionManager } = await import('@/security/permissions');
    const check = await getPermissionManager().check(userId, 'github', 'read');
    return check.level !== 'DENY';
  } catch (err) {
    coreLogger.debug({ err, userId }, 'heartbeat: github eligibility check failed (treating as not allowed)');
    return false;
  }
}

const defaultProbeDeps: HeartbeatProbeDeps = { github: { runGh }, calendar: defaultCalendarDeps, githubAllowed: defaultGithubAllowed };

/** Identity of an external item for the per-hook "already surfaced" set. */
export function pullRequestKey(pr: FailingPullRequest): string {
  return `${pr.url}@${pr.state}`;
}
export function eventKey(e: UpcomingEvent): string {
  return `${e.provider}|${e.start}|${e.title}`;
}

export interface HeartbeatSeen { prs: string[]; events: string[] }

function readSeen(hook: Hook): HeartbeatSeen {
  const seen = (hook.triggerConfig ?? {}).heartbeatSeen;
  return { prs: Array.isArray(seen?.prs) ? seen.prs : [], events: Array.isArray(seen?.events) ? seen.events : [] };
}

export function probeHasWork(p: HeartbeatProbe): boolean {
  return p.dueTasks.length > 0 || p.unreadNotifications.length > 0 || p.failingPullRequests.length > 0 || p.upcomingEvents.length > 0;
}

async function probePendingWork(
  userId: string,
  now: Date,
  config: HeartbeatConfig,
  deps: HeartbeatProbeDeps,
): Promise<HeartbeatProbe> {
  const db = getDb();
  // "Pending now" = open tasks with a due date at/before `now`. The dueAt filter
  // is pushed into SQL (uses the tasks_user_status_due_idx index) so a user with
  // many open-but-not-due tasks can't push the due ones past the LIMIT.
  //
  // The two external probes run alongside the DB ones and are each fail-soft
  // and switchable: the DB probe is the floor, they are the reasons a
  // developer actually wants to be nudged.
  const [due, unread, failingPullRequests, upcoming] = await Promise.all([
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
    config.probeGithub
      ? deps.githubAllowed(userId).then((ok) => (ok ? probeFailingPullRequests(deps.github) : []))
      : Promise.resolve([] as FailingPullRequest[]),
    config.probeCalendar
      ? probeUpcomingEvents(userId, now, config.calendarLookaheadMinutes, deps.calendar)
      : Promise.resolve({ events: [] as UpcomingEvent[], partial: false }),
  ]);
  return {
    dueTasks: due,
    unreadNotifications: unread,
    failingPullRequests: failingPullRequests ?? [],
    upcomingEvents: upcoming.events,
    // "Could not read" is not "nothing there": the seen set for an
    // unavailable source is carried over, not rebuilt from an empty list.
    githubUnavailable: failingPullRequests === null,
    calendarPartial: upcoming.partial,
  };
}

/**
 * `HH:MM` for an ISO instant in the user's zone (the zone the quiet hours
 * use). The zone is named once in the section header rather than per line:
 * zone abbreviations are locale-dependent ("PDT" in one locale, "GMT-7" in
 * another) and the IANA name is the one thing both the user and the agent
 * can read unambiguously.
 */
function localClock(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** Render the probe findings as a compact checklist for the agent prompt. Times in `tz`. */
export function renderChecklist(p: HeartbeatProbe, tz = 'UTC'): string {
  const lines: string[] = [];
  if (p.upcomingEvents.length > 0) {
    lines.push(`Starting soon (${p.upcomingEvents.length}, times in ${tz}):`);
    for (const e of p.upcomingEvents.slice(0, 10)) {
      lines.push(`- ${localClock(e.start, tz)} ${e.title}${e.end ? ` (until ${localClock(e.end, tz)})` : ''}`);
    }
  }
  if (p.failingPullRequests.length > 0) {
    lines.push(`Pull requests with failing checks (${p.failingPullRequests.length}):`);
    for (const pr of p.failingPullRequests.slice(0, 10)) {
      lines.push(`- ${pr.repo}#${pr.number} ${pr.title} — ${pr.url}`);
    }
  }
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
  /** External items the probe saw this tick (surfaced or already known), for the caller to persist. */
  seen: HeartbeatSeen;
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
  deps: HeartbeatProbeDeps = defaultProbeDeps,
): Promise<GateEvaluation> {
  const dayKey = localDayKey(now, config.quietHoursTimezone);
  const runsToday = readRunCounter(hook, dayKey);
  const previouslySeen = readSeen(hook);
  const skip = (reason: HeartbeatSkipReason, seen: HeartbeatSeen = previouslySeen): GateEvaluation =>
    ({ decision: { run: false, reason }, runsToday, dayKey, seen });

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

  const raw = await probePendingWork(hook.userId, now, config, deps);

  // A red PR or a meeting in the window has no "done" the user can click, so
  // an item already surfaced does not count again. `seen` is rebuilt from what
  // the probe sees NOW, so an item that cleared and came back is new again.
  // A source that could not be read keeps its previous set (a partial calendar
  // keeps the union); otherwise one gh timeout would prune everything and the
  // next good tick would re-nudge every PR that is still red.
  const currentPrs = raw.failingPullRequests.map(pullRequestKey);
  const currentEvents = raw.upcomingEvents.map(eventKey);
  const seen: HeartbeatSeen = {
    prs: raw.githubUnavailable ? previouslySeen.prs : currentPrs,
    events: raw.calendarPartial ? [...new Set([...previouslySeen.events, ...currentEvents])] : currentEvents,
  };
  const knownPrs = new Set(previouslySeen.prs);
  const knownEvents = new Set(previouslySeen.events);
  const probe: HeartbeatProbe = {
    ...raw,
    failingPullRequests: raw.failingPullRequests.filter((pr) => !knownPrs.has(pullRequestKey(pr))),
    upcomingEvents: raw.upcomingEvents.filter((e) => !knownEvents.has(eventKey(e))),
  };
  if (!probeHasWork(probe)) return skip('nothing_pending', seen);

  const message = await buildHeartbeatMessage(hook.userId, renderChecklist(probe, config.quietHoursTimezone));
  return { decision: { run: true, message }, runsToday, dayKey, seen };
}

/** Run `fn` over `items` with at most `limit` in flight; every item runs, failures are the caller's. */
async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * The GitHub search returns the same thing for every admin on a tick (one
 * CLI identity), so ask once per tick and share the promise.
 */
function memoizeGhPerTick(runGhFn: GithubProbeDeps['runGh']): GithubProbeDeps['runGh'] {
  const cache = new Map<string, Promise<string>>();
  return (args) => {
    const key = args.join('\u0000');
    let p = cache.get(key);
    if (!p) {
      p = runGhFn(args);
      cache.set(key, p);
    }
    return p;
  };
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
const HEARTBEAT_GATE_CONCURRENCY = 4;

export async function maybeRunHeartbeats(
  now: Date = new Date(),
  deps: HeartbeatProbeDeps = defaultProbeDeps,
  config: HeartbeatConfig = getConfig().heartbeat,
): Promise<void> {
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
  const tickDeps: HeartbeatProbeDeps = { ...deps, github: { runGh: memoizeGhPerTick(deps.github.runGh) } };

  // Bounded concurrency: a gate now waits on `gh` and a calendar, so a serial
  // walk over many due users would hold the cron tick for minutes.
  await forEachLimited(due, HEARTBEAT_GATE_CONCURRENCY, async (hook) => {
    try {
      const gate = await evaluateHeartbeatGate(hook, config, now, tickDeps);

      // Persist nextRunAt + the (possibly reset) day counter + the seen set
      // BEFORE firing, so a long orchestrated turn can't cause a duplicate
      // fire on the next tick.
      const runsToday = gate.decision.run ? gate.runsToday + 1 : gate.runsToday;
      await db
        .update(hooks)
        .set({
          nextRunAt,
          triggerConfig: { ...(hook.triggerConfig ?? {}), heartbeatDayKey: gate.dayKey, heartbeatRunsToday: runsToday, heartbeatSeen: gate.seen },
          updatedAt: now,
        })
        .where(eq(hooks.id, hook.id));

      if (!gate.decision.run) {
        coreLogger.debug({ hookId: hook.id, userId: hook.userId, reason: gate.decision.reason }, 'Heartbeat skipped');
        return;
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
  });
}
