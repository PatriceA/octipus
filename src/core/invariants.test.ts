import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { isIntegration, setupIntegrationDb, teardownIntegration, truncateTables } from '@/test-helpers/integration';
import { registerInvariant, runInvariants } from './invariants';

const LEDGER_START = 'every spawned child node has a ledger start event';

describe('invariant registry', () => {
  test('a check that throws is reported as an error, not as a pass', async () => {
    registerInvariant({
      area: 'test',
      name: 'throwing check',
      async check() {
        throw new Error('probe unavailable');
      },
    });
    // Scoped to this file's own probes: an unfiltered run would also execute
    // the DB-backed invariant, which in the unit lane opens a pool against the
    // developer's real database.
    const r = (await runInvariants((i) => i.area === 'test')).find((x) => x.name === 'throwing check');
    // Not knowing is not the same as being fine. A check that swallows its own
    // failure into `null` is how a gate goes quiet without anyone noticing.
    expect(r?.error).toMatch(/probe unavailable/);
    expect(r?.violation).toBeNull();
  });

  test('a violation carries its text back to the caller', async () => {
    registerInvariant({
      area: 'test',
      name: 'failing check',
      async check() {
        return 'two rows are wrong';
      },
    });
    const r = (await runInvariants((i) => i.area === 'test')).find((x) => x.name === 'failing check');
    expect(r?.violation).toBe('two rows are wrong');
    expect(r?.error).toBeUndefined();
  });
});

/**
 * The point of an invariant is that it runs against real rows, so the ledger
 * one is only meaningful in the DB lane:
 *   `bun run test:integration -- src/core/invariants.test.ts`
 */
describe.skipIf(!isIntegration)('swarm ledger-start invariant (DB-backed)', () => {
  beforeAll(async () => {
    await setupIntegrationDb();
    await truncateTables(['swarm_nodes', 'run_events']);
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  const nodeId = 'inv-child-1';
  const rootSessionId = '00000000-0000-0000-0000-0000000000aa';

  const ledgerViolation = async (): Promise<string | null> => {
    const r = (await runInvariants((i) => i.name === LEDGER_START))[0];
    if (r?.error) throw new Error(`invariant failed to run: ${r.error}`);
    return r?.violation ?? null;
  };

  it('holds on an empty table', async () => {
    expect(await ledgerViolation()).toBeNull();
  });

  it('reports a child node written without its ledger start', async () => {
    const { getDb } = await import('@/db/postgres');
    const { swarmNodes } = await import('@/db/schema/swarm-nodes');
    await getDb().insert(swarmNodes).values({
      id: nodeId,
      rootSessionId,
      parentNodeId: 'inv-root',
      depth: 1,
      kind: 'agent',
      role: 'research',
      topicPath: 'research/x',
      model: 'm',
      status: 'running',
      tokenCap: 1000,
      wallClockCapMs: 60_000,
      fanOutCap: 0,
      briefHash: 'h',
    });
    expect(await ledgerViolation()).toMatch(/have no 'spawn' event/);
  });

  it('holds again once the start event exists', async () => {
    const { swarmLedgerRepository } = await import('./swarm/ledger-repository');
    await swarmLedgerRepository.append({
      rootSessionId,
      nodeId,
      parentNodeId: 'inv-root',
      event: 'spawn',
    });
    expect(await ledgerViolation()).toBeNull();
  });
});

/**
 * The token-accounting invariant. Same lane and same reason as the ledger one:
 * it asserts over rows, so it only means anything against a real database.
 */
describe.skipIf(!isIntegration)('swarm level token-cap invariant (DB-backed)', () => {
  const NAME = 'no running child exceeds its level token cap';

  beforeAll(async () => {
    await setupIntegrationDb();
    await truncateTables(['swarm_nodes', 'run_events']);
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  const violation = async (): Promise<string | null> => {
    const r = (await runInvariants((i) => i.name === NAME))[0];
    if (r?.error) throw new Error(`invariant failed to run: ${r.error}`);
    return r?.violation ?? null;
  };

  const insertNode = async (id: string, tokenCap: number, status: 'running' | 'completed') => {
    const { getDb } = await import('@/db/postgres');
    const { swarmNodes } = await import('@/db/schema/swarm-nodes');
    await getDb().insert(swarmNodes).values({
      id,
      rootSessionId: '00000000-0000-0000-0000-0000000000bb',
      parentNodeId: 'inv-root',
      depth: 1,
      kind: 'agent',
      role: 'research',
      topicPath: 'research/x',
      model: 'm',
      status,
      tokenCap,
      wallClockCapMs: 60_000,
      fanOutCap: 0,
      briefHash: 'h',
    });
  };

  it('holds on an empty table', async () => {
    expect(await violation()).toBeNull();
  });

  it('reports a running child whose pool is larger than its level allows', async () => {
    const { getLevelDefault } = await import('./swarm/types');
    await insertNode('inv-over-1', getLevelDefault(1).tokens + 1, 'running');
    expect(await violation()).toMatch(/over the .* level cap/);
  });

  it('ignores a finished row, which the current config never governed', async () => {
    const { getDb } = await import('@/db/postgres');
    const { swarmNodes } = await import('@/db/schema/swarm-nodes');
    const { eq } = await import('drizzle-orm');
    await getDb().update(swarmNodes).set({ status: 'completed' }).where(eq(swarmNodes.id, 'inv-over-1'));
    expect(await violation()).toBeNull();
  });
});

/**
 * The goal-state invariant: a pipeline the walker called finished, with a stage
 * still marked running underneath it.
 */
describe.skipIf(!isIntegration)('pipeline terminal-state invariant (DB-backed)', () => {
  const NAME = 'no terminal pipeline has a running stage';
  const userId = '33333333-3333-3333-3333-333333333333';
  let pipelineId: string;

  beforeAll(async () => {
    await setupIntegrationDb();
    await truncateTables(['pipeline_nodes', 'pipelines']);
    // Pipelines carry FKs to sessions and users, so seed both. Raw SQL for the
    // same reason the isolation suites use it — see multiuser-fixtures.ts.
    const { executeRaw, queryRaw } = await import('@/db/postgres');
    const { seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: userId, username: 'inv-user' }]);
    const session = await seedSession({ userId, channelId: 'inv-1' });
    await executeRaw(
      `INSERT INTO pipelines (orchestrator_agent_id, session_id, user_id, title, type, status)
       VALUES ('inv-orch', '${session.id}', '${userId}', 'inv pipeline', 'general', 'running')`,
    );
    const { rows } = await queryRaw(`SELECT id FROM pipelines WHERE orchestrator_agent_id = 'inv-orch'`);
    pipelineId = rows[0].id;
    await executeRaw(
      `INSERT INTO pipeline_nodes (pipeline_id, node_key, name, role, system_prompt, status, ordinal)
       VALUES ('${pipelineId}', 'stage-1', 'stage one', 'research', 'do it', 'running', 0)`,
    );
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  const violation = async (): Promise<string | null> => {
    const r = (await runInvariants((i) => i.name === NAME))[0];
    if (r?.error) throw new Error(`invariant failed to run: ${r.error}`);
    return r?.violation ?? null;
  };

  it('a running pipeline with a running stage is not a violation', async () => {
    expect(await violation()).toBeNull();
  });

  it('reports the same stage once the pipeline is marked completed', async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE pipelines SET status = 'completed' WHERE id = '${pipelineId}'`);
    expect(await violation()).toMatch(/still have a stage marked 'running'/);
  });

  it('a stage left pending under a finished pipeline is not a violation', async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE pipeline_nodes SET status = 'pending' WHERE pipeline_id = '${pipelineId}'`);
    // An untaken conditional branch legitimately stays pending forever, so
    // this must NOT fire — the invariant would be unusable otherwise.
    expect(await violation()).toBeNull();
  });
});
