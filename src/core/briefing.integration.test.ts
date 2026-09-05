/**
 * Daily briefing seed — integration tests over embedded PGlite (no Docker).
 * Same harness as heartbeat.integration.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '11111111-1111-1111-1111-111111111111';
const NOON = new Date('2026-07-12T12:00:00Z'); // a Sunday

let db: typeof import('@/db/postgres').getDb extends () => infer R ? R : never;
let briefing: typeof import('./briefing');
let hooksSchema: typeof import('@/db/schema/hooks').hooks;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-briefing-'));
  const { initializeDb, executeRaw, getDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'briefing_user', false)`);
  db = getDb();
  briefing = await import('./briefing');
  hooksSchema = (await import('@/db/schema/hooks')).hooks;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  await db.delete(hooksSchema).where(eq(hooksSchema.userId, userId));
});

describe('ensureDailyBriefingHook', () => {
  test('creates one enabled weekday-morning schedule hook and is idempotent', async () => {
    const id1 = await briefing.ensureDailyBriefingHook(userId, { now: NOON });
    const id2 = await briefing.ensureDailyBriefingHook(userId, { now: NOON });
    expect(id1).toBe(id2);
    const rows = await db.select().from(hooksSchema).where(eq(hooksSchema.userId, userId));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.name).toBe(briefing.DAILY_BRIEFING_HOOK_NAME);
    expect(row.trigger).toBe('schedule');
    expect(row.isEnabled).toBe(true);
    expect(row.triggerConfig.cronExpression).toBe(briefing.DAILY_BRIEFING_CRON);
    expect(row.action).toBe('spawn_agent');
    expect(row.actionConfig.orchestrated).toBe(true);
    expect(row.actionConfig.notifyRoot).toBe(true);
    expect(row.actionConfig.agentPrompt).toContain('list_tasks with view "next"');
    expect(row.actionConfig.agentPrompt).toContain('Next three');
    // Scheduled, not "due now": the cron runner picks it up on the next 08:00 weekday.
    expect(row.nextRunAt).not.toBeNull();
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test('disable then re-ensure re-enables without duplicating', async () => {
    const id = await briefing.ensureDailyBriefingHook(userId, { now: NOON });
    await briefing.disableDailyBriefingHook(userId, NOON);
    let [row] = await db.select().from(hooksSchema).where(eq(hooksSchema.id, id));
    expect(row.isEnabled).toBe(false);

    const id2 = await briefing.ensureDailyBriefingHook(userId, { now: NOON });
    expect(id2).toBe(id);
    [row] = await db.select().from(hooksSchema).where(eq(hooksSchema.id, id));
    expect(row.isEnabled).toBe(true);
    const all = await db.select().from(hooksSchema).where(eq(hooksSchema.userId, userId));
    expect(all).toHaveLength(1);
  });

  test('honours a custom timezone and cron on first creation', async () => {
    const id = await briefing.ensureDailyBriefingHook(userId, { timezone: 'Europe/Berlin', cronExpression: '30 7 * * 1-5', now: NOON });
    const [row] = await db.select().from(hooksSchema).where(eq(hooksSchema.id, id));
    expect(row.triggerConfig).toEqual({ cronExpression: '30 7 * * 1-5', timezone: 'Europe/Berlin' });
  });
});

describe('dailyBriefingPrompt', () => {
  test('never asks for an integration unconditionally', () => {
    const p = briefing.dailyBriefingPrompt();
    for (const section of ['Calendar', 'Inbox', 'Code']) {
      const line = p.split('\n').find((l) => l.includes(`${section}:`));
      expect(line, section).toMatch(/if .* (is )?available/);
    }
  });
});
