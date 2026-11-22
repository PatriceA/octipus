/**
 * Context hooks (docs/CONTEXT-HOOKS.md): the shapes the server's routes
 * return and the web's Recall page reads, and the recall defaults both show.
 * Self-contained: imported by `src/core/context-hooks/` and by `web/`.
 */

/**
 * When a hook runs. `turn_start`: before the root agent answers a message
 * (chat, a channel, a heartbeat or scheduled turn, a plan run, a side
 * question). `worker_start`: before a specialist, a swarm child or a
 * directly spawned agent starts on its brief.
 */
export type ContextHookEvent = 'turn_start' | 'worker_start';
export type ContextHookKind = 'recall' | 'note' | 'notes_index';
/** The rule a recall passage qualified under (`qualifyHit`). */
export type RecallQualifiedBy = 'similarity' | 'coverage' | 'identifier';
/** The bar a recall search was decided at, and whether a passage it found cleared it (calibration). */
export interface RecallBar { minSimilarity: number; cleared: boolean }

/** The recall kind's defaults: what the hook uses for a setting the user left blank. */
export const RECALL_DEFAULTS = {
  limit: 4,
  minSimilarity: 0.45,
  keywordCoverage: 0.6,
  maxGap: 0.15,
  tokenBudget: 1200,
  /** A chunk's maximum length (`MAX_CHUNK_SIZE`): a chunk is shown whole, so its bytes do not depend on the query. */
  excerptChars: 1000,
} as const;
/**
 * The knowledge-base rows recall can search (`purposes`), all of them by
 * default. `lesson`: a note written by a learning review
 * (docs/SESSION-LEARNING.md). A hook that stored its own list before
 * `lesson` was added keeps that list, so lessons stay off for it until ticked.
 */
export const RECALL_PURPOSES = ['note', 'lesson', 'document', 'knowledge_artifact', 'image_description'] as const;
export type RecallPurpose = (typeof RECALL_PURPOSES)[number];
export const NOTE_DEFAULTS = { tokenBudget: 600 } as const;
export const NOTES_INDEX_DEFAULTS = { limit: 15, tokenBudget: 150 } as const;

/** A hook as GET /api/context-hooks lists it. */
export interface ContextHookView {
  /** Row id for a stored hook, `builtin:<key>` for a built-in. */
  id: string;
  builtin: string | null;
  name: string;
  kind: ContextHookKind;
  events: ContextHookEvent[];
  /** What the user set; a setting left out takes its default. */
  config: Record<string, unknown>;
  enabled: boolean;
  /** A built-in's description; null for the user's own hooks. */
  description: string | null;
}

export interface ContextHooksResponse {
  /** The install switch (`contextHooks.enabled`). */
  enabled: boolean;
  /** The token budget all hooks of one turn share (`contextHooks.maxTokens`). */
  maxTokens: number;
  hooks: ContextHookView[];
}

export interface Rate { n: number; of: number }

export interface ContextHookStatsHook {
  id: string;
  hook: string;
  kind: string;
  runs: number;
  injected: number;
  abstained: number;
  skipped: number;
  errors: number;
  avgTokens: number;
  avgLatencyMs: number;
  /** Mean best cosine of the runs that showed a passage qualified on similarity; null when none did. */
  avgTopScore: number | null;
  /** Runs where recall could not embed the query and matched on its keyword rules alone. */
  degraded: number;
  /** Blocks left out because the turn's shared budget was spent (`skipped`, `budget_spent`). */
  budgetSpent: number;
  /** Blocks left out because showing them failed (`error`, `commit_failed`). */
  commitFailed: number;
  /** Passages shown, by the rule they qualified under; a passage can count under more than one. */
  qualified: Record<RecallQualifiedBy, number>;
}

/** A recall hook whose bar looks wrong for this embedding model (docs/CONTEXT-HOOKS.md#calibration). */
export interface RecallCalibrationWarning {
  id: string;
  hook: string;
  verdict: 'injects_nearly_always' | 'injects_almost_never';
  /** Runs at the hook's current minSimilarity where a passage found cleared it, of those that searched on it. */
  found: Rate;
  /** True for the built-in Knowledge recall hook: the one the threshold sweep runs with and its button sets. */
  builtin: boolean;
  message: string;
}

/** Named and used, for a group of finished turns. */
export interface ContextHookUse {
  /** Finished turns that ended with an answer: every rate below is over these. */
  turns: number;
  /** Finished turns that ended without one (failed, cancelled, cleared, a child that did not complete): not in the rates. */
  unanswered: number;
  /** Turns where recall showed passages. */
  injected: Rate;
  /** Turns where the knowledge base or notes were read by a tool call. */
  searched: Rate;
  /** Turns with recall passages whose answer named one by title or id. */
  cited: Rate;
  /** Turns with recall passages, measured, whose answer used one (`passageUsed`). */
  used: Rate;
}

export interface ContextHookStats {
  days: number;
  turns: number;
  /** True when the window held more turns than are counted: the numbers cover the newest ones. */
  sampled: boolean;
  byHook: ContextHookStatsHook[];
  /** Finished turns that ended without an answer, left out of every rate here. */
  unanswered: number;
  /**
   * Finished turns that answered where the knowledge base or notes were read by a tool call:
   * by the agent, or for a root turn by it or a specialist it spawned.
   */
  searched: Rate;
  /** …of those where recall injected passages, and of those where it found nothing. */
  searchedAfterInjection: Rate;
  searchedAfterAbstain: Rate;
  /** Finished turns with recall passages whose answer named at least one of them (by title or id). */
  cited: Rate;
  /**
   * Finished turns with recall passages whose answer used at least one of
   * them. Turns recorded before this was measured are not in it.
   */
  used: Rate;
  byModel: Array<{ model: string; cli: boolean | null } & ContextHookUse>;
  /** Root turns (`turn_start`) apart from specialists and swarm children (`worker_start`). */
  byEvent: Array<{ event: ContextHookEvent } & ContextHookUse>;
  calibration: RecallCalibrationWarning[];
  recent: Array<{
    id: string;
    event: string;
    role: string | null;
    channel: string | null;
    model: string | null;
    cli: boolean | null;
    tokens: number;
    latencyMs: number;
    knowledgeToolCalls: number | null;
    notesToolCalls: number | null;
    citedItems: number | null;
    usedItems: number | null;
    outcome: string | null;
    createdAt: string;
    hooks: Array<{ hook: string; status: string; reason?: string; degraded?: 'embedding_failed'; titles: string[]; tokens: number }>;
  }>;
  /** What keeps long-term memory from filling; empty when nothing does. */
  memory: { facts: number; missing: Array<'background_model' | 'embedding_model' | 'extraction_off'> };
}

// ── Eval ────────────────────────────────────────────────────────────────────

export interface RecallEvalCase {
  question: string;
  /** Text naming where the answer is: a note title, a file name, a source id, or a phrase from the passage. Empty: the knowledge base should have nothing. */
  expect: string[];
}

export interface RecallEvalResult {
  config: { limit: number; minSimilarity: number };
  cases: Array<{ question: string; expect: string[]; hits: Array<{ title: string; sourceId: string; score: number }>; rank: number | null; pass: boolean }>;
  /** Answerable questions whose source was injected. */
  found: Rate;
  /** Mean reciprocal rank over answerable questions (1 = always first). */
  mrr: number;
  /** Questions that should find nothing and were given nothing. */
  abstained: Rate;
}

/** The same cases at a range of `minSimilarity` values (docs/CONTEXT-HOOKS.md#the-threshold-sweep). */
export interface RecallSweepResult {
  /** The Knowledge recall hook's settings the sweep ran with, `minSimilarity` aside. */
  config: { limit: number; keywordCoverage: number; maxGap: number; minSimilarity: number };
  rows: Array<{ minSimilarity: number; found: Rate; abstained: Rate; mrr: number }>;
  /** The value the rule recommends, or null with the reason. */
  recommended: number | null;
  /**
   * Why there is no recommendation: `needs_both_kinds` (the cases need
   * answerable questions and questions that should find nothing),
   * `embedding_failed` (a question could not be embedded: the bar was not
   * applied).
   */
  reason?: 'needs_both_kinds' | 'embedding_failed';
  /** Questions that could not be embedded. */
  degraded: number;
}
