/**
 * A specialist arm. There is no `orchestrator` role any more: the root agent of
 * a turn runs as `general` (see `ROOT_ROLE`), and the role that could only
 * delegate went with the routing hop in Phase 9 of the rebuild plan. Historical
 * `agents.role = 'orchestrator'` rows predate that and are read as plain text.
 */
export type AgentRole =
  | 'research' | 'coding' | 'review' | 'qa'
  | 'communication' | 'general'
  | 'design' | 'devops' | 'security' | 'data' | 'ai'
  | 'finance' | 'automation' | 'pm' | 'writing' | 'architecture';

/**
 * The role the ROOT agent of a turn runs as: an ordinary specialist role with
 * the general toolset, not a dedicated "orchestrator" that can only delegate.
 * See `buildDelegationPolicy` in `orchestrator-runner.ts`, and Phase 9 of
 * `docs/plans/rebuild-execution-plan.md` for why the latter is gone.
 */
export const ROOT_ROLE: AgentRole = 'general';

export type PipelineStatus = 'planning' | 'running' | 'paused' | 'awaiting_approval' | 'completed' | 'failed';

export type StageStatus = 'pending' | 'running' | 'awaiting_approval' | 'approved' | 'completed' | 'failed' | 'skipped';

/**
 * What a pipeline step IS.
 *
 * - `standard` — a worker runs it.
 * - `qa_validation` — a worker runs it and its verdict routes the graph.
 * - `human_input` — NO worker runs it. The walk stops and asks a person; their
 *   answer becomes the step's output and the next step's input.
 */
export type PipelineStageType = 'standard' | 'qa_validation' | 'human_input';

export interface QAValidationResult {
  passed: boolean;
  issues: string[];
  feedback: string;
  retryCount: number;
  /**
   * Enumerated verdict confidence (Phase 3). Enumerated, not a probability
   * float — LLM self-reported probabilities are poorly calibrated. `undefined`
   * when the stage didn't report one (not defaulted — a missing signal stays
   * missing). A low-confidence pass may warrant a retry even though `passed`
   * is true.
   */
  confidence?: 'high' | 'medium' | 'low';
  /**
   * Set when the audit-coverage gate (`auditVerdictFailure`) downgraded a
   * PASSING verdict to a failure because the auditor could not account for the
   * stages it covered. The distinction matters to the retry loop: the fault is
   * in the *report*, not in the implementation, so the retry re-runs the
   * auditor alone and must NOT re-run the implementation stage — which would
   * both waste a paid run and risk tripping that stage's own evidence gate
   * (a re-run with nothing to do can legitimately change 0 files).
   */
  auditGateFailed?: boolean;

  /**
   * WHICH audit-gate failure this is. Both take the auditor-only retry path,
   * but they need opposite prompts.
   *
   * - `unparseable` — the findings stand, only the report's shape is unusable.
   *   Correctable without re-reading anything, which is the cheap path.
   * - `coverage` — a PASS that does not account for stages in scope, or
   *   unaddressed low-confidence doubt. The auditor has to go and LOOK; asking
   *   it to correct the wording instead lets it only re-word, the gate rejects
   *   the same uncovered stages again, and the retry budget burns down without
   *   the missing stage ever being examined.
   */
  auditGateReason?: 'unparseable' | 'coverage';
  /**
   * What the auditor states it did NOT check. jcode's `validate_artifact`
   * calls this the cheat code: forcing an agent to list what it did not
   * explore is what surfaces the unexplored crannies. An explicit "nothing —
   * the diff is three lines" is a legal answer; silence is not.
   */
  whatIDidNotCheck?: string[];
  /**
   * Which parser tier produced this verdict. `json` is the structured block
   * `QA_VERDICT_JSON_INSTRUCTION` asks for; `inline` recovered fields from
   * prose; `prose` matched a PASS/FAIL headline only. The thin-verdict rules
   * apply to `json` alone — a tier that was never asked for the fields must
   * not be failed for lacking them.
   */
  source?: 'json' | 'inline' | 'prose';
}

export interface RoleConfig {
  role: AgentRole;
  toolIds: string[];
  defaultTopic: string;
  systemPromptTemplate: string;
  /**
   * Dense small-model variant (from `roles/<role>/prompt.lite.md`), selected on
   * the small-model path in place of `systemPromptTemplate` (Phase C). Undefined
   * when the role ships no lite variant — the full prompt is used as before.
   */
  liteSystemPromptTemplate?: string;
  /** Lazy-discovery core set; see `RoleMeta.coreToolIds`. */
  coreToolIds?: string[];
  /** Strip file-mutating handlers from this role; see `RoleMeta.readOnly`. */
  readOnly?: boolean;
}

export interface MessageClassification {
  type: 'casual' | 'task' | 'followup' | 'approval' | 'ambiguous';
  confidence: number;
  complexity?: 'simple' | 'moderate' | 'complex';
  topic?: string;
  reasoning?: string;
  /**
   * Chat/work split (`.octipus/end-user-ux-design.md` Thread 3): whether the
   * deliverable belongs `inline` in the chat reply or as an editable `file` the
   * user opens in the Files tab. Heuristic default from `classifyMessage`; the
   * user can force it per-message via the composer toggle (handled at runtime,
   * not here). Absent ⇒ treat as `inline`.
   */
  outputMode?: 'inline' | 'file';
}

export interface PIIFilterResult {
  filtered: string;
  redactions: PIIRedaction[];
  hasRedactions: boolean;
}

export interface PIIRedaction {
  type: 'email' | 'phone' | 'ssn' | 'credit_card' | 'api_key' | 'ip_address';
  original: string;
  replacement: string;
  position: [number, number];
}

export interface Pipeline {
  id: string;
  orchestratorId: string;
  sessionId: string;
  userId: string;
  title: string;
  stages: PipelineStage[];
  currentStageIndex: number;
  status: PipelineStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  summary?: string;
  metadata: Record<string, unknown>;
}

export interface PipelineStage {
  id: string;
  pipelineId: string;
  name: string;
  role: AgentRole;
  model?: string;
  toolIds: string[];
  systemPrompt: string;
  input: string;
  output?: string;
  workerId?: string;
  status: StageStatus;
  requiresApproval: boolean;
  approvedAt?: Date;
  approvedBy?: string;
  stageIndex: number;
  createdAt: Date;
  completedAt?: Date;
  error?: string;
}

export interface WorkerResult {
  workerId: string;
  role: AgentRole;
  result: string;
  model: string;
  iterations: number;
  durationMs: number;
  totalTokens?: number;
}

export interface ResponseMetadata {
  model?: string;
  tokens?: number;
  latencyMs?: number;
  cached?: boolean;
  sessionTotalTokens?: number;
  /**
   * Source attribution — what context was pulled into the reply
   * (recent messages, profile facts, knowledge hits, classifier topic,
   * skills loaded, completed pipeline stages, etc). Rendered into the
   * response body via `appendSources()`; also kept on metadata for
   * instrumentation, logs, and offline eval.
   */
  sources?: string[];
}

/**
 * Append a "_Sources: …_" footer to an assistant reply. Centralised so
 * `directResponse`, the orchestrator, expert sessions, and pipeline
 * stages all render the same shape. Returns the original content
 * untouched when there are no sources.
 */
export function appendSources(content: string, sources: string[]): string {
  if (!sources.length) return content;
  return `${content}\n\n_Sources: ${sources.join(', ')}_`;
}
