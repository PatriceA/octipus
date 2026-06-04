/**
 * Types for trajectory logging — records every orchestrator run as a
 * structured JSONL line for later eval / fine-tuning.
 *
 * Inspired by Hermes' approach: save success/fail trajectories as JSONL,
 * compress daily for training datasets.
 */

export type TrajectoryOutcome = 'success' | 'failure' | 'partial' | 'cancelled';

export type TrajectoryStepKind = 'llm_call' | 'tool_call' | 'spawn' | 'response';

export interface TrajectoryClassification {
  /** Task topic from classifier (e.g. "coding", "research"). Absent for casual messages. */
  topic?: string;
  /** Expert chosen for this run, if any (expertId). */
  expert?: string;
  /** Classifier confidence in [0, 1]. */
  confidence: number;
  /** Raw classification type (casual|task|approval|ambiguous|followup). */
  type?: string;
  /** Scored complexity (simple|moderate|complex). */
  complexity?: string;
}

export interface TrajectoryStep {
  /** Wall-clock time of the step (ISO 8601). */
  timestamp: string;
  kind: TrajectoryStepKind;
  /** Model name used for llm_call / spawn kinds. */
  model?: string;
  /** Tool identifier for tool_call kind. */
  tool?: string;
  /** Agent role for spawn kind. */
  role?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  /** Free-form outcome label: "ok", "error", "stopped", etc. */
  outcome?: string;
  error?: string;
  /** Optional freeform metadata (kept small). */
  data?: Record<string, unknown>;
}

/**
 * One complete orchestrator run — written as a single JSONL line.
 *
 * `failureReason` is typed as `string` for now. Once
 * `src/core/errors/classification.ts` lands (another agent is building it),
 * this will be widened to accept the `ClassifiedError` enum.
 */
export interface TrajectoryRecord {
  /** Schema version — bump when shape changes. */
  schemaVersion: 1;
  /** Root session id for the conversation (resolved by session-resolver). */
  rootSessionId: string;
  userId: string;
  /** ISO 8601 timestamp when handleMessage started. */
  startedAt: string;
  /** ISO 8601 timestamp when handleMessage returned / threw. */
  endedAt: string;
  /** The user's raw message (PII-redacted if `piiRedacted` is true). */
  userMessage: string;
  classification: TrajectoryClassification;
  steps: TrajectoryStep[];
  /** Final assistant response the orchestrator produced (PII-redacted if flagged). */
  finalResponse: string;
  outcome: TrajectoryOutcome;
  failureReason?: string;
  totalTokens: number;
  totalCostUsd?: number;
  modelsUsed: string[];
  expertsUsed: string[];
  /** True when emails/phones/etc. were stripped from userMessage/finalResponse. */
  piiRedacted: boolean;
  /** Channel (webchat, telegram, slack, api, hook). */
  channel?: string;
}
