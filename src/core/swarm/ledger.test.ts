import { describe, expect, it } from 'vitest';
import {
  RECONCILE_REASON,
  SwarmLedger,
  type SwarmLedgerEvent,
  computeReconciliation,
  replayEvents,
} from './ledger';
import type { SwarmLedgerRepository } from './ledger-repository';
import type { SwarmNodeRepository } from './node-repository';

let seq = 0;
function ev(
  nodeId: string,
  event: SwarmLedgerEvent['event'],
  extra: Partial<SwarmLedgerEvent> = {},
): SwarmLedgerEvent {
  const s = ++seq;
  return {
    seq: s,
    nodeId,
    parentNodeId: extra.parentNodeId ?? null,
    event,
    createdAtMs: extra.createdAtMs ?? s,
    payload: extra.payload ?? null,
  };
}

describe('replayEvents', () => {
  it('reconstructs a completed node as terminal with no incomplete entries', () => {
    const state = replayEvents([
      ev('a', 'spawn', { parentNodeId: 'root', payload: { role: 'research', depth: 1 } }),
      ev('a', 'result', { payload: { status: 'completed' } }),
    ]);
    expect(state.incomplete).toEqual([]);
    const a = state.nodes.get('a');
    expect(a?.status).toBe('completed');
    expect(a?.role).toBe('research');
    expect(a?.parentNodeId).toBe('root');
  });

  it('flags a spawned-but-never-terminated node as in_flight / incomplete', () => {
    const state = replayEvents([
      ev('a', 'spawn'),
      ev('b', 'spawn'),
      ev('b', 'result', { payload: { status: 'tool_error' } }),
    ]);
    expect(state.incomplete).toEqual(['a']);
    expect(state.nodes.get('a')?.status).toBe('in_flight');
    expect(state.nodes.get('b')?.status).toBe('tool_error');
  });

  it('treats cancel and reconcile as terminal', () => {
    const cancelled = replayEvents([ev('a', 'spawn'), ev('a', 'cancel')]);
    expect(cancelled.nodes.get('a')?.status).toBe('cancelled');
    expect(cancelled.incomplete).toEqual([]);

    const reconciled = replayEvents([
      ev('x', 'spawn'),
      ev('x', 'reconcile', { payload: { status: 'cancelled', reason: 'orphaned_at_resume' } }),
    ]);
    expect(reconciled.incomplete).toEqual([]);
  });

  it('tolerates a terminal event whose spawn was lost (stub node)', () => {
    const state = replayEvents([ev('orphan', 'result', { payload: { status: 'completed' } })]);
    expect(state.nodes.get('orphan')?.status).toBe('completed');
    expect(state.incomplete).toEqual([]);
  });

  it('is deterministic and order-faithful for a multi-node tree', () => {
    const events = [
      ev('a', 'spawn', { parentNodeId: 'root' }),
      ev('b', 'spawn', { parentNodeId: 'a' }),
      ev('a', 'result', { payload: { status: 'completed' } }),
      // b never terminates → crash mid-run.
    ];
    const state = replayEvents(events);
    expect(state.incomplete).toEqual(['b']);
    expect(state.nodes.size).toBe(2);
  });
});

describe('computeReconciliation', () => {
  it('produces a cancelled action per in-flight node', () => {
    const state = replayEvents([ev('a', 'spawn', { parentNodeId: 'root' }), ev('b', 'spawn')]);
    const actions = computeReconciliation(state);
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.newStatus === 'cancelled')).toBe(true);
    expect(actions.every((a) => a.reason === RECONCILE_REASON)).toBe(true);
    expect(actions.find((a) => a.nodeId === 'a')?.parentNodeId).toBe('root');
  });

  it('produces no actions when everything is terminal', () => {
    const state = replayEvents([ev('a', 'spawn'), ev('a', 'result', { payload: { status: 'completed' } })]);
    expect(computeReconciliation(state)).toEqual([]);
  });

  it('age guard skips in-flight nodes whose last event is too recent (multi-instance safety)', () => {
    // Node 'fresh' spawned at t=9000, 'old' at t=100. now=10000, threshold=5000.
    const state = replayEvents([
      ev('old', 'spawn', { createdAtMs: 100 }),
      ev('fresh', 'spawn', { createdAtMs: 9000 }),
    ]);
    const actions = computeReconciliation(state, { olderThanMs: 5000, nowMs: 10_000 });
    // Only 'old' (age 9900ms > 5000) is reconciled; 'fresh' (age 1000ms) is left
    // alone — a sibling instance may still be running it.
    expect(actions.map((a) => a.nodeId)).toEqual(['old']);
  });

  it('is idempotent: replaying with the reconcile events appended yields no further actions', () => {
    // First pass: 'a' is in-flight.
    const first = replayEvents([ev('a', 'spawn')]);
    const actions = computeReconciliation(first);
    expect(actions).toHaveLength(1);

    // Simulate the reconcile event being appended, then replay again.
    const second = replayEvents([
      ev('a', 'spawn'),
      ev('a', 'reconcile', { payload: { status: 'cancelled', reason: RECONCILE_REASON } }),
    ]);
    expect(computeReconciliation(second)).toEqual([]);
  });
});

interface FakeRow {
  seq: number;
  rootSessionId: string;
  nodeId: string;
  parentNodeId: string | null;
  event: SwarmLedgerEvent['event'];
  payload: unknown;
  createdAt: Date;
}

/**
 * In-memory ledger repo backed by a mutable row list. Typed via the public
 * repo interface (Pick) so the fake can't silently drift from the real
 * contract — no `as unknown as` laundering.
 */
function fakeLedgerRepo(): {
  repo: Pick<SwarmLedgerRepository, 'append' | 'findByRoot' | 'findRootsWithIncomplete'>;
  rows: FakeRow[];
} {
  let s = 0;
  const rows: FakeRow[] = [];
  const repo: Pick<SwarmLedgerRepository, 'append' | 'findByRoot' | 'findRootsWithIncomplete'> = {
    async append(r) {
      const seq = ++s;
      rows.push({
        seq,
        rootSessionId: r.rootSessionId,
        nodeId: r.nodeId,
        parentNodeId: r.parentNodeId ?? null,
        event: r.event,
        payload: r.payload ?? null,
        createdAt: new Date(seq),
      });
      return seq;
    },
    async findByRoot(root) {
      return rows
        .filter((r) => r.rootSessionId === root)
        .sort((a, b) => a.seq - b.seq) as unknown as Awaited<
        ReturnType<SwarmLedgerRepository['findByRoot']>
      >;
    },
    async findRootsWithIncomplete() {
      return [];
    },
  };
  return { repo, rows };
}

describe('SwarmLedger.reconcile', () => {
  it('appends a reconcile event and flips a still-running node, idempotently', async () => {
    const { repo, rows } = fakeLedgerRepo();
    const cancelCalls: string[] = [];
    let running = true;
    const nodes: Pick<SwarmNodeRepository, 'cancelIfRunning'> = {
      async cancelIfRunning(id: string) {
        cancelCalls.push(id);
        if (running) {
          running = false;
          return true;
        }
        return false;
      },
    };

    const ledger = new SwarmLedger(repo, nodes);
    await ledger.recordSpawn({ rootSessionId: 'root-1', nodeId: 'a', parentNodeId: 'root', role: 'qa', depth: 1 });

    const first = await ledger.reconcile('root-1');
    expect(first.reconciled).toBe(1);
    expect(first.nodeIds).toEqual(['a']);
    expect(cancelCalls).toEqual(['a']);
    // A reconcile event was appended (spawn + reconcile = 2 rows).
    expect(rows.filter((r) => r.event === 'reconcile')).toHaveLength(1);

    // Second pass is a no-op: 'a' now terminal in the ledger.
    const second = await ledger.reconcile('root-1');
    expect(second.reconciled).toBe(0);
    expect(rows.filter((r) => r.event === 'reconcile')).toHaveLength(1);
  });

  it('records the reconcile event even when the node flip reports not-running', async () => {
    const { repo, rows } = fakeLedgerRepo();
    const nodes: Pick<SwarmNodeRepository, 'cancelIfRunning'> = {
      async cancelIfRunning() {
        return false; // already terminal in the node table
      },
    };
    const ledger = new SwarmLedger(repo, nodes);
    await ledger.recordSpawn({ rootSessionId: 'r', nodeId: 'n', parentNodeId: null });
    const res = await ledger.reconcile('r');
    expect(res.reconciled).toBe(1);
    expect(rows.filter((r) => r.event === 'reconcile')).toHaveLength(1);
  });
});

describe('SwarmLedger write durability — the bracket is asymmetric', () => {
  /** A repo whose every append fails, i.e. the database is unreachable. */
  const brokenRepo = (): Pick<
    SwarmLedgerRepository,
    'append' | 'findByRoot' | 'findRootsWithIncomplete'
  > => ({
    async append() {
      throw new Error('db down');
    },
    async findByRoot() {
      return [];
    },
    async findRootsWithIncomplete() {
      return [];
    },
  });

  const noNodes: Pick<SwarmNodeRepository, 'cancelIfRunning'> = {
    async cancelIfRunning() {
      return false;
    },
  };

  it('THROWS when the spawn — the durable start — cannot be recorded', async () => {
    const ledger = new SwarmLedger(brokenRepo(), noNodes);
    // A node with no `spawn` row is invisible to replay and to
    // findRootsWithIncomplete, so it could never be reconciled. The caller
    // must learn about this and refuse to run the child.
    await expect(
      ledger.recordSpawn({ rootSessionId: 'r', nodeId: 'n', parentNodeId: null }),
    ).rejects.toThrow(/db down/);
  });

  it('swallows a failed terminal — a node left in-flight is the safe direction', async () => {
    const ledger = new SwarmLedger(brokenRepo(), noNodes);
    // The next reconcile finds it still in-flight and cancels it; the cost of
    // this failure is one spurious cancel, not an untracked running child.
    await ledger.recordTerminal({
      rootSessionId: 'r',
      nodeId: 'n',
      parentNodeId: null,
      status: 'completed',
    });
  });

  it('swallows a failed reconcile append and still attempts the node flip', async () => {
    const flipped: string[] = [];
    const repo = brokenRepo();
    // The node is in-flight per replay, and every append fails: reconcile must
    // still flip the node table rather than dying on the unwritable event.
    const ledger = new SwarmLedger(
      {
        ...repo,
        async findByRoot() {
          return [
            {
              seq: 1,
              nodeId: 'n',
              parentNodeId: null,
              event: 'spawn' as const,
              payload: null,
              createdAt: new Date(0),
            },
          ];
        },
      },
      {
        async cancelIfRunning(id: string) {
          flipped.push(id);
          return true;
        },
      },
    );
    const res = await ledger.reconcile('r');
    expect(res.reconciled).toBe(1);
    expect(flipped).toEqual(['n']);
  });
});
