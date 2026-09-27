/**
 * Heartbeat gate — integration tests over embedded PGlite (no Docker).
 *
 * Exercises `evaluateHeartbeatGate` end-to-end against real `hooks`/`tasks`/
 * `notifications` rows: every skip reason plus the run path, including the
 * deterministic probe that decides whether any LLM turn happens at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { TASK_CHECKOUT_TTL_MS } from '@/core/tasks/checkout';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HeartbeatConfig } from '@/config/schema';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '11111111-1111-1111-1111-111111111111';

const cfg = (over: Partial<HeartbeatConfig> = {}): HeartbeatConfig => ({
  enabled: true,
  intervalMinutes: 60,
  quietHoursStart: 22,
  quietHoursEnd: 7,
  quietHoursTimezone: 'UTC',
  maxRunsPerDay: 24,
  probeGithub: true,
  probeCalendar: true,
  calendarLookaheadMinutes: 60,
  ...over,
});

/** External probes stubbed empty unless a test says otherwise. */
const quiet = (): import('./heartbeat').HeartbeatProbeDeps => ({
  github: { runGh: async () => JSON.stringify({ data: { search: { nodes: [] } } }) },
  calendar: { getToken: async () => null, fetchJson: async () => ({}) },
  githubAllowed: async () => true,
});

const redPr = (state = 'FAILURE') => JSON.stringify({ data: { search: { nodes: [{
  number: 42, title: 'Ship it', url: 'https://github.com/o/r/pull/42', repository: { nameWithOwner: 'o/r' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] },
}] } } });

// Midday UTC so the default quiet-hours window (22→7) is inactive.
const NOON = new Date('2026-07-12T12:00:00Z');

let db: typeof import('@/db/postgres').getDb extends () => infer R ? R : never;
let heartbeat: typeof import('./heartbeat');
let hooksSchema: typeof import('@/db/schema/hooks').hooks;
let tasksSchema: typeof import('@/db/schema/tasks').tasks;
let notifsSchema: typeof import('@/db/schema/notifications').notifications;

async function makeHeartbeatHook(over: Record<string, unknown> = {}): Promise<import('@/db/schema/hooks').Hook> {
  const [row] = await db
    .insert(hooksSchema)
    .values({
      userId,
      name: 'heartbeat',
      trigger: 'heartbeat',
      triggerConfig: {},
      action: 'spawn_agent',
      actionConfig: { orchestrated: true, agentPrompt: '' },
      isEnabled: true,
      ...over,
    })
    .returning();
  return row;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-heartbeat-'));

  const { initializeDb, getDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  db = getDb();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'alice' }]);

  heartbeat = await import('./heartbeat');
  hooksSchema = (await import('@/db/schema/hooks')).hooks;
  tasksSchema = (await import('@/db/schema/tasks')).tasks;
  notifsSchema = (await import('@/db/schema/notifications')).notifications;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  // Clean slate per test.
  await db.delete(hooksSchema);
  await db.delete(tasksSchema);
  await db.delete(notifsSchema);
});

describe('evaluateHeartbeatGate', () => {
  test('disabled config → skip(disabled), no probe', async () => {
    const hook = await makeHeartbeatHook();
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg({ enabled: false }), NOON, quiet());
    expect(r.decision).toEqual({ run: false, reason: 'disabled' });
  });

  test('quiet hours → skip(quiet_hours)', async () => {
    const hook = await makeHeartbeatHook();
    // 23:30 UTC is inside 22→7.
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), new Date('2026-07-12T23:30:00Z'), quiet());
    expect(r.decision).toEqual({ run: false, reason: 'quiet_hours' });
  });

  test('daily cap reached → skip(daily_cap)', async () => {
    const dayKey = heartbeat.localDayKey(NOON, 'UTC');
    const hook = await makeHeartbeatHook({ triggerConfig: { heartbeatDayKey: dayKey, heartbeatRunsToday: 24 } });
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg({ maxRunsPerDay: 24 }), NOON, quiet());
    expect(r.decision).toEqual({ run: false, reason: 'daily_cap' });
    expect(r.runsToday).toBe(24);
  });

  test('counter from a previous day is ignored (resets)', async () => {
    const hook = await makeHeartbeatHook({ triggerConfig: { heartbeatDayKey: '2020-01-01', heartbeatRunsToday: 99 } });
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, quiet());
    // Stale day → counter treated as 0, so cap doesn't trip (nothing pending though).
    expect(r.runsToday).toBe(0);
    expect(r.decision).toEqual({ run: false, reason: 'nothing_pending' });
  });

  test('nothing pending → skip(nothing_pending)', async () => {
    const hook = await makeHeartbeatHook();
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, quiet());
    expect(r.decision).toEqual({ run: false, reason: 'nothing_pending' });
  });

  test('a future-due task is NOT pending', async () => {
    const hook = await makeHeartbeatHook();
    await db.insert(tasksSchema).values({
      userId, title: 'Later', status: 'open', dueAt: new Date('2026-07-20T00:00:00Z'),
    });
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, quiet());
    expect(r.decision).toEqual({ run: false, reason: 'nothing_pending' });
  });

  test('a due open task → run with a checklist message', async () => {
    const hook = await makeHeartbeatHook();
    await db.insert(tasksSchema).values({
      userId, title: 'Reply to the release email', status: 'open', dueAt: new Date('2026-07-12T09:00:00Z'),
    });
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, quiet());
    expect(r.decision.run).toBe(true);
    if (r.decision.run) {
      expect(r.decision.message).toContain('Heartbeat check-in');
      expect(r.decision.message).toContain('Reply to the release email');
      expect(r.decision.message).toContain('END THE TURN SILENTLY');
    }
  });

  test('an unread notification → run', async () => {
    const hook = await makeHeartbeatHook();
    await db.insert(notifsSchema).values({ userId, type: 'github', title: 'CI failed', read: false });
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, quiet());
    expect(r.decision.run).toBe(true);
    if (r.decision.run) expect(r.decision.message).toContain('CI failed');
  });

  test('a done task and a read notification are ignored', async () => {
    const hook = await makeHeartbeatHook();
    await db.insert(tasksSchema).values({
      userId, title: 'done thing', status: 'done', dueAt: new Date('2026-07-12T09:00:00Z'),
    });
    await db.insert(notifsSchema).values({ userId, type: 'x', title: 'seen', read: true });
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, quiet());
    expect(r.decision).toEqual({ run: false, reason: 'nothing_pending' });
  });
});

describe('external probe sources', () => {
  test('a pull request with failing checks → run, listed first-class in the checklist', async () => {
    const hook = await makeHeartbeatHook();
    const deps = quiet();
    deps.github.runGh = async () => redPr();
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, deps);
    expect(r.decision.run).toBe(true);
    if (r.decision.run) expect(r.decision.message).toContain('- o/r#42 Ship it — https://github.com/o/r/pull/42');
    expect(r.seen.prs).toEqual(['https://github.com/o/r/pull/42@FAILURE']);
  });

  test('an item already surfaced does not wake the heartbeat again; a cleared-then-red PR does', async () => {
    const deps = quiet();
    deps.github.runGh = async () => redPr();
    // Tick 2: the hook carries what tick 1 saw → nothing new.
    const seenHook = await makeHeartbeatHook({ triggerConfig: { heartbeatSeen: { prs: ['https://github.com/o/r/pull/42@FAILURE'], events: [] } } });
    const again = await heartbeat.evaluateHeartbeatGate(seenHook, cfg(), NOON, deps);
    expect(again.decision).toEqual({ run: false, reason: 'nothing_pending' });
    expect(again.seen.prs).toEqual(['https://github.com/o/r/pull/42@FAILURE']);

    // Tick 3: the PR went green → the seen set is pruned.
    deps.github.runGh = async () => JSON.stringify({ data: { search: { nodes: [] } } });
    const green = await heartbeat.evaluateHeartbeatGate(seenHook, cfg(), NOON, deps);
    expect(green.seen.prs).toEqual([]);

    // Tick 4: red again, with the pruned set persisted → new again.
    deps.github.runGh = async () => redPr();
    const prunedHook = await makeHeartbeatHook({ triggerConfig: { heartbeatSeen: green.seen } });
    const back = await heartbeat.evaluateHeartbeatGate(prunedHook, cfg(), NOON, deps);
    expect(back.decision.run).toBe(true);
  });

  test('the github probe is not consulted for a user who may not read the server\'s gh', async () => {
    const hook = await makeHeartbeatHook();
    const deps = quiet();
    deps.githubAllowed = async () => false;
    deps.github.runGh = async () => { throw new Error('must not be called'); };
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, deps);
    expect(r.decision).toEqual({ run: false, reason: 'nothing_pending' });
  });

  test('a calendar event starting within the hour → run', async () => {
    const hook = await makeHeartbeatHook();
    const deps = quiet();
    deps.calendar = {
      getToken: async (_u, p) => (p === 'google' ? 'tok' : null),
      fetchJson: async () => ({ items: [{ summary: 'Client call', start: { dateTime: '2026-07-12T12:30:00Z' }, end: { dateTime: '2026-07-12T13:00:00Z' } }] }),
    };
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, deps);
    expect(r.decision.run).toBe(true);
    if (r.decision.run) expect(r.decision.message).toContain('- 12:30 Client call (until 13:00)');
    expect(r.seen.events).toEqual(['google|2026-07-12T12:30:00.000Z|Client call']);

    // The same meeting next tick is old news.
    const seenHook = await makeHeartbeatHook({ triggerConfig: { heartbeatSeen: r.seen } });
    const again = await heartbeat.evaluateHeartbeatGate(seenHook, cfg(), NOON, deps);
    expect(again.decision).toEqual({ run: false, reason: 'nothing_pending' });
  });

  test('switched off in config → the runners are never consulted', async () => {
    const hook = await makeHeartbeatHook();
    const deps: import('./heartbeat').HeartbeatProbeDeps = {
      github: { runGh: async () => { throw new Error('must not be called'); } },
      calendar: { getToken: async () => { throw new Error('must not be called'); }, fetchJson: async () => ({}) },
      githubAllowed: async () => true,
    };
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg({ probeGithub: false, probeCalendar: false }), NOON, deps);
    expect(r.decision).toEqual({ run: false, reason: 'nothing_pending' });
  });

  test('a broken gh or calendar never fails the gate, and keeps what was already seen', async () => {
    const seen = { prs: ['https://github.com/o/r/pull/42@FAILURE'], events: ['google|2026-07-12T12:30:00.000Z|Client call'] };
    const hook = await makeHeartbeatHook({ triggerConfig: { heartbeatSeen: seen } });
    const deps: import('./heartbeat').HeartbeatProbeDeps = {
      github: { runGh: async () => { throw new Error('spawn gh ENOENT'); } },
      calendar: { getToken: async () => 'tok', fetchJson: async () => { throw new Error('503'); } },
      githubAllowed: async () => true,
    };
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, deps);
    expect(r.decision).toEqual({ run: false, reason: 'nothing_pending' });
    // "Could not read" is not "cleared": nothing is pruned, so the next good
    // tick does not re-nudge about the same PR and meeting.
    expect(r.seen).toEqual(seen);
  });
});

describe('maybeRunHeartbeats', () => {
  test('persists the seen set on a silent tick and asks gh once for every due hook', async () => {
    // Two admins' hooks already know about the PR → silent, but the seen set lands.
    const seen = { prs: ['https://github.com/o/r/pull/42@FAILURE'], events: [] };
    const h1 = await makeHeartbeatHook({ nextRunAt: null, triggerConfig: { heartbeatSeen: seen } });
    const h2 = await makeHeartbeatHook({ nextRunAt: null, triggerConfig: { heartbeatSeen: seen } });
    let ghCalls = 0;
    const deps = quiet();
    deps.github.runGh = async () => { ghCalls += 1; return redPr(); };
    await heartbeat.maybeRunHeartbeats(NOON, deps, cfg());
    expect(ghCalls).toBe(1);
    for (const id of [h1.id, h2.id]) {
      const [row] = await db.select().from(hooksSchema).where(eq(hooksSchema.id, id));
      expect(row.triggerConfig.heartbeatSeen).toEqual(seen);
      expect(row.nextRunAt).not.toBeNull();
    }
  });
});

describe('ensureHeartbeatHook / disableHeartbeatHook', () => {
  test('creates exactly one hook and is idempotent', async () => {
    const id1 = await heartbeat.ensureHeartbeatHook(userId, NOON);
    const id2 = await heartbeat.ensureHeartbeatHook(userId, NOON);
    expect(id1).toBe(id2);
    const rows = await db.select().from(hooksSchema).where(eq(hooksSchema.userId, userId));
    expect(rows.length).toBe(1);
    expect(rows[0].trigger).toBe('heartbeat');
    expect(rows[0].isEnabled).toBe(true);
  });

  test('disable then re-ensure toggles isEnabled without duplicating', async () => {
    const id = await heartbeat.ensureHeartbeatHook(userId, NOON);
    await heartbeat.disableHeartbeatHook(userId, NOON);
    let [row] = await db.select().from(hooksSchema).where(eq(hooksSchema.id, id));
    expect(row.isEnabled).toBe(false);

    const id2 = await heartbeat.ensureHeartbeatHook(userId, NOON);
    expect(id2).toBe(id);
    [row] = await db.select().from(hooksSchema).where(eq(hooksSchema.id, id));
    expect(row.isEnabled).toBe(true);
  });
});

describe('role heartbeats', () => {
  const otherUser = '22222222-2222-2222-2222-222222222222';
  type NewTask = import('@/db/schema/tasks').NewTask;

  async function task(over: Partial<NewTask> = {}): Promise<import('@/db/schema/tasks').Task> {
    const [row] = await db.insert(tasksSchema).values({ userId, title: 'task', status: 'open', ...over }).returning();
    return row;
  }
  const forCoding = (over: Partial<NewTask> = {}) => task({ assigneeKind: 'role', assigneeRef: 'coding', ...over });
  const roleHook = (role = 'coding', over: Record<string, unknown> = {}) =>
    makeHeartbeatHook({ triggerConfig: { role }, actionConfig: { orchestrated: false, agentPrompt: '' }, ...over });

  beforeAll(async () => {
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: otherUser, username: 'bob' }]);
  });

  test('the probe returns only ready, unleased tasks assigned to the role', async () => {
    const ready = await forCoding({ title: 'Ready' });
    const openBlocker = await task({ title: 'Blocker (open)' });
    const doneBlocker = await task({ title: 'Blocker (done)', status: 'done' });
    await forCoding({ title: 'Blocked', blockedBy: [openBlocker.id] });
    const freed = await forCoding({ title: 'Blocker done', blockedBy: [doneBlocker.id] });
    const parent = await forCoding({ title: 'Parent with an open child' });
    await task({ title: 'Child', parentId: parent.id });
    await forCoding({ title: 'Leased', status: 'in_progress', checkedOutBy: 'coding@s1', checkedOutAt: new Date(NOON.getTime() - 60_000) });
    const lapsed = await forCoding({
      title: 'Lease lapsed', status: 'in_progress', checkedOutBy: 'coding@s0', checkedOutAt: new Date(NOON.getTime() - TASK_CHECKOUT_TTL_MS - 60_000),
    });
    await forCoding({ title: 'Done', status: 'done' });
    await task({ title: 'Other role', assigneeKind: 'role', assigneeRef: 'review' });
    await task({ title: 'A user', assigneeKind: 'user', assigneeRef: userId });
    await task({ title: 'Unassigned' });
    await task({ userId: otherUser, title: 'Another user\'s', assigneeKind: 'role', assigneeRef: 'coding' });

    const found = await heartbeat.probeRoleWork(userId, 'coding', NOON);
    expect(found.map((t) => t.title).sort()).toEqual(['Blocker done', 'Lease lapsed', 'Ready']);
    expect(found.map((t) => t.id).sort()).toEqual([ready.id, freed.id, lapsed.id].sort());
  });

  test('a leased task is excluded until its lease expires', async () => {
    const checkedOutAt = new Date(NOON.getTime() - 10 * 60_000);
    const held = await forCoding({ title: 'Held', status: 'in_progress', checkedOutBy: 'coding@s1', checkedOutAt });
    expect(await heartbeat.probeRoleWork(userId, 'coding', NOON)).toEqual([]);
    const justBefore = new Date(checkedOutAt.getTime() + TASK_CHECKOUT_TTL_MS - 1000);
    expect(await heartbeat.probeRoleWork(userId, 'coding', justBefore)).toEqual([]);
    const after = new Date(checkedOutAt.getTime() + TASK_CHECKOUT_TTL_MS + 1000);
    expect(await heartbeat.probeRoleWork(userId, 'coding', after)).toEqual([{ id: held.id, title: 'Held' }]);
  });

  test('the gate skips a role hook with nothing ready (no turn) and runs it with the ready list', async () => {
    const hook = await roleHook();
    // What wakes the plain heartbeat does not wake a role hook.
    await db.insert(notifsSchema).values({ userId, type: 'github', title: 'CI failed', read: false });
    await task({ title: 'Due for the user', dueAt: new Date('2026-07-12T09:00:00Z') });
    await task({ title: 'For review', assigneeKind: 'role', assigneeRef: 'review' });
    const deps = quiet();
    deps.github.runGh = async () => { throw new Error('a role probe must not call gh'); };
    const idle = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, deps);
    expect(idle.decision).toEqual({ run: false, reason: 'nothing_pending' });

    const t = await forCoding({ title: 'Implement the parser' });
    const busy = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON, deps);
    expect(busy.decision.run).toBe(true);
    if (busy.decision.run) {
      expect(busy.decision.message).toContain(`- ${t.id} — Implement the parser`);
      expect(busy.decision.message).toContain('`checkout_task`');
      expect(busy.decision.message).not.toContain('For review');
      expect(busy.decision.message).not.toContain('CI failed');
    }
  });

  test('quiet hours and the daily cap still skip a role hook with ready work', async () => {
    await forCoding({ title: 'Ready' });
    const hook = await roleHook();
    const night = await heartbeat.evaluateHeartbeatGate(hook, cfg(), new Date('2026-07-12T23:30:00Z'), quiet());
    expect(night.decision).toEqual({ run: false, reason: 'quiet_hours' });
    const capped = await roleHook('coding', { triggerConfig: { role: 'coding', heartbeatDayKey: '2026-07-12', heartbeatRunsToday: 24 } });
    const cap = await heartbeat.evaluateHeartbeatGate(capped, cfg(), NOON, quiet());
    expect(cap.decision).toEqual({ run: false, reason: 'daily_cap' });
  });

  test('a wakeup for a role-assigned task marks that role\'s hook due, and nothing else', async () => {
    const later = new Date(NOON.getTime() + 60 * 60_000);
    const coding = await roleHook('coding', { nextRunAt: later });
    const review = await roleHook('review', { nextRunAt: later });
    const plain = await makeHeartbeatHook({ nextRunAt: later });
    const t = await forCoding({ title: 'Unblocked' });
    const unassigned = await task({ title: 'Nobody\'s' });

    expect(await heartbeat.markRoleHeartbeatDue(userId, unassigned.id, NOON)).toEqual([]);
    // The right task under another user's id: tenancy holds.
    expect(await heartbeat.markRoleHeartbeatDue(otherUser, t.id, NOON)).toEqual([]);
    expect(await heartbeat.markRoleHeartbeatDue(userId, t.id, NOON)).toEqual([coding.id]);
    // Already due: left alone.
    expect(await heartbeat.markRoleHeartbeatDue(userId, t.id, NOON)).toEqual([]);

    const rows = await db.select().from(hooksSchema);
    const next = new Map(rows.map((r) => [r.id, r.nextRunAt?.getTime()]));
    expect(next.get(coding.id)).toBe(NOON.getTime());
    expect(next.get(review.id)).toBe(later.getTime());
    expect(next.get(plain.id)).toBe(later.getTime());
  });

  test('a due-marked role hook still goes through the gate on the tick (quiet hours skip it)', async () => {
    await forCoding({ title: 'Ready' });
    const night = new Date('2026-07-12T23:30:00Z');
    const hook = await roleHook('coding', { nextRunAt: new Date(night.getTime() + 60 * 60_000) });
    const [t] = await db.select().from(tasksSchema);
    expect(await heartbeat.markRoleHeartbeatDue(userId, t.id, night)).toEqual([hook.id]);
    await heartbeat.maybeRunHeartbeats(night, quiet(), cfg());
    const [row] = await db.select().from(hooksSchema).where(eq(hooksSchema.id, hook.id));
    // Processed (nextRunAt advanced), but skipped: no run was counted.
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(night.getTime());
    expect(row.triggerConfig.heartbeatRunsToday).toBe(0);
    expect(row.triggerConfig.role).toBe('coding');
  });

  test('closing the last blocker wakes the role hook through the wakeup bus', async () => {
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const { flushWakeups } = await import('@/core/tasks/wakeups');
    const farFuture = new Date(Date.now() + 24 * 60 * 60_000);
    const hook = await roleHook('coding', { nextRunAt: farFuture });
    const blocker = await task({ title: 'Blocker' });
    await forCoding({ title: 'Waiting', blockedBy: [blocker.id] });

    heartbeat.startRoleHeartbeatWakeups();
    try {
      const repo = scopedRepos({ kind: 'user', userId, username: 'alice', isAdmin: false, sessionToken: null, roles: ['user'], workspaceId: null }).tasks;
      await repo.update(blocker.id, { status: 'done', completedAt: new Date() });
      await flushWakeups();
      await vi.waitFor(async () => {
        const [row] = await db.select().from(hooksSchema).where(eq(hooksSchema.id, hook.id));
        expect(row.nextRunAt!.getTime()).toBeLessThan(farFuture.getTime());
      });
    } finally {
      heartbeat.stopRoleHeartbeatWakeups();
    }
  });

  test('no role hooks: a wakeup changes nothing for the plain heartbeat', async () => {
    const later = new Date(NOON.getTime() + 60 * 60_000);
    const plain = await makeHeartbeatHook({ nextRunAt: later });
    const t = await forCoding({ title: 'Assigned, but no coding hook' });
    expect(await heartbeat.markRoleHeartbeatDue(userId, t.id, NOON)).toEqual([]);
    const [row] = await db.select().from(hooksSchema).where(eq(hooksSchema.id, plain.id));
    expect(row.nextRunAt!.getTime()).toBe(later.getTime());
  });

  test('ensureRoleHeartbeatHook is idempotent per role and separate from the plain heartbeat', async () => {
    const plainId = await heartbeat.ensureHeartbeatHook(userId, NOON);
    const coding1 = await heartbeat.ensureRoleHeartbeatHook(userId, 'coding', NOON);
    const coding2 = await heartbeat.ensureRoleHeartbeatHook(userId, 'coding', NOON);
    const qa = await heartbeat.ensureRoleHeartbeatHook(userId, 'qa', NOON);
    expect(coding1).toBe(coding2);
    expect(new Set([plainId, coding1, qa]).size).toBe(3);
    expect(await heartbeat.ensureHeartbeatHook(userId, NOON)).toBe(plainId);

    const [row] = await db.select().from(hooksSchema).where(eq(hooksSchema.id, coding1));
    expect(row.trigger).toBe('heartbeat');
    expect(row.triggerConfig.role).toBe('coding');
    expect(row.isEnabled).toBe(true);

    // Disabling the plain heartbeat leaves role heartbeats running.
    await heartbeat.disableHeartbeatHook(userId, NOON);
    await heartbeat.disableRoleHeartbeatHook(userId, 'qa', NOON);
    const enabled = (await db.select().from(hooksSchema).where(eq(hooksSchema.isEnabled, true))).map((r) => r.id);
    expect(enabled).toEqual([coding1]);

    await expect(heartbeat.ensureRoleHeartbeatHook(userId, 'Not A Role', NOON)).rejects.toThrow(/Invalid role/);
  });
});
