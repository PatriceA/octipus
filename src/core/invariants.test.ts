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
    const r = (await runInvariants()).find((x) => x.name === 'throwing check');
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
    const r = (await runInvariants()).find((x) => x.name === 'failing check');
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
    const r = (await runInvariants()).find((x) => x.name === LEDGER_START);
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
