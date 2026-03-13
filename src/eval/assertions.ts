/**
 * Assertion evaluators for the eval harness.
 * Each assertion type has a dedicated evaluator that returns an AssertionResult.
 */

import type {
  Assertion,
  AssertionResult,
  AssertionType,
  TestExecutionContext,
} from './types';

type AssertionEvaluator = (
  assertion: Assertion,
  ctx: TestExecutionContext,
  graderFn?: GraderFunction,
) => Promise<AssertionResult> | AssertionResult;

/** LLM grader function signature — injected by the runner */
export type GraderFunction = (prompt: string) => Promise<{ content: string; score?: number }>;

const evaluators: Record<string, AssertionEvaluator> = {};

function register(type: string, fn: AssertionEvaluator) {
  evaluators[type] = fn;
}

// ── Classification ───────────────────────────────────────────────────

register('classification', (assertion, ctx) => {
  const expected = String(assertion.value);
  const actual = ctx.classification?.type || 'unknown';
  const passed = actual === expected;
  return {
    type: 'classification',
    passed,
    expected,
    actual,
    score: passed ? 1 : 0,
    message: passed
      ? `Classified as "${actual}"`
      : `Expected classification "${expected}", got "${actual}"`,
  };
});

register('confidence_above', (assertion, ctx) => {
  const threshold = Number(assertion.value) || 0;
  const actual = ctx.classification?.confidence ?? 0;
  const passed = actual > threshold;
  return {
    type: 'confidence_above',
    passed,
    expected: threshold,
    actual,
    score: passed ? 1 : Math.max(0, actual / threshold),
    message: passed
      ? `Confidence ${actual.toFixed(2)} > ${threshold}`
      : `Confidence ${actual.toFixed(2)} <= threshold ${threshold}`,
  };
});

// ── Routing ──────────────────────────────────────────────────────────

register('routes_to_role', (assertion, ctx) => {
  const expected = String(assertion.value);
  const actual = ctx.routedRole || ctx.classification?.topic || 'unknown';
  // Allow topic-based matching for unit mode (no orchestrator running)
  const passed = actual === expected;
  return {
    type: 'routes_to_role',
    passed,
    expected,
    actual,
    score: passed ? 1 : 0,
    message: passed
      ? `Routed to "${actual}"`
      : `Expected role "${expected}", got "${actual}"`,
  };
});

// ── Tool usage ───────────────────────────────────────────────────────

register('uses_tool', (assertion, ctx) => {
  const expected = String(assertion.value);
  const tools = ctx.toolsUsed || [];
  const passed = tools.some(t => t === expected || t.startsWith(expected + '/'));
  return {
    type: 'uses_tool',
    passed,
    expected,
    actual: tools,
    score: passed ? 1 : 0,
    message: passed
      ? `Tool "${expected}" was used`
      : `Tool "${expected}" was not used (tools used: ${tools.join(', ') || 'none'})`,
  };
});

register('not_uses_tool', (assertion, ctx) => {
  const expected = String(assertion.value);
  const tools = ctx.toolsUsed || [];
  const passed = !tools.some(t => t === expected || t.startsWith(expected + '/'));
  return {
    type: 'not_uses_tool',
    passed,
    expected: `NOT ${expected}`,
    actual: tools,
    score: passed ? 1 : 0,
    message: passed
      ? `Tool "${expected}" was correctly not used`
      : `Tool "${expected}" should not have been used`,
  };
});

// ── String matching ──────────────────────────────────────────────────

register('contains', (assertion, ctx) => {
  const expected = String(assertion.value);
  const response = ctx.response || '';
  const passed = response.toLowerCase().includes(expected.toLowerCase());
  return {
    type: 'contains',
    passed,
    expected,
    actual: response.slice(0, 200),
    score: passed ? 1 : 0,
    message: passed
      ? `Response contains "${expected}"`
      : `Response does not contain "${expected}"`,
  };
});

register('not_contains', (assertion, ctx) => {
  const expected = String(assertion.value);
  const response = ctx.response || '';
  const passed = !response.toLowerCase().includes(expected.toLowerCase());
  return {
    type: 'not_contains',
    passed,
    expected: `NOT "${expected}"`,
    actual: response.slice(0, 200),
    score: passed ? 1 : 0,
    message: passed
      ? `Response correctly does not contain "${expected}"`
      : `Response should not contain "${expected}"`,
  };
});

register('matches_regex', (assertion, ctx) => {
  const pattern = String(assertion.value);
  const response = ctx.response || '';
  let passed = false;
  try {
    const regex = new RegExp(pattern, 'i');
    passed = regex.test(response);
  } catch {
    return {
      type: 'matches_regex',
      passed: false,
      expected: pattern,
      actual: 'INVALID_REGEX',
      score: 0,
      message: `Invalid regex pattern: ${pattern}`,
    };
  }
  return {
    type: 'matches_regex',
    passed,
    expected: pattern,
    actual: response.slice(0, 200),
    score: passed ? 1 : 0,
    message: passed
      ? `Response matches /${pattern}/`
      : `Response does not match /${pattern}/`,
  };
});

// ── Performance ──────────────────────────────────────────────────────

register('latency_under', (assertion, ctx) => {
  const maxMs = Number(assertion.value) || 5000;
  const actual = ctx.latencyMs;
  const passed = actual < maxMs;
  return {
    type: 'latency_under',
    passed,
    expected: `< ${maxMs}ms`,
    actual: `${actual}ms`,
    score: passed ? 1 : Math.max(0, 1 - (actual - maxMs) / maxMs),
    message: passed
      ? `Latency ${actual}ms < ${maxMs}ms`
      : `Latency ${actual}ms exceeds ${maxMs}ms limit`,
  };
});

register('token_count_under', (assertion, ctx) => {
  const maxTokens = Number(assertion.value) || 1000;
  const totalTokens = (ctx.tokenCount?.input || 0) + (ctx.tokenCount?.output || 0);
  const passed = totalTokens < maxTokens;
  return {
    type: 'token_count_under',
    passed,
    expected: `< ${maxTokens}`,
    actual: totalTokens,
    score: passed ? 1 : Math.max(0, 1 - (totalTokens - maxTokens) / maxTokens),
    message: passed
      ? `Token count ${totalTokens} < ${maxTokens}`
      : `Token count ${totalTokens} exceeds ${maxTokens} limit`,
  };
});

// ── LLM-graded assertions ────────────────────────────────────────────

register('response_quality', async (assertion, ctx, graderFn) => {
  const minScore = Number(assertion.value) || 3;
  const response = ctx.response || '';

  if (!graderFn) {
    return {
      type: 'response_quality',
      passed: false,
      expected: `>= ${minScore}`,
      actual: 'NO_GRADER',
      score: 0,
      message: 'No grader model configured for response_quality assertion',
    };
  }

  try {
    const result = await graderFn(
      `Rate the quality of this AI assistant response on a scale of 1-5.\n` +
      `1 = Completely wrong or unhelpful\n` +
      `2 = Partially relevant but major issues\n` +
      `3 = Adequate but could be better\n` +
      `4 = Good, helpful response\n` +
      `5 = Excellent, comprehensive response\n\n` +
      `User input: ${ctx.metadata?.input || ''}\n\n` +
      `Response:\n${response}\n\n` +
      `Reply with ONLY a JSON object: {"score": <1-5>, "reason": "<brief explanation>"}`,
    );

    let score = 3;
    let reason = '';
    try {
      const parsed = JSON.parse(result.content);
      score = Number(parsed.score) || 3;
      reason = parsed.reason || '';
    } catch {
      // Try to extract a number from the response
      const match = result.content.match(/(\d)/);
      score = match ? Number(match[1]) : 3;
    }

    const passed = score >= minScore;
    return {
      type: 'response_quality',
      passed,
      expected: `>= ${minScore}`,
      actual: score,
      score: score / 5,
      message: passed
        ? `Quality score ${score}/5 (${reason})`
        : `Quality score ${score}/5 below minimum ${minScore} (${reason})`,
    };
  } catch (err) {
    return {
      type: 'response_quality',
      passed: false,
      expected: `>= ${minScore}`,
      actual: 'GRADER_ERROR',
      score: 0,
      message: `Grader failed: ${(err as Error).message}`,
    };
  }
});

register('no_hallucination', async (assertion, ctx, graderFn) => {
  const response = ctx.response || '';

  if (!graderFn) {
    return {
      type: 'no_hallucination',
      passed: false,
      expected: 'no hallucinations',
      actual: 'NO_GRADER',
      score: 0,
      message: 'No grader model configured for no_hallucination assertion',
    };
  }

  try {
    const result = await graderFn(
      `Check if this AI assistant response contains hallucinated facts.\n` +
      `A hallucination is when the AI states something as fact that is incorrect, ` +
      `fabricated, or cannot be verified from the input.\n\n` +
      `User input: ${ctx.metadata?.input || ''}\n\n` +
      `Response:\n${response}\n\n` +
      `Reply with ONLY a JSON object: {"has_hallucination": <true|false>, "details": "<explanation>"}`,
    );

    let hasHallucination = false;
    let details = '';
    try {
      const parsed = JSON.parse(result.content);
      hasHallucination = parsed.has_hallucination === true;
      details = parsed.details || '';
    } catch {
      hasHallucination = result.content.toLowerCase().includes('true');
    }

    return {
      type: 'no_hallucination',
      passed: !hasHallucination,
      expected: 'no hallucinations',
      actual: hasHallucination ? 'hallucination detected' : 'clean',
      score: hasHallucination ? 0 : 1,
      message: hasHallucination
        ? `Hallucination detected: ${details}`
        : 'No hallucinations found',
    };
  } catch (err) {
    return {
      type: 'no_hallucination',
      passed: false,
      expected: 'no hallucinations',
      actual: 'GRADER_ERROR',
      score: 0,
      message: `Grader failed: ${(err as Error).message}`,
    };
  }
});

register('follows_format', async (assertion, ctx, graderFn) => {
  const formatDesc = String(assertion.value);
  const response = ctx.response || '';

  if (!graderFn) {
    return {
      type: 'follows_format',
      passed: false,
      expected: formatDesc,
      actual: 'NO_GRADER',
      score: 0,
      message: 'No grader model configured for follows_format assertion',
    };
  }

  try {
    const result = await graderFn(
      `Does this AI response follow the expected format?\n\n` +
      `Expected format: ${formatDesc}\n\n` +
      `Response:\n${response}\n\n` +
      `Reply with ONLY a JSON object: {"follows_format": <true|false>, "reason": "<explanation>"}`,
    );

    let follows = false;
    let reason = '';
    try {
      const parsed = JSON.parse(result.content);
      follows = parsed.follows_format === true;
      reason = parsed.reason || '';
    } catch {
      follows = result.content.toLowerCase().includes('true');
    }

    return {
      type: 'follows_format',
      passed: follows,
      expected: formatDesc,
      actual: follows ? 'format matches' : 'format mismatch',
      score: follows ? 1 : 0,
      message: follows
        ? `Response follows expected format: ${formatDesc}`
        : `Response does not follow format "${formatDesc}": ${reason}`,
    };
  } catch (err) {
    return {
      type: 'follows_format',
      passed: false,
      expected: formatDesc,
      actual: 'GRADER_ERROR',
      score: 0,
      message: `Grader failed: ${(err as Error).message}`,
    };
  }
});

// ── Public API ───────────────────────────────────────────────────────

/**
 * Evaluate a single assertion against a test execution context.
 */
export async function evaluateAssertion(
  assertion: Assertion,
  ctx: TestExecutionContext,
  graderFn?: GraderFunction,
): Promise<AssertionResult> {
  const evaluator = evaluators[assertion.type];
  if (!evaluator) {
    return {
      type: assertion.type as AssertionType,
      passed: false,
      expected: assertion.value,
      actual: 'UNSUPPORTED',
      score: 0,
      message: `No evaluator for assertion type "${assertion.type}"`,
    };
  }
  return evaluator(assertion, ctx, graderFn);
}

/**
 * Evaluate all assertions for a test and compute a weighted score.
 */
export async function evaluateAllAssertions(
  assertions: Assertion[],
  ctx: TestExecutionContext,
  graderFn?: GraderFunction,
): Promise<{ results: AssertionResult[]; score: number; passed: boolean }> {
  const results: AssertionResult[] = [];
  let totalWeight = 0;
  let weightedScore = 0;

  for (const assertion of assertions) {
    const result = await evaluateAssertion(assertion, ctx, graderFn);
    results.push(result);

    const weight = assertion.weight ?? 1;
    totalWeight += weight;
    weightedScore += result.score * weight;
  }

  const score = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const passed = results.every(r => r.passed);

  return { results, score, passed };
}
