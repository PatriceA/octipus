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
 *
 * Role heartbeats (work board, after Paperclip: "agents wake on a heartbeat,
 * pick up assigned work, check it out"). A heartbeat hook whose
 * `triggerConfig.role` names a role (e.g. 'coding') is that role's agent for
 * its owner. Same gate — quiet hours, daily cap, quota — but the probe is the
 * owner's tasks assigned to the role that are ready: active, not waiting on
 * an active blocker or child (`waitingOn`), and not held by a live checkout
 * lease. A non-empty probe spawns the role's agent (see executeSpawnAgent)
 * with the ready ids and titles and the check-out / comment / complete
 * protocol. A task wakeup (core/tasks/wakeups.ts) for a role-assigned task
 * marks that role's hook due, so the next cron tick runs its gate instead of
 * waiting out the interval (`startRoleHeartbeatWakeups`). Users with no role
 * heartbeat hook see none of this.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import type { HeartbeatConfig } from '@/config/schema';
import { getDb } from '@/db/postgres';
import { type Hook, hooks } from '@/db/schema/hooks';
import { notifications } from '@/db/schema/notifications';
import { tasks } from '@/db/schema/tasks';
import { TASK_CHECKOUT_TTL_MS } from '@/core/tasks/checkout';
import { ACTIVE_TASK_STATUSES } from '@/core/tasks/status';
import { isWaiting, toLookup } from '@/core/tasks/structure';
import { onTaskWakeup, type TaskWakeupEvent } from '@/core/tasks/wakeups';
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

// ── Role heartbeats (work board) ────────────────────────────────────────────

/** A role name as stored on `tasks.assignee_ref` and `hooks.trigger_config.role`. */
const ROLE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/** Most role-assigned candidates one probe reads (highest priority, oldest first). */
const ROLE_PROBE_LIMIT = 100;

/** The role a heartbeat hook works as, or null for the plain per-user heartbeat. */
export function heartbeatRole(hook: { trigger: string; triggerConfig: Hook['triggerConfig'] | null }): string | null {
  if (hook.trigger !== 'heartbeat') return null;
  const role = (hook.triggerConfig ?? {}).role;
  return typeof role === 'string' && ROLE_NAME.test(role) ? role : null;
}

/** `trigger_config->>'role'` on the hooks table. */
const hookRole = sql`${hooks.triggerConfig}->>'role'`;

export interface RoleTask { id: string; title: string }

/**
 * The owner's tasks assigned to `role` that an agent of it could check out
 * now: active, not waiting on an active blocker or active child (the
 * `waitingOn` rule), and not held by a live checkout — nobody holds it or the
 * lease (TASK_CHECKOUT_TTL_MS, the board's) has lapsed as of `now`. One query
 * for the candidates, one for the active rows they could be waiting on.
 * The board's checkout re-checks all of this atomically; this is only the
 * "anything to do?" gate, so a race here costs one refused checkout, never a
 * double claim.
 */
export async function probeRoleWork(userId: string, role: string, now: Date): Promise<RoleTask[]> {
  const db = getDb();
  const active = [...ACTIVE_TASK_STATUSES];
  const leaseStart = new Date(now.getTime() - TASK_CHECKOUT_TTL_MS);
  const candidates = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, parentId: tasks.parentId, blockedBy: tasks.blockedBy })
    .from(tasks)
    .where(and(
      eq(tasks.userId, userId),
      eq(tasks.assigneeKind, 'role'),
      eq(tasks.assigneeRef, role),
      inArray(tasks.status, active),
      or(isNull(tasks.checkedOutBy), isNull(tasks.checkedOutAt), lt(tasks.checkedOutAt, leaseStart)),
    ))
    .orderBy(desc(tasks.priority), asc(tasks.createdAt), asc(tasks.id))
    .limit(ROLE_PROBE_LIMIT);
  if (candidates.length === 0) return [];

  const blockerIds = [...new Set(candidates.flatMap((c) => c.blockedBy ?? []))];
  const related: SQL[] = [inArray(tasks.parentId, candidates.map((c) => c.id))];
  if (blockerIds.length > 0) related.push(inArray(tasks.id, blockerIds));
  const waitingOnRows = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, parentId: tasks.parentId, blockedBy: tasks.blockedBy })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.status, active), or(...related)));
  const lookup = toLookup(waitingOnRows);
  return candidates.filter((c) => !isWaiting(c, lookup)).map((c) => ({ id: c.id, title: c.title }));
}

/** The role agent's instruction for one heartbeat: the ready tasks and the board protocol. */
export function renderRoleHeartbeatMessage(role: string, ready: readonly RoleTask[]): string {
  const shown = ready.slice(0, 20);
  const lines = [
    `Role heartbeat: you are the \`${role}\` agent. These tasks are assigned to the ${role} role and ready to work (nothing blocks them, nobody holds them):`,
    ...shown.map((t) => `- ${t.id} — ${t.title}`),
  ];
  if (ready.length > shown.length) lines.push(`(${ready.length - shown.length} more; they will come up on a later heartbeat.)`);
  lines.push(
    '',
    'For each task, in order:',
    '1. Call `checkout_task` with its id FIRST. If it refuses (another agent holds it — a 409 conflict — or it is blocked), skip that task and go to the next one. Never work a task you did not check out.',
    '2. Work the task. Call `checkout_task` again on long work to renew the claim (it lapses after 30 minutes).',
    '3. Record progress with `add_task_comment` as you go, and a short summary of what you did at the end.',
    '4. When it is done, call `complete_task`. If you cannot finish it, say why in a comment and give it back with `checkout_task` and `release: true`.',
    'If every task was skipped, end the turn quietly.',
  );
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

  // A role hook's pending work is the role's ready tasks, nothing else: the
  // user's own heartbeat covers PRs, meetings and notifications.
  const role = heartbeatRole(hook);
  if (role) {
    const ready = await probeRoleWork(hook.userId, role, now);
    if (ready.length === 0) return skip('nothing_pending');
    return { decision: { run: true, message: renderRoleHeartbeatMessage(role, ready) }, runsToday, dayKey, seen: previouslySeen };
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
    .where(and(eq(hooks.trigger, 'heartbeat'), eq(hooks.userId, userId), sql`${hookRole} IS NULL`))
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

/** Disable the caller's heartbeat hook(s) (not role heartbeats). Idempotent no-op if none exist. */
export async function disableHeartbeatHook(userId: string, now: Date = new Date()): Promise<void> {
  const db = getDb();
  await db
    .update(hooks)
    .set({ isEnabled: false, updatedAt: now })
    .where(and(eq(hooks.trigger, 'heartbeat'), eq(hooks.userId, userId), sql`${hookRole} IS NULL`));
}

/** Reload the hook manager's cache so a hook written here fires (best-effort). */
async function reloadHookCache(): Promise<void> {
  try {
    const { getHookManager } = await import('@/hooks/manager');
    await getHookManager().loadHooks();
  } catch (err) {
    coreLogger.warn({ err }, 'heartbeat: hook cache reload failed (the hook fires after the next reload)');
  }
}

/**
 * Ensure `userId` has exactly one enabled heartbeat hook working as `role`
 * (idempotent), the role counterpart of `ensureHeartbeatHook`. Its turn is
 * the role's agent (executeSpawnAgent spawns it as that role, with the tasks
 * tool), so it runs directly rather than through the root agent. The same
 * row can be written through POST /api/hooks with `trigger: 'heartbeat'` and
 * `triggerConfig: { role }`. Returns the hook id.
 */
export async function ensureRoleHeartbeatHook(userId: string, role: string, now: Date = new Date()): Promise<string> {
  if (!ROLE_NAME.test(role)) throw new Error(`Invalid role "${role}"`);
  const db = getDb();
  const [existing] = await db
    .select()
    .from(hooks)
    .where(and(eq(hooks.trigger, 'heartbeat'), eq(hooks.userId, userId), sql`${hookRole} = ${role}`))
    .limit(1);

  if (existing) {
    if (!existing.isEnabled) {
      await db.update(hooks).set({ isEnabled: true, nextRunAt: now, updatedAt: now }).where(eq(hooks.id, existing.id));
      await reloadHookCache();
    }
    return existing.id;
  }

  const [row] = await db
    .insert(hooks)
    .values({
      userId,
      name: `Heartbeat (${role})`,
      description: `The ${role} agent: wakes on the heartbeat, checks out ready tasks assigned to the ${role} role and works them.`,
      trigger: 'heartbeat',
      triggerConfig: { role },
      action: 'spawn_agent',
      actionConfig: { orchestrated: false, agentPrompt: '' },
      isEnabled: true,
      nextRunAt: now, // due on the next tick
    })
    .returning({ id: hooks.id });
  await reloadHookCache();
  return row.id;
}

/** Disable `userId`'s heartbeat hook for `role`. Idempotent. */
export async function disableRoleHeartbeatHook(userId: string, role: string, now: Date = new Date()): Promise<void> {
  const db = getDb();
  await db
    .update(hooks)
    .set({ isEnabled: false, updatedAt: now })
    .where(and(eq(hooks.trigger, 'heartbeat'), eq(hooks.userId, userId), sql`${hookRole} = ${role}`));
}

/**
 * A task wakeup for a role-assigned task marks that role's enabled heartbeat
 * hook for the owner due now (nextRunAt = now), so the next cron tick runs
 * its gate. It never runs the turn: quiet hours, the daily cap and the quota
 * stay the gate's, unchanged. One UPDATE; it matches nothing for a task that
 * is not assigned to a role or an owner with no heartbeat hook for it, and a
 * hook already due is left alone. Returns the ids of the hooks it marked.
 */
export async function markRoleHeartbeatDue(userId: string, taskId: string, now: Date = new Date()): Promise<string[]> {
  const db = getDb();
  const assignedRole = sql`(SELECT t.assignee_ref FROM tasks t WHERE t.id = ${taskId}::uuid AND t.user_id = ${userId}::uuid AND t.assignee_kind = 'role')`;
  const marked = await db
    .update(hooks)
    .set({ nextRunAt: now, updatedAt: now })
    .where(and(
      eq(hooks.trigger, 'heartbeat'),
      eq(hooks.isEnabled, true),
      eq(hooks.userId, userId),
      sql`${hookRole} = ${assignedRole}`,
      or(isNull(hooks.nextRunAt), gt(hooks.nextRunAt, now)),
    ))
    .returning({ id: hooks.id });
  return marked.map((m) => m.id);
}

/** The wakeup listener. A throw is logged by the wakeup bus and reaches nothing else. */
async function onRoleTaskWakeup(event: TaskWakeupEvent): Promise<void> {
  const marked = await markRoleHeartbeatDue(event.userId, event.taskId);
  if (marked.length > 0) {
    coreLogger.info({ userId: event.userId, taskId: event.taskId, type: event.type, hookIds: marked }, 'Role heartbeat marked due by a task wakeup');
  }
}

let unsubscribeRoleWakeups: (() => void) | null = null;

/** Subscribe role heartbeats to task wakeups (called once at startup; idempotent). */
export function startRoleHeartbeatWakeups(): void {
  unsubscribeRoleWakeups ??= onTaskWakeup(onRoleTaskWakeup);
}

/** Undo `startRoleHeartbeatWakeups` (shutdown, tests). Idempotent. */
export function stopRoleHeartbeatWakeups(): void {
  unsubscribeRoleWakeups?.();
  unsubscribeRoleWakeups = null;
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
