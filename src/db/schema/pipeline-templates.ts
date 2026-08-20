import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export interface PipelineStepConfig {
  name: string;
  description?: string;
  topic: string;
  toolIds: string[];
  requiresApproval: boolean;
  promptTemplate?: string;
  stageType?: 'standard' | 'qa_validation' | 'human_input';
  maxRetries?: number;
  retryTargetStage?: number;
  /**
   * Per-stage model override (a bound model name/id, never a literal in source).
   * When set, this stage's worker runs on this model instead of the topic's
   * primary binding. Empty ⇒ topic binding (today's behaviour).
   */
  model?: string;
  /**
   * DECLARES that this stage is expected to leave files behind. Only declared
   * stages are evidence-gated: a run that changed zero files fails instead of
   * reporting green over an empty workspace (docs/plans/pipeline-evidence-gate.md).
   *
   * Deliberately opt-in, never inferred from the stage name or its prompt
   * wording — a research/review stage legitimately writes nothing, and wrongly
   * failing work that actually succeeded is worse than no gate at all.
   */
  producesArtifacts?: boolean;
  /**
   * DECLARES that this stage's whole purpose is to EXECUTE something — run the
   * test suite, the linter, the build — not merely to read and reason about it.
   * A declared stage that finishes having run zero commands fails.
   *
   * The failure this closes, measured on 2026-08-03: a Testing agent whose tool
   * set had been intersected down to `filesystem` announced "I cannot run shell
   * commands… I'll simulate execution by analyzing the test logic", then emitted
   * a full per-test PASS table and "18 passed, 0 failed". Its receipt was
   * honest (`commandsRun: 0`) and nothing compared that honest receipt against
   * what the stage was for, so a simulation was accepted as a test run. The
   * claim happened to be true, which is luck, not verification.
   *
   * Opt-in for the same reason as `producesArtifacts`: it is a declaration of
   * purpose, never inferred from a stage's name or prompt wording.
   */
  runsCommands?: boolean;
  /**
   * DECLARES that this stage must NOT change the workspace — it inspects, runs
   * and reports, and the thing it is judging must be the same afterwards.
   *
   * The mirror of `producesArtifacts`, and it needs the workspace snapshot for
   * the same reason: tool counters cannot see a `shell__run` edit. Measured on
   * 2026-08-04 — a QA stage reported "I did not commit myself — QA validated the
   * working tree and did not mutate the repo under test" while having patched
   * `roman.py` and added five tests through the shell. Its `filesChanged` read
   * 0, so nothing contradicted the claim, and the pipeline finished with the
   * deliverable modified and uncommitted.
   *
   * A validator that edits the thing it is validating has invalidated its own
   * verdict; the right route for a defect it finds is to FAIL, which sends the
   * work back to the stage that owns it.
   */
  readOnly?: boolean;
  /**
   * DECLARES that this stage EXECUTES an already-approved plan rather than
   * deciding what the plan should be — so it binds to its lane's cheap
   * `executorModel` instead of the lane primary.
   *
   * This is the pipeline's half of the swarm's planner→executor split
   * (`hasPlan` in `src/core/swarm/spawner.ts`). That machinery only ever fired
   * for `spawn_child`; every pipeline stage goes through
   * `orchestrator/worker-spawner.ts`, which has no notion of a plan, so the
   * saving was unreachable from a pipeline. Measured 2026-08-08: every stage of
   * a full seven-stage run was on a paid model, `paidTokensPerRun` 3.4× target.
   *
   * A pipeline's plan is a real artifact, not an inference: `Requirements &
   * Architecture` is a user-APPROVED design document and the stages after it
   * carry it out, which is exactly the condition `hasPlan` encodes.
   *
   * Opt-in and per-stage, like every other declaration here, because the split
   * is a trade and not a free win: the A/B in `docs/plans/quality-loop-status.md`
   * found the token saving real (314k paid → 0) at ~6.6× wall clock, and on one
   * task the cheap arm gave up where the expensive one persisted. Judgment
   * stages (review, QA, architecture) deliberately do NOT declare it — a cheap
   * auditor is how a rubber stamp gets in.
   *
   * An explicit per-stage `model` still wins, and a lane with no
   * `executorModel` falls through to the primary (planner == executor).
   */
  mechanical?: boolean;
  /**
   * DECLARES that this step runs once per PLAN ITEM rather than once per
   * pipeline. A maximal run of CONSECUTIVE steps declaring this becomes the
   * body of a single `foreach` node — the grouping is the declaration, so
   * there is no nesting syntax to get wrong.
   *
   * The shape this exists for: research -> architect produce a plan, the user
   * approves it, and then implement -> review -> QA runs against each item in
   * turn. Expressing that as a cycle would lose "item 3 of 7"; expressing it as
   * copy-pasted stages loses the ability to plan at runtime.
   *
   * The loop re-reads `plan_items` on every pass, so an item appended mid-run
   * by a review or QA step (or by the user) is picked up rather than deferred
   * to a follow-up pipeline.
   */
  loopOverPlan?: boolean;
  /**
   * DECLARES that this step's job is to WRITE the plan the `foreach` loop will
   * iterate. Such a step gets the `plan` tool container and is expected to
   * leave `plan_items` behind; a declared step that produced none fails the
   * same way a `producesArtifacts` step that wrote no files does — silently
   * looping zero times would otherwise read as success.
   */
  producesPlan?: boolean;
  /**
   * The answer shape a `human_input` step asks for — one entry per field the
   * person is being asked to fill in. Optional: without it the step is a plain
   * free-text question.
   *
   * Advisory, not enforced: the fields are rendered into the question and sent
   * on the approval event so a client can draw a form, and the answer comes
   * back as text either way. Validating a typed answer would mean a second
   * round trip to a human who has already answered.
   */
  humanFields?: { key: string; label: string; options?: string[] }[];
  /**
   * Per-visit token cap for this step's worker (`NodeBudget.tokens.cap` for a
   * graph node). Absent ⇒ the global per-agent default, which is what every
   * stage used before budgets reached the graph.
   *
   * Bounds ONE visit. A `foreach` body is entered once per plan item and items
   * can be appended mid-run, so what bounds the RUN is the pipeline-wide pool
   * (`pipelines.metadata.tokenBudget`), not this.
   */
  maxTokens?: number;
}

/**
 * A typed, user-supplied parameter for a recipe (parameterized pipeline
 * template). Values are substituted into stage prompt templates as
 * `{{param.<key>}}`.
 */
export interface RecipeParameter {
  key: string;
  description?: string;
  inputType: 'string' | 'number' | 'boolean' | 'date' | 'select';
  requirement: 'required' | 'optional' | 'user_prompt';
  default?: string;
  /** Allowed values when inputType === 'select'. */
  options?: string[];
}

export const pipelineTemplates = pgTable('pipeline_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  name: text('name').notNull(),
  description: text('description'),
  isPreset: boolean('is_preset').default(false).notNull(),
  steps: jsonb('steps').$type<PipelineStepConfig[]>().default([]).notNull(),
  /** Typed parameters the recipe accepts; substituted as `{{param.<key>}}`. */
  parameters: jsonb('parameters').$type<RecipeParameter[]>().default([]).notNull(),
  /**
   * For a PRESET row: a hash of the steps this install was last SHIPPED, so
   * `seedPresetTemplates` can tell a preset the user has never touched from one
   * they have edited.
   *
   * Without it, presets were insert-once-and-never-again: user edits survived a
   * restart (correct) but so did stale prompts, and only the gating flags were
   * ever backfilled. Every prompt and `toolIds` improvement therefore shipped
   * dead — a real install would simply never receive it, and each change needed
   * a throwaway script to push into the stored row.
   *
   * Null means "seeded before this column existed", which is deliberately read
   * as EDITED: a row we cannot prove is untouched must not be overwritten, and
   * silently discarding a user's pipeline is the one failure worse than a stale
   * prompt. Such a row adopts the hash the first time its content happens to
   * match what is shipped, and self-updates from then on.
   */
  shippedHash: text('shipped_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type PipelineTemplate = typeof pipelineTemplates.$inferSelect;
export type NewPipelineTemplate = typeof pipelineTemplates.$inferInsert;
