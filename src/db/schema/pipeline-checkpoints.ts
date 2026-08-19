import { bigserial, index, jsonb, pgTable, timestamp, uuid, text } from 'drizzle-orm/pg-core';
import { pipelines } from './pipelines';

/**
 * A materialized snapshot of the walker's state at ONE node boundary.
 *
 * `run_events` says which boundaries were crossed; it does not carry enough to
 * continue from one. The walker holds live state the node rows never see — the
 * handoff chain, per-edge traversal counts, QA feedback in flight, the plan item
 * being worked — so a crash, a restart, or a deliberate pause loses the run
 * even though every node's output survived.
 *
 * One row per node ENTRY (before the node runs), which is what makes both
 * halves work: resuming re-enters the node that was interrupted, and rewinding
 * to a node means loading the row written when that node was last entered and
 * walking forward again. The interrupted node is re-run rather than resumed
 * mid-flight — a worker turn is not itself resumable, and re-running one node
 * is the cheap half of "do not re-pay for the good half".
 *
 * State is stored whole rather than as a diff: a snapshot small enough to be
 * one jsonb (a few KB of prose) does not need a fold to reconstruct, and a
 * checkpoint you cannot read without replaying every earlier one is not much
 * of a checkpoint.
 */
export const pipelineCheckpoints = pgTable(
  'pipeline_checkpoints',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    pipelineId: uuid('pipeline_id')
      .references(() => pipelines.id, { onDelete: 'cascade' })
      .notNull(),
    /** The node the walker was about to run. */
    nodeKey: text('node_key').notNull(),
    /** Serialized `WalkState` — see `pipeline-manager.ts`. */
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pipelineIdx: index('pipeline_checkpoints_pipeline_idx').on(t.pipelineId, t.seq),
  }),
);

export type PipelineCheckpointRow = typeof pipelineCheckpoints.$inferSelect;
export type NewPipelineCheckpoint = typeof pipelineCheckpoints.$inferInsert;
