/**
 * Session retention — idle sessions are deleted after `sessions.retentionDays`,
 * except the ones a user marked to keep (`pinned`) and any with a running
 * agent. Backed by ephemeral PGlite so the real predicate and cascade run.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '55555555-5555-4555-8555-555555555555';
const DAY = 24 * 3600_000;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-retention-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'erin' }]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

/**
 * A session last touched `ageDays` ago, optionally with one message in it.
 * Inserted with its age: a BEFORE UPDATE trigger resets `updated_at` to now()
 * on every UPDATE, so it cannot be backdated afterwards.
 */
async function sessionAged(channelId: string, ageDays: number, pinned = false, message?: string) {
  const { getDb } = await import('@/db/postgres');
  const { sessions } = await import('@/db/schema/sessions');
  const { messages } = await import('@/db/schema/messages');
  const [session] = await getDb().insert(sessions).values({
    userId, channelType: 'webchat', channelId, pinned, updatedAt: new Date(Date.now() - ageDays * DAY),
  }).returning();
  if (message) await getDb().insert(messages).values({ sessionId: session.id, role: 'user', content: message });
  return session;
}

describe('sessionRepository.deleteExpired', () => {
  test('deletes idle unpinned sessions and their messages, keeps pinned and recent ones', async () => {
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const { getDb } = await import('@/db/postgres');
    const { messages } = await import('@/db/schema/messages');

    const stale = await sessionAged('ret-stale', 20, false, 'old');
    const kept = await sessionAged('ret-kept', 20, true);
    const recent = await sessionAged('ret-recent', 3);

    const deleted = await sessionRepository.deleteExpired(new Date(Date.now() - 14 * DAY));

    expect(deleted).toBe(1);
    expect(await sessionRepository.findById(stale.id)).toBeNull();
    expect(await getDb().select().from(messages).where(eq(messages.sessionId, stale.id))).toEqual([]);
    expect(await sessionRepository.findById(kept.id)).not.toBeNull();
    expect(await sessionRepository.findById(recent.id)).not.toBeNull();
  });

  test('skips a session that still has a running agent', async () => {
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const { getDb } = await import('@/db/postgres');
    const { agents } = await import('@/db/schema/agents');

    const busy = await sessionAged('ret-busy', 30);
    await getDb().insert(agents).values({ id: `agent-${rand(4)}`, sessionId: busy.id, userId, status: 'running' });

    await sessionRepository.deleteExpired(new Date(Date.now() - 14 * DAY));
    expect(await sessionRepository.findById(busy.id)).not.toBeNull();
  });

  test('skips a session still waiting on a monitor', async () => {
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const { getDb } = await import('@/db/postgres');
    const { monitors } = await import('@/db/schema/monitors');

    const waiting = await sessionAged('ret-monitor', 30);
    await getDb().insert(monitors).values({
      userId, sessionId: waiting.id, role: 'general', name: 'ci', continuation: 'resume',
      source: {} as typeof monitors.$inferInsert['source'], intervalSeconds: 60,
      deadline: new Date(Date.now() + DAY),
    });

    await sessionRepository.deleteExpired(new Date(Date.now() - 14 * DAY));
    expect(await sessionRepository.findById(waiting.id)).not.toBeNull();
  });

  test('skips a group-channel thread session with work still taken on in it', async () => {
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const { getDb } = await import('@/db/postgres');
    const { tasks } = await import('@/db/schema/tasks');

    const working = await sessionAged('ret-taken', 30);
    const finished = await sessionAged('ret-taken-done', 30);
    await getDb().insert(tasks).values([
      { userId, title: 'Draft the notes', status: 'in_progress', source: 'channel', sourceRef: { sessionId: working.id } },
      { userId, title: 'Done already', status: 'done', source: 'channel', sourceRef: { sessionId: finished.id } },
    ]);

    await sessionRepository.deleteExpired(new Date(Date.now() - 14 * DAY));
    expect(await sessionRepository.findById(working.id)).not.toBeNull();
    expect(await sessionRepository.findById(finished.id)).toBeNull();
  });

  test('the webchat auto-archive leaves pinned sessions active', async () => {
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const kept = await sessionAged('ret-archive', 10, true);

    await sessionRepository.cleanupOldWebchatSessions(7);
    expect((await sessionRepository.findById(kept.id))?.status).toBe('active');
  });
});
