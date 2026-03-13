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
  | 'response_quality'
  | 'latency_under'
  | 'no_hallucination'
  | 'follows_format'
  | 'token_count_under';

export interface Assertion {
  /** Assertion type */
  type: AssertionType | string;
  /** Expected value(s) for the assertion */
  value?: string | string[] | number;
  /** Relative importance (default 1) */
  weight?: number;
  /** Human-readable description of what this assertion checks */
  description?: string;
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
    sessionId?: string;
    channel?: string;
  };
  /** Expected output or behavior (for display/reference) */
  expected?: string;
  assertions: Assertion[];
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
}

export interface EvalResult {
  suiteId: string;
  testId: string;
  input: string;
  output: string;
  assertions: AssertionResult[];
  passed: boolean;
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
  /** Backward-compatible summary for red-team module */
  summary?: {
    total: number;
    passed: number;
    failed: number;
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
  };
  routedRole?: string;
  toolsUsed?: string[];
  response?: string;
  latencyMs: number;
  tokenCount?: { input: number; output: number };
  metadata?: Record<string, unknown>;
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
}
