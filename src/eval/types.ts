/**
 * Agent evaluation harness types.
 * Inspired by promptfoo — YAML-driven test suites for evaluating
 * routing accuracy, tool usage, and response quality.
 *
 * Used by eval harness, CLI runner, and red-team testing plugins.
 */

// ── Assertion types ──────────────────────────────────────────────────

export type AssertionType =
  | 'routes_to_role'
  | 'uses_tool'
  | 'not_uses_tool'
  | 'contains'
  | 'not_contains'
  | 'matches_regex'
  | 'classification'
  | 'confidence_above'
  | 'output_mode'
  | 'response_quality'
  | 'latency_under'
  | 'no_hallucination'
  | 'follows_format'
  | 'token_count_under'
  // Registered in assertions.ts and used by red-team.yaml, but was missing from
  // both this union and the loader's valid-type set — every run warned on it.
  | 'defense_held'
  /** The reply used a fact seeded by `memorySetup`. Integration mode only. */
  | 'recalls_memory'
  /** End state: rows in a database table after the turn (`state.ts`). Integration mode only. */
  | 'db_rows'
  /** `db_rows` with the table preset; see STATE_TABLE_ASSERTIONS in `state.ts`. */
  | 'memories' | 'memory_absent' | 'notifications' | 'tasks'
  | 'companion_goals' | 'companion_actions' | 'companion_reports' | 'companion_incidents';

/**
 * What a check is evidence of (after n8n's nod evals). An `outcome` check
 * grades what the user would care about — what changed, what was said; a
 * `process` check grades how the agent got there (a tool it used, a fixture it
 * read). Task completion counts outcome checks only; the strict pass rate
 * counts every check.
 */
export type CheckKind = 'process' | 'outcome';

/**
 * How bad a failure of this check is. `unsafe`: something happened that must
 * not (a poisoned memory, an unauthorised action) — reported apart from every
 * other failure and blocking a gate on its own. `incomplete`: the work was not
 * done. `other`: anything else.
 */
export type FailureClass = 'unsafe' | 'incomplete' | 'other';

export interface Assertion {
  /** Assertion type */
  type: AssertionType | string;
  /** Expected value(s) for the assertion */
  value?: string | string[] | number;
  /** Relative importance (default 1) */
  weight?: number;
  /** Human-readable description of what this assertion checks */
  description?: string;
  /** Stable name for the gate's per-check bookkeeping. Defaults to `<index>:<type>`. */
  id?: string;
  /** Default `outcome`. */
  kind?: CheckKind;
  /** Default `other`. */
  failure?: FailureClass;
  /** State assertions (`db_rows` and its presets): which rows to count. See `state.ts`. */
  query?: import('./state').StateQuery;
}

// ── Test definition ──────────────────────────────────────────────────

export interface EvalTest {
  id: string;
  description: string;
  /** User message to test */
  input: string;
  /** Optional test context */
  context?: {
    userId?: string;
    /** A real session id, or `$name` of a `sessions` fixture row. */
    sessionId?: string;
    /** The eval user's workspace; scopes Companion fixtures and checks. */
    workspaceId?: string;
    channel?: string;
    /** What the simulated client renders beyond text (`inline_ui`: interactive answers). Integration mode. */
    renders?: string[];
  };
  /** Expected output or behavior (for display/reference) */
  expected?: string;
  assertions: Assertion[];
  /**
   * Facts to write into the `memories` table for this test's user before the
   * request, and to remove afterwards. Integration mode only — see
   * `memory-setup.ts`.
   */
  memorySetup?: import('./memory-setup').MemorySeed[];
  /**
   * Rows to insert before the turn and delete afterwards (notes, sessions,
   * messages, Companion goals…). Integration mode only — see `state.ts`.
   */
  stateSetup?: import('./state').FixtureRow[];
  /**
   * Tables whose rows for the eval user created during the test are deleted
   * afterwards — e.g. `memories`, so a poisoned fact a failing run extracted
   * does not outlive the test.
   */
  cleanup?: string[];
  /**
   * What runs the turn. `chat` (default) posts `input` to /api/chat;
   * `companion_wake` files a Companion event and waits for the background
   * check-in it causes (integration mode, a live controller model).
   */
  trigger?: 'chat' | 'companion_wake';
  /** For `companion_wake`: which fixture rows the event is about (`$name` references). */
  wake?: { goal: string; session?: string; state?: string };
  /**
   * A file under the eval directory served over local HTTP for the duration of
   * the test; `{{fixtureUrl}}` in `input` is replaced by its URL. Part of the
   * gate fingerprint.
   */
  fixturePage?: string;
  /** Wait this long after the reply before reading state (memory extraction runs after the turn). */
  settleMs?: number;
  /**
   * `live`: needs a running backend and a real model for the agent or
   * controller under test. Informational: the runner refuses what it cannot
   * observe either way.
   */
  tier?: 'unit' | 'live';
  /** For filtering: 'routing', 'tools', 'quality', 'safety' */
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ── Suite definition ─────────────────────────────────────────────────

export interface EvalSuite {
  name: string;
  description?: string;
  tests: EvalTest[];
  defaultModel?: string;
  defaultTimeout?: number;
  metadata?: Record<string, unknown>;
}

// ── Results ──────────────────────────────────────────────────────────

export type TestStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface AssertionResult {
  type: AssertionType | string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  score: number;
  message?: string;
  /** Preserved for backward compat with red-team module */
  assertion?: Assertion;
  id?: string;
  kind?: CheckKind;
  failure?: FailureClass;
}

export interface EvalResult {
  suiteId: string;
  testId: string;
  input: string;
  output: string;
  assertions: AssertionResult[];
  /** Every check passed (the strict rate). */
  passed: boolean;
  /** Every OUTCOME check passed (task completion); process checks may have failed. */
  completed?: boolean;
  /** Ids of failed `unsafe`-class checks in this attempt. */
  unsafe?: string[];
  /** 1-based attempt number under `--repeat`. */
  attempt?: number;
  /** 0-1 weighted score */
  score: number;
  latencyMs: number;
  tokenCount?: { input: number; output: number };
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

/** Backward-compatible alias used by red-team module */
export interface EvalTestResult {
  testId: string;
  status: TestStatus;
  input: string;
  output?: string;
  assertionResults: AssertionResult[];
  durationMs: number;
  error?: string;
}

export interface EvalSuiteResult {
  suite: string;
  totalTests: number;
  passed: number;
  failed: number;
  score: number;
  results: EvalResult[];
  duration: number;
  timestamp: Date;
  /** Per-test repeat statistics (`stats.ts`), present when the suite ran. */
  stats?: import('./stats').TestStats[];
  /** Backward-compatible summary for red-team module */
  summary?: {
    total: number;
    passed: number;
    failed: number;
    /** Tests whose verdict rests on a check the runner could not make. */
    inconclusive?: number;
    errors: number;
    skipped: number;
    durationMs: number;
  };
}

// ── Execution context ────────────────────────────────────────────────

/** Context collected during a single test execution */
export interface TestExecutionContext {
  classification?: {
    type: string;
    confidence: number;
    complexity?: string;
    topic?: string;
    outputMode?: string;
  };
  /** First role the turn delegated to; undefined when routing was not observed. */
  routedRole?: string;
  /**
   * Every role the turn delegated to. A turn may fan out, so `routes_to_role`
   * is satisfied by membership rather than by the first one alone.
   */
  routedRoles?: string[];
  toolsUsed?: string[];
  response?: string;
  latencyMs: number;
  tokenCount?: { input: number; output: number };
  metadata?: Record<string, unknown>;
  /**
   * Whose rows state assertions may read, and since when. Absent ⇒ state is
   * not observable in this run, and every state assertion fails saying so.
   */
  state?: import('./state').StateScope;
}

// ── Runner options ───────────────────────────────────────────────────

export interface EvalRunnerOptions {
  /** Run in integration mode (calls running backend via HTTP) */
  integration?: boolean;
  /** Model override for all tests */
  model?: string;
  /** Max parallel test executions */
  concurrency?: number;
  /** Filter tests by tags */
  tags?: string[];
  /** Model to use for LLM-graded assertions */
  graderModel?: string;
  /** Base URL for integration mode */
  baseUrl?: string;
  /** Specific suite name to run */
  suite?: string;
  /** Attempts per test (default 1). */
  repeat?: number;
  /** k for pass@k / pass^k (default: repeat). */
  k?: number;
  /** Eval directory, for fixture files (default ./eval). */
  evalDir?: string;
}
