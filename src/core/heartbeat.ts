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
 *
 * Guards on a role turn, all in the gate or on the way out of it:
 *   - the board writes need the owner's ALLOW on tasks/write (the tasks tool
 *     asks otherwise, and an unattended turn cannot be asked): without it the
 *     gate skips with `tasks_permission_required` and notifies the owner once;
 *   - one turn per hook at a time (`in_flight`), across server processes: a
 *     lease on the hook row (`triggerConfig.heartbeatInFlightUntil` + a
 *     `heartbeatInFlightToken` naming instance, boot and a random part),
 *     claimed by a conditional UPDATE in the gate before the probe (given
 *     back on any skip), renewed while the turn runs, cleared by its holder
 *     when it settles or on a graceful shutdown, cleared at startup when a
 *     previous boot of this instance left it, and otherwise expiring by TTL
 *     (`claimRoleTurnLease`);
 *   - the daily cap counts every heartbeat hook of the user together;
 *   - executeSpawnAgent runs a role turn only for a context this gate marked
 *     (`markHeartbeatGatePassed`), so a manual trigger cannot skip it. That
 *     mark is in-process on purpose: the tick that passes the gate fires the
 *     action in the same process.
 *
 * Task wakeups reach every server process (the wakeup bridge relays them over
 * Postgres LISTEN/NOTIFY); marking a hook due is a DB write, so only the
 * process where the close happened does it (remote events are ignored here).
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import type { HeartbeatConfig } from '@/config/schema';
import { getDb } from '@/db/postgres';
import { type Hook, hooks, SERVER_TRIGGER_CONFIG_KEYS } from '@/db/schema/hooks';
import { notifications } from '@/db/schema/notifications';
import { tasks } from '@/db/schema/tasks';
import { users } from '@/db/schema/users';
import { ACTIVE_TASK_STATUSES } from '@/core/tasks/status';
import { onTaskWakeup, type TaskWakeupEvent } from '@/core/tasks/wakeups';
import { notInSharedWorkspace, taskLeaseFree, taskNotWaiting } from '@/db/repositories/scoped';
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
  /** Role hooks: may the owner's role agent write the board unattended? Defaults to the permission manager. */
  boardWritesAllowed?: (hook: Hook) => Promise<boolean>;
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
      .where(and(eq(tasks.userId, userId), notInSharedWorkspace(tasks.workspaceId), eq(tasks.status, 'open'), isNotNull(tasks.dueAt), lte(tasks.dueAt, now)))
      .limit(50),
    db
      .select({ title: notifications.title, type: notifications.type })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), notInSharedWorkspace(notifications.workspaceId), eq(notifications.read, false)))
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

/** Is `value` shaped like a role name (not whether the role exists)? */
export function isRoleName(value: unknown): value is string {
  return typeof value === 'string' && ROLE_NAME.test(value);
}

/** Most ready tasks one probe returns (highest priority, oldest first). */
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
 * now: active, not waiting on an active blocker or active child, and not held
 * by a live checkout. The last two are the board's own predicates
 * (`taskNotWaiting`, `taskLeaseFree` in db/repositories/scoped.ts), applied in
 * SQL before the LIMIT so a pile of waiting tasks cannot hide a ready one, and
 * judged on the database clock like the checkout. One query. The checkout
 * re-checks all of it atomically; this is only the "anything to do?" gate, so
 * a race here costs one refused checkout, never a double claim.
 */
export async function probeRoleWork(userId: string, role: string): Promise<RoleTask[]> {
  return getDb()
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(
      eq(tasks.userId, userId),
      // Role agents are personal automation: a space task is never theirs.
      notInSharedWorkspace(tasks.workspaceId),
      eq(tasks.assigneeKind, 'role'),
      eq(tasks.assigneeRef, role),
      inArray(tasks.status, [...ACTIVE_TASK_STATUSES]),
      taskLeaseFree(),
      ...taskNotWaiting((t) => [eq(t.userId, userId), notInSharedWorkspace(t.workspaceId)]),
    ))
    .orderBy(desc(tasks.priority), asc(tasks.createdAt), asc(tasks.id))
    .limit(ROLE_PROBE_LIMIT);
}

/**
 * May a role agent of `hook`'s owner write to the board unattended? The
 * tasks tool's `write` (checkout_task, add_task_comment, update_task,
 * complete_task) defaults to ASK, and a heartbeat turn has nobody to ask, so
 * every write would come back "Approval required" while the loop spends
 * tokens. Checked here, the same way the tool executor checks it, so the gate
 * skips instead. The grant is the owner's to make (an ALLOW on tasks/write in
 * the permission settings). There is no narrower grant to make for them: the
 * stored policy is one row per user, tool and action, so a hook-scoped ALLOW
 * would replace (narrow or widen) the owner's own choice for every session.
 */
async function defaultBoardWritesAllowed(hook: Hook): Promise<boolean> {
  return boardWritesAllowed(hook.userId, hook.sessionId);
}

/**
 * The permission half of `defaultBoardWritesAllowed`, for callers without a
 * hook row (the tasks page's role-agents panel asks it before a hook exists).
 * A failed check reads as not allowed.
 */
export async function boardWritesAllowed(userId: string, sessionId?: string | null): Promise<boolean> {
  try {
    const { getPermissionManager } = await import('@/security/permissions');
    const check = await getPermissionManager().check(userId, 'tasks', 'write', {}, { sessionId: sessionId ?? '', workspaceId: null });
    return check.level === 'ALLOW' && check.allowed;
  } catch (err) {
    coreLogger.warn({ err, userId }, 'heartbeat: tasks permission check failed (treating as not allowed)');
    return false;
  }
}

// ── One role turn per hook, cluster-wide ────────────────────────────────────
//
// The lease on the hook row is the source of truth; the Set is this process's
// fast path (and what tests watch). Lease times are on the database clock,
// like task checkouts, and have nothing to do with the tick's `now`.

/** Hook ids whose role turn is running in this process. */
const roleTurnsInFlight = new Set<string>();

/** Is a turn of this role hook running in this process? */
export function roleTurnInFlight(hookId: string): boolean {
  return roleTurnsInFlight.has(hookId);
}

/** Headroom on top of the turn timeout before an unrenewed lease lapses. */
export const ROLE_TURN_LEASE_MARGIN_MS = 10 * 60_000;

/** Bounds on how often a running turn renews its lease. */
export const LEASE_RENEW_MIN_MS = 60_000;
export const LEASE_RENEW_MAX_MS = 10 * 60_000;

/**
 * How long a role-turn lease lasts: the turn's wall clock (a role turn is a
 * worker, bounded by `agent.defaultTimeout`; an hour when that is 0) plus a
 * margin. The holder renews it while the turn runs (a transient-error retry
 * can outlast one timeout), so the TTL only matters when the holder died
 * without a graceful shutdown on another instance: the hook is free after it.
 */
export function roleTurnLeaseMs(agent: { defaultTimeout: number } = getConfig().agent): number {
  const turn = agent.defaultTimeout > 0 ? agent.defaultTimeout : 60 * 60_000;
  return turn + ROLE_TURN_LEASE_MARGIN_MS;
}

/** How often a running turn renews a lease of `ttlMs`: a third of it, within [1 min, 10 min]. */
export function leaseRenewIntervalMs(ttlMs: number): number {
  return Math.min(LEASE_RENEW_MAX_MS, Math.max(LEASE_RENEW_MIN_MS, Math.floor(ttlMs / 3)));
}

/**
 * Lease tokens are `<instance>|<boot>|<random>`; the boot id is new every
 * process start. The instance is OCTIPUS_INSTANCE_ID when set: an id each
 * server process must hold uniquely and keep across its restarts. Only then
 * can a process on Postgres tell its own previous boots' leases (their turns
 * died with it) from a live sibling's, and clear them at startup
 * (`clearStaleRoleTurnLeases`). Unset, the token names the host for
 * diagnostics only (`~host:<hostname>`, never matched), and such leases are
 * left to lapse by TTL: two processes on one host, or an overlapping restart,
 * share a hostname, so clearing by it would drop a live sibling's lease.
 */
export const LEASE_BOOT_ID = randomUUID();

/** The explicit, stable instance id (OCTIPUS_INSTANCE_ID), or null when unset. */
export function leaseInstanceId(): string | null {
  const id = process.env.OCTIPUS_INSTANCE_ID?.trim();
  // A leading '~' is reserved for the anonymous `~host:` form, so an explicit id never matches one.
  const clean = id?.replaceAll('|', '_').replace(/^~+/, '');
  return clean || null;
}

function newLeaseToken(): string {
  const instance = leaseInstanceId() ?? `~host:${(hostname() || 'unknown').replaceAll('|', '_')}`;
  return `${instance}|${LEASE_BOOT_ID}|${randomUUID()}`;
}

/** Leases this process holds (hook id → token + stop-renewing), for a graceful shutdown. */
const heldLeases = new Map<string, { token: string; stop: () => void }>();

/** False once shutdown began: no new lease is claimed after that. */
let leaseClaimsOpen = true;

const inFlightUntil = sql`(${hooks.triggerConfig}->>'heartbeatInFlightUntil')`;
const inFlightToken = sql`(${hooks.triggerConfig}->>'heartbeatInFlightToken')`;
const leaseExpiry = (ttlMs: number) => sql`to_jsonb(now() + ${ttlMs}::float8 * interval '1 millisecond')`;
const dropLease = sql`${hooks.triggerConfig} - 'heartbeatInFlightUntil' - 'heartbeatInFlightToken'`;

/**
 * Claim the role-turn lease on `hookId`: one conditional UPDATE that sets
 * `heartbeatInFlightUntil = now() + ttl` and a fresh token only if no live
 * lease is there. Returns the token when this caller won, null otherwise
 * (and always null once this process is shutting down).
 */
export async function claimRoleTurnLease(hookId: string, ttlMs: number = roleTurnLeaseMs()): Promise<string | null> {
  if (!leaseClaimsOpen) return null;
  const token = newLeaseToken();
  const [won] = await getDb()
    .update(hooks)
    .set({ triggerConfig: sql`${hooks.triggerConfig} || jsonb_build_object('heartbeatInFlightUntil', ${leaseExpiry(ttlMs)}, 'heartbeatInFlightToken', ${token}::text)` })
    .where(and(eq(hooks.id, hookId), or(sql`${inFlightUntil} IS NULL`, sql`${inFlightUntil}::timestamptz <= now()`)))
    .returning({ id: hooks.id });
  return won ? token : null;
}

/** Push the lease out by `ttlMs` from now, if `token` still holds it. */
export async function renewRoleTurnLease(hookId: string, token: string, ttlMs: number = roleTurnLeaseMs()): Promise<boolean> {
  const rows = await getDb()
    .update(hooks)
    .set({ triggerConfig: sql`jsonb_set(${hooks.triggerConfig}, '{heartbeatInFlightUntil}', ${leaseExpiry(ttlMs)})` })
    .where(and(eq(hooks.id, hookId), sql`${inFlightToken} = ${token}`))
    .returning({ id: hooks.id });
  return rows.length > 0;
}

/** Clear the lease, only if `token` still holds it (a lapsed-and-reclaimed lease is someone else's). */
export async function releaseRoleTurnLease(hookId: string, token: string): Promise<boolean> {
  const rows = await getDb()
    .update(hooks)
    .set({ triggerConfig: dropLease })
    .where(and(eq(hooks.id, hookId), sql`${inFlightToken} = ${token}`))
    .returning({ id: hooks.id });
  return rows.length > 0;
}

/** Does `hookId` carry a live lease, judged on the database clock? */
export async function roleTurnLeaseHeld(hookId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: hooks.id })
    .from(hooks)
    .where(and(eq(hooks.id, hookId), sql`${inFlightUntil} IS NOT NULL`, sql`${inFlightUntil}::timestamptz > now()`))
    .limit(1);
  return !!row;
}

/**
 * Startup: clear the leases left by turns that died with a previous run of
 * this server, and open lease claims.
 *   - `all` (embedded PGlite, one process by nature, or
 *     OCTIPUS_SINGLE_PROCESS=1 on Postgres): every lease is cleared.
 *   - Postgres with OCTIPUS_INSTANCE_ID set: this instance's leases from
 *     other boots only.
 *   - Postgres without it: nothing; every lease lapses by TTL (see
 *     `LEASE_BOOT_ID` for why a hostname is not enough).
 * Other instances' leases are never touched. Returns the number cleared.
 */
export async function clearStaleRoleTurnLeases(opts: { all?: boolean } = {}): Promise<number> {
  const { storageMode } = await import('@/db/postgres');
  const all = opts.all ?? (storageMode() === 'embedded' || process.env.OCTIPUS_SINGLE_PROCESS === '1');
  const instance = leaseInstanceId();
  if (!all && !instance) {
    leaseClaimsOpen = true;
    return 0;
  }
  const filter = all
    ? sql`${inFlightToken} IS NOT NULL OR ${inFlightUntil} IS NOT NULL`
    : and(
      sql`split_part(${inFlightToken}, '|', 1) = ${instance}`,
      sql`split_part(${inFlightToken}, '|', 2) <> ${LEASE_BOOT_ID}`,
    );
  const rows = await getDb()
    .update(hooks)
    .set({ triggerConfig: dropLease })
    .where(and(eq(hooks.trigger, 'heartbeat'), filter))
    .returning({ id: hooks.id });
  leaseClaimsOpen = true;
  if (rows.length > 0) coreLogger.info({ hookIds: rows.map((r) => r.id), all }, 'Cleared stale role heartbeat leases from a previous run');
  return rows.length;
}

/** Shutdown, first step: from now on `claimRoleTurnLease` claims nothing (a tick in progress fires nothing new). */
export function stopRoleTurnLeaseClaims(): void {
  leaseClaimsOpen = false;
}

/**
 * Graceful shutdown: claim no new lease, stop renewing, and release every
 * lease this process holds so the hooks are free for the other processes
 * (or the next boot) at once. The turns themselves are stopped with the
 * agents. Returns the number released.
 */
export async function releaseHeldRoleTurnLeases(): Promise<number> {
  stopRoleTurnLeaseClaims();
  let released = 0;
  for (const [hookId, held] of [...heldLeases]) {
    held.stop();
    heldLeases.delete(hookId);
    try {
      if (await releaseRoleTurnLease(hookId, held.token)) released++;
    } catch (err) {
      coreLogger.warn({ err, hookId }, 'Role heartbeat lease release at shutdown failed (it lapses on its own)');
    }
  }
  return released;
}

/**
 * Contexts the heartbeat gate let through. A WeakSet, not a field on the
 * context or the event: both reach executeAction from user input too (the
 * hooks test route passes body.context and body.data through), so a flag
 * there could be forged; membership here cannot.
 */
const gatePassedContexts = new WeakSet<object>();

export function markHeartbeatGatePassed(context: object): void {
  gatePassedContexts.add(context);
}

export function heartbeatGatePassed(context: object): boolean {
  return gatePassedContexts.has(context);
}

/** trigger_config keys only the server writes (the heartbeat's own state). */
export const SERVER_HEARTBEAT_KEYS = SERVER_TRIGGER_CONFIG_KEYS;

/**
 * A user-supplied triggerConfig (POST / PATCH /api/hooks, a suggestion) with
 * the server-held heartbeat state dropped and, with `existing`, the stored
 * state carried over. Otherwise a user could reset their daily-run counter or
 * the surfaced-items set, or forge or drop a role turn's lease, by writing
 * the hook. The hooks routes pass no `existing`: HookManager.updateHook keeps
 * the stored server keys in the same UPDATE, so a stale read cannot write
 * them back.
 */
export function sanitizeTriggerConfig(input: unknown, existing?: Hook['triggerConfig'] | null): Hook['triggerConfig'] {
  const clean: Record<string, unknown> = input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (const key of SERVER_HEARTBEAT_KEYS) {
    delete clean[key];
    const kept = (existing as Record<string, unknown> | null | undefined)?.[key];
    if (kept !== undefined) clean[key] = kept;
  }
  return clean as Hook['triggerConfig'];
}

/**
 * Why a heartbeat hook with this triggerConfig may not be written for
 * `userId`, or null. A role must be a known role, and a user has at most one
 * heartbeat hook per role (`selfId` is the hook being edited). Check then
 * write, so two concurrent creates can still both land; the API is the only
 * writer and that race needs the same user twice at once.
 */
export async function roleHeartbeatHookError(
  userId: string,
  trigger: string,
  triggerConfig: unknown,
  selfId?: string,
): Promise<string | null> {
  if (trigger !== 'heartbeat') return null;
  const role = (triggerConfig as Record<string, unknown> | null | undefined)?.role;
  if (role === undefined || role === null) return null;
  if (typeof role !== 'string' || !ROLE_NAME.test(role)) return `Invalid role "${String(role)}"`;
  const { ROLE_CONFIGS } = await import('@/core/agent/roles');
  if (!Object.hasOwn(ROLE_CONFIGS, role)) return `Unknown role "${role}"`;
  const filters = [eq(hooks.trigger, 'heartbeat'), eq(hooks.userId, userId), sql`${hookRole} = ${role}`];
  if (selfId) filters.push(ne(hooks.id, selfId));
  const [clash] = await getDb().select({ id: hooks.id }).from(hooks).where(and(...filters)).limit(1);
  return clash ? `A heartbeat hook for the ${role} role already exists` : null;
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

export type HeartbeatSkipReason =
  | 'disabled' | 'quiet_hours' | 'daily_cap' | 'quota' | 'spend_budget' | 'nothing_pending'
  | 'in_flight' | 'tasks_permission_required';
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
  /**
   * Role hooks that found work: whether the owner still has to grant board
   * writes (true) or has (false). Undefined when the gate did not get that far.
   */
  boardPermissionMissing?: boolean;
  /** Role hooks run with `claimLease`: the lease this run holds (set only when it runs). */
  leaseToken?: string;
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
  opts: {
    /**
     * Runs today across ALL of the user's heartbeat hooks (the cap is per
     * user). maybeRunHeartbeats passes it; alone, the hook's own count.
     */
    userRunsToday?: number;
    /**
     * Role hooks: claim the in-flight lease (maybeRunHeartbeats does, and
     * then owns `leaseToken`). Without it the gate only checks for a live
     * lease, and never writes one.
     */
    claimLease?: boolean;
  } = {},
): Promise<GateEvaluation> {
  const dayKey = localDayKey(now, config.quietHoursTimezone);
  const runsToday = readRunCounter(hook, dayKey);
  const userRunsToday = opts.userRunsToday ?? runsToday;
  const role = heartbeatRole(hook);
  const previouslySeen = readSeen(hook);
  const skip = (reason: HeartbeatSkipReason, seen: HeartbeatSeen = previouslySeen): GateEvaluation =>
    ({ decision: { run: false, reason }, runsToday, dayKey, seen });

  if (!config.enabled) return skip('disabled');
  if (isWithinQuietHours(config, now)) return skip('quiet_hours');
  if (userRunsToday >= config.maxRunsPerDay) return skip('daily_cap');
  if (role && roleTurnInFlight(hook.id)) return skip('in_flight');

  // Already out of daily token budget → don't even probe.
  try {
    const { getQuotaManager } = await import('@/security/quotas');
    const q = await getQuotaManager().willExceed(hook.userId, 'tokensPerDay', 0);
    if (!q.allowed) return skip('quota');
  } catch (err) {
    coreLogger.debug({ err }, 'heartbeat: quota check unavailable (not blocking)');
  }

  // A paused dollar spend budget skips the tick (the check stamps the pause
  // and notifies once); any other failure of the check is not blocking.
  // Only the user scope is checked: the tick runs an orchestrated turn whose
  // role and workspace are resolved downstream, not here. Role and workspace
  // budgets are enforced when that turn spawns its agents (agent-manager).
  try {
    const { checkSpend } = await import('@/security/spend-budgets');
    await checkSpend({ userId: hook.userId }, now);
  } catch (err) {
    if (err instanceof Error && err.name === 'SpendBudgetExceededError') return skip('spend_budget');
    coreLogger.debug({ err }, 'heartbeat: spend budget check unavailable (not blocking)');
  }

  // A role hook's pending work is the role's ready tasks, nothing else: the
  // user's own heartbeat covers PRs, meetings and notifications.
  // One turn per hook across processes: the lease is taken BEFORE the probe,
  // so two processes cannot both probe and fire, and given back on any skip.
  if (role) {
    let leaseToken: string | undefined;
    if (opts.claimLease) {
      const token = await claimRoleTurnLease(hook.id);
      if (!token) return skip('in_flight');
      leaseToken = token;
    } else if (await roleTurnLeaseHeld(hook.id)) {
      return skip('in_flight');
    }
    const giveBack = async () => {
      if (leaseToken) await releaseRoleTurnLease(hook.id, leaseToken).catch(() => false);
    };
    try {
      const ready = await probeRoleWork(hook.userId, role);
      if (ready.length === 0) {
        await giveBack();
        return skip('nothing_pending');
      }
      const allowed = await (deps.boardWritesAllowed ?? defaultBoardWritesAllowed)(hook);
      if (!allowed) {
        await giveBack();
        return { ...skip('tasks_permission_required'), boardPermissionMissing: true };
      }
      return { decision: { run: true, message: renderRoleHeartbeatMessage(role, ready) }, runsToday, dayKey, seen: previouslySeen, boardPermissionMissing: false, leaseToken };
    } catch (err) {
      await giveBack();
      throw err;
    }
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
  const { ROLE_CONFIGS } = await import('@/core/agent/roles');
  if (!Object.hasOwn(ROLE_CONFIGS, role)) throw new Error(`Unknown role "${role}"`);
  const db = getDb();
  // POST /api/hooks checks then writes, so a race can leave two rows for one
  // role. Keep exactly one of them running: an already enabled row wins (the
  // oldest, if several are), else the oldest is re-enabled; the others are
  // left as they are, and a disabled duplicate stays disabled.
  const existing = await db
    .select()
    .from(hooks)
    .where(and(eq(hooks.trigger, 'heartbeat'), eq(hooks.userId, userId), sql`${hookRole} = ${role}`))
    .orderBy(desc(hooks.isEnabled), asc(hooks.createdAt), asc(hooks.id));

  if (existing.length > 0) {
    const keep = existing[0];
    if (!keep.isEnabled) {
      await db.update(hooks).set({ isEnabled: true, nextRunAt: now, updatedAt: now }).where(eq(hooks.id, keep.id));
      await reloadHookCache();
    }
    return keep.id;
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

/** Disable every heartbeat hook `userId` has for `role` (duplicates included). Idempotent. */
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
  // A task in a shared workspace (a space) never wakes a role heartbeat:
  // role agents are personal automation (docs/plans/coworking-spec.md §5.5).
  const assignedRole = sql`(SELECT t.assignee_ref FROM tasks t WHERE t.id = ${taskId}::uuid AND t.user_id = ${userId}::uuid AND t.assignee_kind = 'role'
    AND (t.workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM workspaces sw WHERE sw.id = t.workspace_id AND sw.kind = 'shared')))`;
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

/**
 * The wakeup listener. A throw is logged by the wakeup bus and reaches
 * nothing else. A remote event (relayed from another server process) is
 * skipped: the process that closed the task already marked the hook, and
 * marking it again late could re-open a slot a tick has just claimed.
 */
async function onRoleTaskWakeup(event: TaskWakeupEvent): Promise<void> {
  if (event.remote) return;
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
 * Process all enabled heartbeat hooks: claim each due hook's slot by moving
 * its `nextRunAt` on by the interval, run the gate, and fire a turn only when
 * the gate says so. Called once per cron tick (before the schedule query's
 * early return). No-op when the heartbeat feature is disabled.
 *
 * Hooks are grouped by user and a user's hooks run one after another, so the
 * daily cap (per user, across the plain and every role heartbeat) is counted
 * as it goes; users run with bounded concurrency.
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
    .where(and(
      eq(hooks.trigger, 'heartbeat'),
      eq(hooks.isEnabled, true),
      // A deactivated owner gets no probe and no turn.
      inArray(hooks.userId, db.select({ id: users.id }).from(users).where(eq(users.isActive, true))),
    ));

  const due = candidates.filter((h) => isDue(h, now));
  if (due.length === 0) return;

  const dayKey = localDayKey(now, config.quietHoursTimezone);
  const userRuns = new Map<string, number>();
  for (const h of candidates) userRuns.set(h.userId, (userRuns.get(h.userId) ?? 0) + readRunCounter(h, dayKey));
  const byUser = new Map<string, Hook[]>();
  for (const h of due) byUser.set(h.userId, [...(byUser.get(h.userId) ?? []), h]);

  const { getHookManager } = await import('@/hooks/manager');
  const hookManager = getHookManager();
  const nextRunAt = new Date(now.getTime() + config.intervalMinutes * 60_000);
  const tickDeps: HeartbeatProbeDeps = { ...deps, github: { runGh: memoizeGhPerTick(deps.github.runGh) } };

  const processHook = async (hook: Hook): Promise<void> => {
    // Claim the slot BEFORE the gate reads anything: move nextRunAt on only
    // if it is still what this tick read. A wakeup that lands while the gate
    // runs then finds the hook not due and moves nextRunAt back to now, which
    // survives, because nothing below writes nextRunAt again. (Writing it
    // after the gate, as before, erased such a wakeup.) A miss means another
    // writer moved it since the read: leave the hook to the next tick.
    const snapshot = hook.nextRunAt;
    const [claimed] = await db
      .update(hooks)
      .set({ nextRunAt, updatedAt: now })
      .where(and(
        eq(hooks.id, hook.id),
        snapshot == null ? isNull(hooks.nextRunAt) : sql`date_trunc('milliseconds', ${hooks.nextRunAt}) = ${snapshot.toISOString()}::timestamptz`,
      ))
      .returning({ id: hooks.id });
    if (!claimed) {
      coreLogger.debug({ hookId: hook.id }, 'Heartbeat slot moved since this tick read it; leaving it to the next tick');
      return;
    }

    // A role hook's gate claims its lease (before probing) and hands it over
    // when it says run; on a skip it has already given it back.
    const gate = await evaluateHeartbeatGate(hook, config, now, tickDeps, { userRunsToday: userRuns.get(hook.userId) ?? 0, claimLease: true });
    const role = heartbeatRole(hook);
    const leaseToken = gate.leaseToken ?? null;

    // The gate's own state, merged into the stored config (never replacing
    // it, so a concurrent edit of the hook survives), BEFORE firing, so a long
    // turn can't cause a duplicate fire on the next tick.
    const runsToday = gate.decision.run ? gate.runsToday + 1 : gate.runsToday;
    if (gate.decision.run) userRuns.set(hook.userId, (userRuns.get(hook.userId) ?? 0) + 1);
    const state: Record<string, unknown> = { heartbeatDayKey: gate.dayKey, heartbeatRunsToday: runsToday, heartbeatSeen: gate.seen };
    const notifyPermission = gate.boardPermissionMissing === true && hook.triggerConfig?.heartbeatPermissionNotified !== true;
    if (gate.boardPermissionMissing !== undefined) state.heartbeatPermissionNotified = gate.boardPermissionMissing;
    try {
      await db
        .update(hooks)
        .set({ triggerConfig: sql`${hooks.triggerConfig} || ${JSON.stringify(state)}::jsonb`, updatedAt: now })
        .where(eq(hooks.id, hook.id));
    } catch (err) {
      // Not firing after all: give the lease back rather than let it lapse.
      if (leaseToken) await releaseRoleTurnLease(hook.id, leaseToken).catch(() => false);
      throw err;
    }

    if (notifyPermission) await notifyBoardPermissionRequired(hook, role ?? '');

    if (!gate.decision.run) {
      coreLogger.debug({ hookId: hook.id, userId: hook.userId, reason: gate.decision.reason }, 'Heartbeat skipped');
      return;
    }
    // Shutdown began while this tick was in the gate: fire nothing, and give
    // the lease back (shutdown only releases the leases of started turns).
    if (leaseToken && !leaseClaimsOpen) {
      await releaseRoleTurnLease(hook.id, leaseToken).catch(() => false);
      return;
    }

    // Carry the rendered heartbeat message so executeSpawnAgent uses it
    // verbatim. channelType is a placeholder — the root agent channel is set
    // to 'heartbeat' by executeSpawnAgent from hook.trigger. The context is
    // marked as having passed this gate: a role turn runs only then.
    const context = {
      message: {
        id: `heartbeat-${hook.id}-${now.getTime()}`,
        channelType: 'api' as const,
        channelId: hook.userId,
        userId: hook.userId,
        content: gate.decision.message,
        timestamp: now,
      },
    };
    markHeartbeatGatePassed(context);
    const settle = leaseToken ? holdRoleTurnLease(hook.id, leaseToken) : null;

    // Fire-and-forget: the turn can take minutes. A role turn stays in flight
    // (its lease held and renewed) until it ends, so the next tick in any
    // process skips its hook with 'in_flight'.
    hookManager
      .triggerHook(hook.id, { type: 'heartbeat', data: { hookId: hook.id }, timestamp: now }, context)
      .catch((err) => coreLogger.error({ err, hookId: hook.id }, 'Heartbeat run failed'))
      .finally(() => settle?.());

    coreLogger.info({ hookId: hook.id, userId: hook.userId, role }, 'Heartbeat triggered');
  };

  // Bounded concurrency over users: a gate now waits on `gh` and a calendar,
  // so a serial walk over many due users would hold the cron tick for minutes.
  await forEachLimited([...byUser.values()], HEARTBEAT_GATE_CONCURRENCY, async (userHooks) => {
    for (const hook of userHooks) {
      try {
        await processHook(hook);
      } catch (err) {
        coreLogger.error({ err, hookId: hook.id }, 'Heartbeat processing failed');
      }
    }
  });
}

/**
 * Mark `hookId`'s role turn in flight here and keep its lease alive while it
 * runs. Returns the settle function: stop renewing, clear the lease if it is
 * still ours, then drop the local mark. Never throws.
 */
function holdRoleTurnLease(hookId: string, token: string): () => Promise<void> {
  roleTurnsInFlight.add(hookId);
  const ttl = roleTurnLeaseMs();
  let released = false;
  const renew = setInterval(() => {
    renewRoleTurnLease(hookId, token, ttl)
      .then((held) => {
        // A renewal that lands after the release is expected, not a loss.
        if (!held && !released) coreLogger.warn({ hookId }, 'Role heartbeat lease lost while the turn runs');
      })
      .catch((err) => { if (!released) coreLogger.warn({ err, hookId }, 'Role heartbeat lease renewal failed'); });
  }, leaseRenewIntervalMs(ttl));
  renew.unref?.();
  const stop = () => {
    released = true;
    clearInterval(renew);
  };
  heldLeases.set(hookId, { token, stop });
  return async () => {
    stop();
    try {
      // Skip when a shutdown already released it (the map entry is gone).
      if (heldLeases.get(hookId)?.token === token) {
        heldLeases.delete(hookId);
        await releaseRoleTurnLease(hookId, token);
      }
    } catch (err) {
      coreLogger.warn({ err, hookId }, 'Role heartbeat lease release failed (it lapses on its own)');
    } finally {
      roleTurnsInFlight.delete(hookId);
    }
  };
}

/** Tell the owner, once, that their role heartbeat is waiting on a grant. */
async function notifyBoardPermissionRequired(hook: Hook, role: string): Promise<void> {
  try {
    const { getNotificationService } = await import('@/core/notification-service');
    await getNotificationService().notify(
      hook.userId,
      'heartbeat_permission_required',
      `The ${role} agent has tasks ready but cannot work them`,
      `Its heartbeat found tasks assigned to the ${role} role, but writing to the task board (tasks → write) needs your approval, and a heartbeat runs with nobody there to approve it. Allow tasks → write in the permission settings to let it check out, comment on and complete tasks; until then it stays idle.`,
      { hookId: hook.id, role },
    );
  } catch (err) {
    coreLogger.warn({ err, hookId: hook.id }, 'heartbeat: could not send the permission notice');
  }
}
