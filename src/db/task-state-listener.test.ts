import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { getDb } from '@/db/postgres';
import { users } from '@/db/schema/users';
import { workspaces } from '@/db/schema/organizations';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
  truncateTables,
} from '@/test-helpers/integration';
import { _channelsForTest, shutdownTaskStateListener, subscribeTaskState, type TaskStateNotification } from './task-state-listener';
import { TaskStateRepository } from './repositories/task-state-repository';

describe.skipIf(!isIntegration)('task-state-listener (Integration)', () => {
  let repo: TaskStateRepository;
  let userId: string;
  let workspaceId: string;
  const sessionId = randomUUID();

  beforeAll(async () => {
    await setupIntegrationDb();
    repo = new TaskStateRepository();
  });

  afterAll(async () => {
    await shutdownTaskStateListener();
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

  test('NOTIFY from trigger reaches subscriber', async () => {
    const received: TaskStateNotification[] = [];
    const unsubscribe = await subscribeTaskState(sessionId, (n) => received.push(n));

    const created = await repo.create({
      sessionId,
      userId,
      workspaceId,
      ownerAgent: 'research',
      taskKind: 'agent_output',
      status: 'done',
      outputs: { text: 'done' },
    });

    // NOTIFY is async via the listener socket; give it a tick.
    await waitFor(() => received.length >= 1, 1000);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].id).toBe(created.id);
    expect(received[0].owner).toBe('research');
    expect(received[0].status).toBe('done');

    await unsubscribe();
  });

  test('ref-counting: two subscribers on one channel share one LISTEN', async () => {
    const aGot: TaskStateNotification[] = [];
    const bGot: TaskStateNotification[] = [];

    const uA = await subscribeTaskState(sessionId, (n) => aGot.push(n));
    const uB = await subscribeTaskState(sessionId, (n) => bGot.push(n));

    const ch = _channelsForTest().get(`task_state_${sessionId}`);
    expect(ch?.handlerCount).toBe(2);

    await repo.create({
      sessionId,
      userId,
      ownerAgent: 'coding',
      taskKind: 'agent_output',
      status: 'done',
    });

    await waitFor(() => aGot.length >= 1 && bGot.length >= 1, 1000);
    expect(aGot.length).toBe(1);
    expect(bGot.length).toBe(1);

    await uA();
    expect(_channelsForTest().get(`task_state_${sessionId}`)?.handlerCount).toBe(1);
    await uB();
    // After the last unsubscribe the channel record is dropped.
    expect(_channelsForTest().has(`task_state_${sessionId}`)).toBe(false);
  });

  test('unsubscribe stops further deliveries to that handler', async () => {
    const got: TaskStateNotification[] = [];
    const unsubscribe = await subscribeTaskState(sessionId, (n) => got.push(n));

    await repo.create({ sessionId, userId, ownerAgent: 'qa', taskKind: 'agent_output', status: 'done' });
    await waitFor(() => got.length >= 1, 1000);
    await unsubscribe();

    await repo.create({ sessionId, userId, ownerAgent: 'qa', taskKind: 'agent_output', status: 'done' });
    // Give time for any stray NOTIFY to flow.
    await new Promise((r) => setTimeout(r, 200));
    expect(got.length).toBe(1);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
