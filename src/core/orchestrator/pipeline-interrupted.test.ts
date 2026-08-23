import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isIntegration, setupIntegrationDb, teardownIntegration, truncateTables } from '@/test-helpers/integration';
import { seedSession, seedUsers } from '@/test-helpers/multiuser-fixtures';

/**
 * Phase 3's runnable check, in the one form that can be automated: a process
 * that died mid-run leaves its pipeline row saying `running`, and the boot
 * sweep must turn that into an interruption rather than leave it looking live
 * — or worse, let it read as finished.
 *
 * `reconcileInterrupted` is what `src/index.ts` calls at boot, so this is the
 * shipping path and not a hand-made argument. The negative case matters as
 * much as the positive one: a run that genuinely completed before the crash
 * must not be rewritten into a paused one.
 *
 * DB-backed: `bun run test:integration -- src/core/orchestrator/pipeline-interrupted.test.ts`.
 */
describe.skipIf(!isIntegration)('pipeline boot reconcile (DB-backed)', () => {
  const userId = '00000000-0000-0000-0000-0000000000b1';
  let sessionId: string;

  const insertPipeline = async (status: string, summary: string | null): Promise<string> => {
    const { executeRaw } = await import('@/db/postgres');
    const { randomUUID } = await import('node:crypto');
    const id = randomUUID();
    await executeRaw(
      `INSERT INTO pipelines (id, orchestrator_agent_id, session_id, user_id, title, type, status, summary)
       VALUES ('${id}', 'orch-1', '${sessionId}', '${userId}', 'test', 'development', '${status}',
               ${summary === null ? 'NULL' : `'${summary}'`})`,
    );
    return id;
  };

  const read = async (id: string): Promise<{ status: string; summary: string | null }> => {
    const { executeRaw } = await import('@/db/postgres');
    const rows = await executeRaw(`SELECT status, summary FROM pipelines WHERE id = '${id}'`);
    const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows) ?? [];
    return (list as Array<{ status: string; summary: string | null }>)[0];
  };

  beforeAll(async () => {
    await setupIntegrationDb();
    await truncateTables(['pipelines', 'sessions', 'users']);
    await seedUsers([{ id: userId, username: 'reconcile-user' }]);
    sessionId = (await seedSession({ userId })).id;
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  it('turns a run left `running` by a dead process into a resumable pause', async () => {
    const running = await insertPipeline('running', null);
    // `awaiting_approval` is just as dead: the walker blocked on the question
    // is gone and nothing will ever answer it.
    const awaiting = await insertPipeline('awaiting_approval', null);
    const completed = await insertPipeline('completed', 'all good');

    const { getPipelineManager } = await import('@/core/orchestrator');
    const count = await getPipelineManager().reconcileInterrupted();
    expect(count).toBe(2);

    for (const id of [running, awaiting]) {
      const row = await read(id);
      expect(row.status).toBe('paused');
      // The summary is what the UI shows: it must say interrupted, not done.
      expect(row.summary).toMatch(/interrupted/i);
    }

    // The negative half. A run that finished before the crash keeps its own
    // status and its own summary — a sweep that rewrote those would turn real
    // completions into phantom pauses on every restart.
    const done = await read(completed);
    expect(done.status).toBe('completed');
    expect(done.summary).toBe('all good');
  });

  it('resets the stage the dead process was inside, and leaves the others alone', async () => {
    const { executeRaw } = await import('@/db/postgres');
    const crashed = await insertPipeline('running', null);
    // One stage done, one live when the process died, one never reached.
    for (const [key, status, ordinal] of [
      ['stage-done', 'completed', 0],
      ['stage-live', 'running', 1],
      // A stage killed while it sat on a question: the walker inside
      // `requestApproval` is gone and nothing will ever answer, so a row still
      // claiming to be waiting on the user is the same lie one status over.
      ['stage-asking', 'awaiting_approval', 2],
      ['stage-later', 'pending', 3],
    ] as const) {
      await executeRaw(
        `INSERT INTO pipeline_nodes (pipeline_id, node_key, name, role, system_prompt, status, ordinal)
         VALUES ('${crashed}', '${key}', '${key}', 'research', 'p', '${status}', ${ordinal})`,
      );
    }

    const { getPipelineManager } = await import('@/core/orchestrator');
    expect(await getPipelineManager().reconcileInterrupted()).toBe(1);

    const rows = await executeRaw(
      `SELECT node_key, status FROM pipeline_nodes WHERE pipeline_id = '${crashed}' ORDER BY ordinal`,
    );
    const list = ((Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows) ?? []) as Array<{
      node_key: string;
      status: string;
    }>;
    const byKey = Object.fromEntries(list.map((r) => [r.node_key, r.status]));

    // The live one is the lie: its worker died with the process, so a row that
    // still says `running` claims work is in flight when none is. It re-runs on
    // resume, so `pending` is the honest state.
    expect(byKey['stage-live']).toBe('pending');
    expect(byKey['stage-asking']).toBe('pending');
    // Completed work stays completed — rewriting it would make the resumed run
    // redo everything that had already finished.
    expect(byKey['stage-done']).toBe('completed');
    expect(byKey['stage-later']).toBe('pending');
  });

  it('is idempotent — a second boot changes nothing', async () => {
    const { getPipelineManager } = await import('@/core/orchestrator');
    expect(await getPipelineManager().reconcileInterrupted()).toBe(0);
  });
});
