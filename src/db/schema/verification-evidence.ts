import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Verification evidence ledger — an append-only record of every completion
 * check a pipeline/agent runs, so a `/goal`-style task is verified against
 * *evidence* (a QA verdict, an output-schema gate, a `pre_verify` command)
 * rather than the model's word, and that evidence survives a crash and is
 * observable after the fact (DESIGN.md: "if a user needs to see it after a
 * crash, it lives in the DB" + "observability over cleverness").
 *
 * Rows are never updated or deleted in normal operation — a re-check appends a
 * new row. `kind` distinguishes the check that produced it; `detail` carries
 * the check-specific payload (issues list, schema errors, command exit code).
 */
export const verificationKindEnum = pgEnum('verification_kind', [
  'qa_verdict', // a QA-validation stage's machine-readable PASS/FAIL verdict
  'schema_gate', // an expectedOutput.schema deterministic output-shape gate
  'pre_verify', // a project-defined pre-verify command/tool (tests, build, lint)
  'adhoc', // an ad-hoc verification script result
  'side_effect', // deterministic tool-execution counters for a stage that declared it produces artifacts
  'audit_coverage', // an auditor's pass checked against the stages it was accountable for
]);

export const verificationEvidence = pgTable(
  'verification_evidence',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** The session (conversation) this check belongs to. */
    sessionId: uuid('session_id').notNull(),
    /** Pipeline run this belongs to, when the check ran inside a pipeline. */
    pipelineId: uuid('pipeline_id'),
    /** Stage name (pipeline) or role (swarm) that produced the deliverable checked. */
    stage: text('stage'),
    /** Swarm node id, when the check gated a swarm child's result. */
    nodeId: text('node_id'),
    kind: verificationKindEnum('kind').notNull(),
    /** The verdict: did the deliverable pass this check? */
    passed: boolean('passed').notNull(),
    /** Self-reported confidence for verdict-style checks ('high'|'medium'|'low'). */
    confidence: text('confidence'),
    /** Check-specific detail: {issues, feedback, retryCount} | {schemaErrors} | {command, exitCode, outputExcerpt}. */
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sessionIdx: index('verification_evidence_session_idx').on(t.sessionId),
    sessionCreatedIdx: index('verification_evidence_session_created_idx').on(t.sessionId, t.createdAt),
    pipelineIdx: index('verification_evidence_pipeline_idx').on(t.pipelineId),
  }),
);

export type VerificationEvidenceRecord = typeof verificationEvidence.$inferSelect;
export type NewVerificationEvidenceRecord = typeof verificationEvidence.$inferInsert;
