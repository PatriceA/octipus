import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { users } from '@/db/schema/users';
import { workspaces } from '@/db/schema/organizations';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
  truncateTables,
} from '@/test-helpers/integration';
import type { TaskStateRepository } from './task-state-repository';

describe.skipIf(!isIntegration)('TaskStateRepository (Integration)', () => {
  let repo: TaskStateRepository;
  let userId: string;
  let workspaceId: string;
  const sessionId = randomUUID();

  beforeAll(async () => {
    await setupIntegrationDb();
    const mod = await import('./task-state-repository');
    repo = new mod.TaskStateRepository();
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  beforeEach(async () => {
    await truncateTables(['task_state', 'workspaces', 'users']);
    const db = getDb();
    const u = await db
      .insert(users)
      .values({ username: `u_${randomUUID().slice(0, 8)}` })
      .returning();
    userId = u[0].id;
    const w = await db
      .insert(workspaces)
      .values({ userId, slug: 'default', name: 'Default' })
      .returning();
    workspaceId = w[0].id;
  });

  test('create defaults status to pending and stamps timestamps', async () => {
    const t = await repo.create({
      sessionId,
      userId,
      workspaceId,
      ownerAgent: 'coding',
      taskKind: 'agent_output',
      inputs: { topic: 'tests' },
    });
    expect(t.id).toBeDefined();
    expect(t.status).toBe('pending');
    expect(t.createdAt).toBeInstanceOf(Date);
    expect(t.updatedAt).toBeInstanceOf(Date);
  });

  test('complete writes outputs and flips status to done', async () => {
    const t = await repo.create({
      sessionId,
      userId,
      ownerAgent: 'research',
      taskKind: 'agent_output',
    });
    await repo.complete(t.id, { text: 'summary' });
    const fetched = await repo.getById(t.id);
    expect(fetched?.status).toBe('done');
    expect((fetched?.outputs as Record<string, unknown>).text).toBe('summary');
  });

  test('fail records error + status', async () => {
    const t = await repo.create({
      sessionId,
      userId,
      ownerAgent: 'qa',
      taskKind: 'agent_output',
    });
    await repo.fail(t.id, 'provider timeout', { partial: true });
    const fetched = await repo.getById(t.id);
    expect(fetched?.status).toBe('failed');
    expect(fetched?.error).toBe('provider timeout');
    expect((fetched?.outputs as Record<string, unknown>).partial).toBe(true);
  });

  test('listSessionRecent returns newest first, scoped to session', async () => {
    await repo.create({ sessionId, userId, ownerAgent: 'a', taskKind: 'agent_output' });
    await repo.create({ sessionId, userId, ownerAgent: 'b', taskKind: 'agent_output' });
    // Different session — must not appear in our list.
    await repo.create({ sessionId: randomUUID(), userId, ownerAgent: 'c', taskKind: 'agent_output' });

    const recent = await repo.listSessionRecent(sessionId);
    expect(recent.length).toBe(2);
    expect(recent.map((t) => t.ownerAgent)).toEqual(['b', 'a']);
  });

  test('deleteDoneOlderThan only reaps done tasks', async () => {
    const t1 = await repo.create({ sessionId, userId, ownerAgent: 'x', taskKind: 'agent_output' });
    const t2 = await repo.create({ sessionId, userId, ownerAgent: 'y', taskKind: 'agent_output' });
    await repo.complete(t1.id, {});
    // Bump updated_at into the past so the cutoff catches it.
    await getDb().execute(
      sql`UPDATE task_state SET updated_at = now() - interval '60 days' WHERE id = ${t1.id}`,
    );

    const removed = await repo.deleteDoneOlderThan(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    expect(removed).toBe(1);
    // The pending one survives.
    expect(await repo.getById(t2.id)).not.toBeNull();
  });
});
