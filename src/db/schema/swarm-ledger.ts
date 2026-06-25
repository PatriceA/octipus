import { bigserial, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Swarm ledger — an append-only log of swarm-node lifecycle events, keyed by
 * `root_session_id`. Where `swarm_nodes` holds the *current* state of each
 * node, this holds the *history* of transitions, so a swarm interrupted by a
 * crash / restart can be replayed and reconciled deterministically.
 *
 * See `.octipus/codewhale-borrowed-ideas.md` (idea #2) and `src/core/swarm/
 * ledger.ts` for the replay/reconcile logic. Rows are never updated or
 * deleted in normal operation — reconciliation appends a `reconcile` event
 * rather than mutating prior rows.
 */
export const swarmLedgerEventEnum = pgEnum('swarm_ledger_event', [
  'spawn', // a child node was created and started running
  'result', // the node reached a terminal status with a result
  'cancel', // the node was cancelled (cascade / admin)
  'reconcile', // a resume pass marked an in-flight node terminal
]);

export const swarmLedger = pgTable(
  'swarm_ledger',
  {
    // Global monotonic order. Replay reads a root's rows ordered by `seq`, so
    // events fold in exactly the order they were appended regardless of
    // same-millisecond `created_at` ties.
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    rootSessionId: uuid('root_session_id').notNull(),
    nodeId: text('node_id').notNull(),
    parentNodeId: text('parent_node_id'),
    event: swarmLedgerEventEnum('event').notNull(),
    /** Event-specific detail (status, brief preview, result summary, reason). */
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    rootIdx: index('swarm_ledger_root_idx').on(t.rootSessionId),
    rootSeqIdx: index('swarm_ledger_root_seq_idx').on(t.rootSessionId, t.seq),
    nodeIdx: index('swarm_ledger_node_idx').on(t.nodeId),
  }),
);

export type SwarmLedgerRecord = typeof swarmLedger.$inferSelect;
export type NewSwarmLedgerRecord = typeof swarmLedger.$inferInsert;
