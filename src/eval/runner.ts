/**
 * Eval test runner.
 * Supports two modes:
 *   - Unit mode: imports classifier/orchestrator directly (no running backend needed)
 *   - Integration mode: calls the running backend via HTTP API
 */

import { evaluateAllAssertions, type GraderFunction } from './assertions';
import type {
  EvalResult,
  EvalRunnerOptions,
  EvalSuite,
  EvalSuiteResult,
  EvalTest,
  TestExecutionContext,
} from './types';

// ── Default model resolution ────────────────────────────────────────

let _resolvedDefaultModel: string | undefined;

async function getDefaultModel(): Promise<string> {
  if (_resolvedDefaultModel) return _resolvedDefaultModel;
  try {
    const { getModelRegistry } = await import('@/models');
    const registry = getModelRegistry();
    const defaultModel = await registry.getDefaultModel();
    if (defaultModel?.modelId) {
      _resolvedDefaultModel = defaultModel.modelId;
      return _resolvedDefaultModel;
    }
    const models = await registry.getAllModels();
    if (models.length > 0) {
      _resolvedDefaultModel = models[0].modelId;
      return _resolvedDefaultModel;
    }
  } catch {
    // Ignore DB failures and fall through to explicit error below.
  }

  throw new Error('No enabled models configured in the database. Register a model (and set one as default) before running evals.');
}

// ── Unit mode helpers ────────────────────────────────────────────────

async function runTestUnit(
  test: EvalTest,
  model?: string,
): Promise<TestExecutionContext> {
  const start = Date.now();

  // Import classifier directly (no DB or backend needed)
  const { classifyMessage } = await import('@/core/orchestrator/classifier');
  const classification = classifyMessage(test.input);

  // For unit mode, we can only test classification and topic-based routing.
  // Full orchestrator/tool assertions require integration mode.
  const ctx: TestExecutionContext = {
    classification: {
      type: classification.type,
      confidence: classification.confidence,
      complexity: classification.complexity,
      topic: classification.topic,
    },
    // In unit mode, routedRole comes from classifier topic heuristic
    routedRole: classification.topic,
    toolsUsed: [],
    response: undefined,
    latencyMs: Date.now() - start,
    metadata: { input: test.input, mode: 'unit' },
  };

  // If the test needs a full response (contains, quality, defense, etc.), try direct LLM
  const needsResponse = test.assertions.some(a =>
    ['contains', 'not_contains', 'matches_regex', 'response_quality',
     'no_hallucination', 'follows_format', 'defense_held'].includes(a.type),
  );

  if (needsResponse && model) {
    try {
      // Apply the same input guard + security preamble that handleMessage() uses
      const { guardInput, buildSecurityReminder } = await import('@/core/orchestrator/input-guard');
      const { guardOutput } = await import('@/core/orchestrator/output-guard');
      const { SECURITY_PREAMBLE } = await import('@/core/orchestrator/roles');

      const inputGuard = guardInput(test.input);

      // If input guard blocks, simulate a blocked response
      if (inputGuard.action === 'block') {
        ctx.response = `I can't process this request: ${inputGuard.blockReason}`;
        ctx.latencyMs = Date.now() - start;
      } else {
        // Build system prompt with security preamble + per-request warning
        let systemContent = SECURITY_PREAMBLE + 'You are a helpful assistant.';
        if (inputGuard.action === 'warn') {
          systemContent += buildSecurityReminder(inputGuard.flags);
        }

        const { getLiteLLMClient } = await import('@/models/litellm-client');
        const client = getLiteLLMClient();
        const result = await client.complete({
          model,
          messages: [
            { role: 'system', content: systemContent, timestamp: new Date() },
            { role: 'user', content: test.input, timestamp: new Date() },
          ],
          temperature: 0.3,
          maxTokens: 1024,
        });
        ctx.response = result.content;
        ctx.tokenCount = {
          input: result.usage.inputTokens,
          output: result.usage.outputTokens,
        };
        ctx.latencyMs = Date.now() - start;

        // Apply output guard
        const outputCheck = guardOutput(ctx.response || '', inputGuard.flags);
        if (outputCheck.action === 'replace') {
          ctx.response = outputCheck.response;
        }
      }
    } catch (err) {
      ctx.response = `[LLM_ERROR] ${(err as Error).message}`;
    }
  }

  return ctx;
}

// ── Integration mode helpers ─────────────────────────────────────────

async function runTestIntegration(
  test: EvalTest,
  baseUrl: string,
  model?: string,
): Promise<TestExecutionContext> {
  const start = Date.now();
  const userId = test.context?.userId || 'eval-user';
  const sessionId = test.context?.sessionId || `eval-${test.id}-${Date.now()}`;
  const channel = test.context?.channel || 'api';

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: test.input,
        sessionId,
        userId,
        channel,
        ...(model ? { model } : {}),
      }),
    });

    if (!res.ok) {
      throw new Error(`API returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as {
      response?: string;
      classification?: { type: string; confidence: number; complexity?: string; topic?: string };
      metadata?: { latencyMs?: number; tokens?: number };
      agentId?: string;
    };

    return {
      classification: data.classification ? {
        type: data.classification.type,
        confidence: data.classification.confidence,
        complexity: data.classification.complexity,
        topic: data.classification.topic,
      } : undefined,
      routedRole: data.classification?.topic,
      toolsUsed: [], // Would need agent event tracking for full tool usage
      response: data.response,
      latencyMs: Date.now() - start,
      tokenCount: data.metadata?.tokens
        ? { input: 0, output: data.metadata.tokens }
        : undefined,
      metadata: {
        input: test.input,
        mode: 'integration',
        agentId: data.agentId,
      },
    };
  } catch (err) {
    return {
      latencyMs: Date.now() - start,
      response: `[INTEGRATION_ERROR] ${(err as Error).message}`,
      metadata: { input: test.input, mode: 'integration', error: (err as Error).message },
    };
  }
}

// ── Grader setup ─────────────────────────────────────────────────────

function createGraderFn(model: string): GraderFunction {
  return async (prompt: string) => {
    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const client = getLiteLLMClient();
    const result = await client.complete({
      model,
      messages: [
        { role: 'system', content: 'You are an evaluation grader. Always respond with valid JSON only.', timestamp: new Date() },
        { role: 'user', content: prompt, timestamp: new Date() },
      ],
      temperature: 0.1,
      maxTokens: 256,
      responseFormat: { type: 'json_object' },
    });
    return { content: result.content, score: undefined };
  };
}

// ── Concurrency limiter ──────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run a single eval test and return the result.
 */
export async function runTest(
  test: EvalTest,
  suiteId: string,
  options: EvalRunnerOptions = {},
): Promise<EvalResult> {
  const model = options.model;
  const graderFn = options.graderModel ? createGraderFn(options.graderModel) : undefined;

  // Execute the test
  const ctx = options.integration
    ? await runTestIntegration(test, options.baseUrl || 'http://localhost:3005', model)
    : await runTestUnit(test, model);

  // Add input to metadata for grader context
  if (ctx.metadata) {
    ctx.metadata.input = test.input;
  }

  // Evaluate all assertions
  const { results: assertionResults, score, passed } = await evaluateAllAssertions(
    test.assertions,
    ctx,
    graderFn,
  );

  return {
    suiteId,
    testId: test.id,
    input: test.input,
    output: ctx.response || '',
    assertions: assertionResults,
    passed,
    score,
    latencyMs: ctx.latencyMs,
    tokenCount: ctx.tokenCount,
    metadata: ctx.metadata,
    timestamp: new Date(),
  };
}

/**
 * Run an entire eval suite and return aggregated results.
 */
export async function runSuite(
  suite: EvalSuite,
  options: EvalRunnerOptions = {},
): Promise<EvalSuiteResult> {
  const start = Date.now();
  const concurrency = options.concurrency || 1;

  // Filter tests by tags if specified
  let tests = suite.tests;
  if (options.tags && options.tags.length > 0) {
    const tagSet = new Set(options.tags);
    tests = tests.filter(t => t.tags?.some(tag => tagSet.has(tag)));
    if (tests.length === 0) {
      console.warn(`No tests match tags: ${options.tags.join(', ')}`);
    }
  }

  // Apply suite defaults — resolve from config if no model specified anywhere
  const needsModel = tests.some(t =>
    t.assertions.some(a => ['contains', 'not_contains', 'matches_regex', 'response_quality',
      'no_hallucination', 'follows_format', 'defense_held'].includes(a.type)),
  );
  const explicitModel = options.model || suite.defaultModel;
  const model = explicitModel || (needsModel ? await getDefaultModel() : undefined);
  const runOptions: EvalRunnerOptions = {
    ...options,
    model,
    // Auto-set grader to the same model if not explicitly set and suite needs LLM grading
    graderModel: options.graderModel || (model && tests.some(t =>
      t.assertions.some(a => ['response_quality', 'no_hallucination', 'follows_format', 'defense_held'].includes(a.type)),
    ) ? model : undefined),
  };

  // Run all tests with concurrency control
  const results = await mapWithConcurrency(tests, concurrency, (test) =>
    runTest(test, suite.name, runOptions),
  );

  const passed = results.filter(r => r.passed).length;
  const totalScore = results.reduce((sum, r) => sum + r.score, 0);

  return {
    suite: suite.name,
    totalTests: results.length,
    passed,
    failed: results.length - passed,
    score: results.length > 0 ? totalScore / results.length : 0,
    results,
    duration: Date.now() - start,
    timestamp: new Date(),
  };
}

/**
 * Run multiple suites and return all results.
 */
export async function runAllSuites(
  suites: EvalSuite[],
  options: EvalRunnerOptions = {},
): Promise<EvalSuiteResult[]> {
  const results: EvalSuiteResult[] = [];
  for (const suite of suites) {
    const result = await runSuite(suite, options);
    results.push(result);
  }
  return results;
}
