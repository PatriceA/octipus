import { bigserial, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `run_events` — ONE append-only log of everything that happened during a run,
 * keyed by the root session. Formerly `swarm_ledger`, which recorded only swarm
 * node lifecycle; pipelines and tool dispatch kept no history at all, so
 * "what actually happened" could only be reconstructed from prose output and
 * scattered log lines.
 *
 * Where the state tables (`swarm_nodes`, `pipeline_nodes`, `plan_items`) hold
 * CURRENT state, this holds the TRANSITIONS. That distinction is what makes
 * three separate things possible off one table:
 *
 *  - **Replay / reconcile** — a swarm interrupted by a crash folds back to a
 *    deterministic state (`src/core/swarm/ledger.ts`, unchanged in behaviour;
 *    it now filters on `subject = 'swarm_node'`).
 *  - **Tracing** — a span-level view of a run needs the ordered event stream,
 *    not the final row states.
 *  - **Checkpointing** — resuming mid-graph needs to know which node boundaries
 *    were crossed, which an overwritten `status` column cannot say.
 *
 * Rows are never updated or deleted in normal operation.
 */
export const runEventSubjectEnum = pgEnum('run_event_subject', [
  'swarm_node',
  'pipeline_node',
  'plan_item',
  'tool',
  // The run as a whole, for what belongs to no single node — the token pool.
  'pipeline',
]);

export const runEventTypeEnum = pgEnum('run_event_type', [
  // Swarm node lifecycle — the original four. Their meaning is unchanged, and
  // `replayEvents` still treats result/cancel/reconcile as terminal.
  'spawn',
  'result',
  'cancel',
  'reconcile',
  // Graph walk.
  'node_entered',
  'node_completed',
  'node_failed',
  'edge_traversed',
  // Plan loop.
  'item_started',
  'item_finished',
  // Tool dispatch, recorded from the `tool:after` waterfall hook. Arguments and
  // results are deliberately NOT stored: the log is for shape, timing and cost,
  // and a durable copy of every tool payload is a data-retention problem nobody
  // asked for.
  'tool_call',
  // Budgets (wave 3). `node_tokens` is what one node visit cost, charged
  // whether the visit succeeded or failed; `budget_exhausted` is the run
  // stopping because the pool is gone.
  'node_tokens',
  'budget_exhausted',
]);

export const runEvents = pgTable(
  'run_events',
  {
    // Global monotonic order. Replay reads a run's rows ordered by `seq`, so
    // events fold in exactly the order they were appended regardless of
    // same-millisecond `created_at` ties.
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    /** Root session — one run. */
    runId: uuid('run_id').notNull(),
    subject: runEventSubjectEnum('subject').default('swarm_node').notNull(),
    /** Id of the thing this event is about: node id, node key, plan item id, tool id. */
    subjectId: text('subject_id').notNull(),
    /** Parent subject, where the subject has one (a swarm node's parent). */
    parentSubjectId: text('parent_subject_id'),
    event: runEventTypeEnum('event').notNull(),
    /** Event-specific detail (status, role, depth, duration, reason). */
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runIdx: index('run_events_run_idx').on(t.runId),
    runSeqIdx: index('run_events_run_seq_idx').on(t.runId, t.seq),
    subjectIdx: index('run_events_subject_idx').on(t.subjectId),
  }),
);

export type RunEventRecord = typeof runEvents.$inferSelect;
export type NewRunEventRecord = typeof runEvents.$inferInsert;
