/**
 * Task wakeup bridge over a real Postgres LISTEN/NOTIFY (INTEGRATION=1, the
 * docker-compose.test.yml database; see scripts/test-integration.ts). Another
 * server process is played by a raw `pg_notify` under a different origin.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { shutdownTaskStateListener } from '@/db/task-state-listener';
import { isIntegration, setupIntegrationDb, teardownIntegration } from '@/test-helpers/integration';
import {
  encodeWakeups,
  PROCESS_ORIGIN,
  startTaskWakeupBridge,
  stopTaskWakeupBridge,
  TASK_WAKEUP_CHANNEL,
  titleKey,
} from './wakeup-bridge';
import { onTaskWakeup, type TaskWakeupEvent } from './wakeups';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = (n: number): TaskWakeupEvent => ({
  type: 'task.unblocked', userId: uuid(1), workspaceId: null, taskId: uuid(100 + n), title: '', triggeredBy: uuid(2), cause: 'closed',
});

describe.skipIf(!isIntegration)('task wakeup bridge (Integration)', () => {
  beforeAll(async () => {
    await setupIntegrationDb();
  });

  afterAll(async () => {
    await stopTaskWakeupBridge();
    await shutdownTaskStateListener();
    await teardownIntegration();
  });

  test('another process\'s NOTIFY is re-emitted here as remote; our own is skipped', async () => {
    expect(await startTaskWakeupBridge({ resolveTitles: async (refs) => new Map(refs.map((r) => [titleKey(r), 'T'])) })).toBe(true);
    const got: TaskWakeupEvent[] = [];
    const off = onTaskWakeup((e) => { got.push(e); });
    try {
      const notify = (payload: string) => getDb().execute(sql`SELECT pg_notify(${TASK_WAKEUP_CHANNEL}, ${payload})`);
      await notify(encodeWakeups(PROCESS_ORIGIN, [event(1)])[0]);
      await notify(encodeWakeups('another-process', [event(2)])[0]);
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 200));
      expect(got).toEqual([{ ...event(2), title: 'T', remote: true }]);
    } finally {
      off();
    }
  });
});
