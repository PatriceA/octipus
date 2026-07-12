/**
 * Heartbeat gate — integration tests over embedded PGlite (no Docker).
 *
 * Exercises `evaluateHeartbeatGate` end-to-end against real `hooks`/`tasks`/
 * `notifications` rows: every skip reason plus the run path, including the
 * deterministic probe that decides whether any LLM turn happens at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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
  ...over,
});

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
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg({ enabled: false }), NOON);
    expect(r.decision).toEqual({ run: false, reason: 'disabled' });
  });

  test('quiet hours → skip(quiet_hours)', async () => {
    const hook = await makeHeartbeatHook();
    // 23:30 UTC is inside 22→7.
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), new Date('2026-07-12T23:30:00Z'));
    expect(r.decision).toEqual({ run: false, reason: 'quiet_hours' });
  });

  test('daily cap reached → skip(daily_cap)', async () => {
    const dayKey = heartbeat.localDayKey(NOON, 'UTC');
    const hook = await makeHeartbeatHook({ triggerConfig: { heartbeatDayKey: dayKey, heartbeatRunsToday: 24 } });
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg({ maxRunsPerDay: 24 }), NOON);
    expect(r.decision).toEqual({ run: false, reason: 'daily_cap' });
    expect(r.runsToday).toBe(24);
  });

  test('counter from a previous day is ignored (resets)', async () => {
    const hook = await makeHeartbeatHook({ triggerConfig: { heartbeatDayKey: '2020-01-01', heartbeatRunsToday: 99 } });
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON);
    // Stale day → counter treated as 0, so cap doesn't trip (nothing pending though).
    expect(r.runsToday).toBe(0);
    expect(r.decision).toEqual({ run: false, reason: 'nothing_pending' });
  });

  test('nothing pending → skip(nothing_pending)', async () => {
    const hook = await makeHeartbeatHook();
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON);
    expect(r.decision).toEqual({ run: false, reason: 'nothing_pending' });
  });

  test('a future-due task is NOT pending', async () => {
    const hook = await makeHeartbeatHook();
    await db.insert(tasksSchema).values({
      userId, title: 'Later', status: 'open', dueAt: new Date('2026-07-20T00:00:00Z'),
    });
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON);
    expect(r.decision).toEqual({ run: false, reason: 'nothing_pending' });
  });

  test('a due open task → run with a checklist message', async () => {
    const hook = await makeHeartbeatHook();
    await db.insert(tasksSchema).values({
      userId, title: 'Reply to the release email', status: 'open', dueAt: new Date('2026-07-12T09:00:00Z'),
    });
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON);
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
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON);
    expect(r.decision.run).toBe(true);
    if (r.decision.run) expect(r.decision.message).toContain('CI failed');
  });

  test('a done task and a read notification are ignored', async () => {
    const hook = await makeHeartbeatHook();
    await db.insert(tasksSchema).values({
      userId, title: 'done thing', status: 'done', dueAt: new Date('2026-07-12T09:00:00Z'),
    });
    await db.insert(notifsSchema).values({ userId, type: 'x', title: 'seen', read: true });
    const r = await heartbeat.evaluateHeartbeatGate(hook, cfg(), NOON);
    expect(r.decision).toEqual({ run: false, reason: 'nothing_pending' });
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
