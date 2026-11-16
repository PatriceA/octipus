/**
 * Eval test runner.
 * Supports two modes:
 *   - Unit mode: imports classifier/root agent directly (no running backend needed)
 *   - Integration mode: calls the running backend via HTTP API
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { evaluateAllAssertions, type GraderFunction, STATE_ASSERTION_TYPES } from './assertions';
import { clearMemories, memorySetupBlocker, seedMemories } from './memory-setup';
import { cleanupCreated, type InsertedFixtures, insertFixtures, removeFixtures, type StateScope } from './state';
import { summarizeAttempts } from './stats';
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
  const { classifyMessage } = await import('@/core/agent/classifier');
  const classification = classifyMessage(test.input);

  // For unit mode, we can only test classification and topic-based routing.
  // Full root agent/tool assertions require integration mode.
  const ctx: TestExecutionContext = {
    classification: {
      type: classification.type,
      confidence: classification.confidence,
      complexity: classification.complexity,
      topic: classification.topic,
      outputMode: classification.outputMode,
    },
      // NOT the classifier topic. `routes_to_role` used to read this field, and
    // its fallback is the classifier topic too, so setting it here made every
    // routing assertion compare the classifier against itself — green whether
    // routing worked or not. Routing is only observable in integration mode.
    routedRole: undefined,
    // Unobserved, not "none": unit mode runs no tools (`toolUsageObservabilityBlocker`).
    toolsUsed: undefined,
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
      const { guardInput, buildSecurityReminder } = await import('@/core/agent/input-guard');
      const { guardOutput } = await import('@/core/agent/output-guard');
      const { SECURITY_PREAMBLE } = await import('@/core/agent/roles');

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
          // An eval run (admin, `npm run eval`) tests the install's models: install work.
          funding: 'install',
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

/**
 * The api token integration mode calls the backend with.
 *
 * `/api/chat` requires authentication, and this harness used to post without
 * any — so every integration test got a 401, every assertion read "unknown",
 * and the report showed 0% quality for what was really a broken harness. Fail
 * loud instead: a missing token is a setup error, not a failing model.
 *
 * `OCTIPUS_API_KEY` wins; otherwise the bootstrap token the server mints at
 * boot (`~/.octipus/mcp-token`), which is what `bin/octi` and the MCP server
 * already use on this machine.
 */
let _apiToken: string | undefined;

function getApiToken(): string {
  if (_apiToken !== undefined) return _apiToken;
  const fromEnv = (process.env.OCTIPUS_API_KEY ?? '').trim();
  if (fromEnv) {
    _apiToken = fromEnv;
    return _apiToken;
  }
  const tokenPath = join(homedir(), '.octipus', 'mcp-token');
  _apiToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf-8').trim() : '';
  return _apiToken;
}


async function runTestIntegration(
  test: EvalTest,
  baseUrl: string,
  model?: string,
  input: string = test.input,
  sessionOverride?: string,
): Promise<TestExecutionContext> {
  const start = Date.now();
  const userId = test.context?.userId || 'eval-user';
  // No invented id: `eval-<test>-<ts>` is not a uuid, and posting it made the
  // backend fail the whole turn instead of running it. A suite that wants
  // continuity sets a real session id in `context` (or a `$name` fixture
  // session); otherwise let the backend open one, which is what a fresh turn
  // wants anyway.
  const sessionId = sessionOverride ?? test.context?.sessionId;
  const channel = test.context?.channel || 'api';

  const token = getApiToken();
  if (!token) {
    throw new Error(
      'Integration mode needs an api token: set OCTIPUS_API_KEY, or start the backend so it mints ~/.octipus/mcp-token.',
    );
  }

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: input,
        ...(sessionId ? { sessionId } : {}),
        userId,
        channel,
        // Opt in to the routing report. It costs the backend two extra
        // queries per turn, so ordinary chat does not pay for it — but
        // `routes_to_role` is exactly what this harness exists to check.
        routedRoles: true,
        // …and the tools the turn ran (`uses_tool`, `not_uses_tool`).
        toolsUsed: true,
        ...(test.context?.renders?.length ? { renders: test.context.renders } : {}),
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
      /** Roles this turn actually delegated to — see `routedRolesForTurn`. */
      routedRoles?: string[];
      /** Tools this turn ran — see `toolsUsedForTurn`. */
      toolsUsed?: string[];
    };

    return {
      classification: data.classification ? {
        type: data.classification.type,
        confidence: data.classification.confidence,
        complexity: data.classification.complexity,
        topic: data.classification.topic,
      } : undefined,
      // The role the work actually went to, reported by the backend from the
      // swarm nodes this turn spawned. NOT `classification.topic`, which is the
      // classifier's guess — reading that here made the assertion compare the
      // classifier with itself in integration mode too, so removing the unit
      // tautology alone would only have moved the lie.
      //
      // Undefined when the backend does not report it (an older build, or a
      // failed lookup), which the assertion reads as unverified rather than as
      // a miss.
      routedRole: data.routedRoles?.[0],
      routedRoles: data.routedRoles,
      // Undefined when the backend does not report it (an older build, a failed
      // lookup): the assertions read that as unobserved, never as "none".
      toolsUsed: data.toolsUsed,
      response: data.response,
      latencyMs: Date.now() - start,
      tokenCount: data.metadata?.tokens
        ? { input: 0, output: data.metadata.tokens }
        : undefined,
      metadata: {
        input,
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
      funding: 'install',
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

// ── End-state plumbing ───────────────────────────────────────────────

/** Does this test read or write the database around its turn? */
export function usesState(test: Pick<EvalTest, 'assertions' | 'stateSetup' | 'cleanup' | 'trigger'>): boolean {
  return test.assertions.some(a => STATE_ASSERTION_TYPES.has(a.type)) || !!test.stateSetup?.length
    || !!test.cleanup?.length || test.trigger === 'companion_wake';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why a test that reads or writes state cannot run here, or undefined. Unit
 * mode writes nothing, so "no such row" would pass on a turn that never ran;
 * and the rows must belong to a real user the request runs as.
 */
export function stateObservabilityBlocker(test: EvalTest, integration?: boolean): string | undefined {
  if (!usesState(test)) return undefined;
  if (!integration) {
    return 'End-state checks and fixtures need --integration: unit mode runs no tools and writes nothing, so an absence check would pass on nothing.';
  }
  if (!test.context?.userId || !UUID_RE.test(test.context.userId)) {
    return `End-state checks need context.userId to be the eval user's UUID (got "${test.context?.userId ?? 'unset'}").`;
  }
  return undefined;
}

/**
 * The eval process reads the backend's database directly. An embedded PGlite
 * is held open by the running backend and cannot be opened a second time.
 */
async function stateDatabase(): Promise<string | undefined> {
  const { getConfig } = await import('@/config');
  if ((getConfig().storageMode ?? 'external') === 'embedded') {
    return 'End-state checks read the backend database from this process; an embedded (PGlite) install is held open by the running backend. Run against an external Postgres.';
  }
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  return undefined;
}

/** Serve one fixture file over loopback HTTP for the length of a test. */
async function serveFixture(path: string): Promise<{ url: string; close: () => Promise<void> }> {
  const body = readFileSync(path);
  const type = path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8';
  const server: Server = createServer((_req, res) => { res.writeHead(200, { 'content-type': type }); res.end(body); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/${basename(path)}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

/**
 * File a Companion event for a fixture goal and wait for the background
 * check-in it causes. The running backend's scheduler claims the event and
 * runs the controller model; this only observes the receipt.
 */
async function runCompanionWake(test: EvalTest, refs: Record<string, string>, since: Date, timeoutMs: number): Promise<TestExecutionContext> {
  const start = Date.now();
  const { getDb } = await import('@/db/postgres');
  const { and, eq, gte, inArray } = await import('drizzle-orm');
  const { companionEvents, companionSettings, companionWakes } = await import('@/db/schema/companion-supervision');
  const ref = (name: string | undefined) => (name?.startsWith('$') ? refs[name.slice(1)] : name);
  const goalId = ref(test.wake?.goal);
  if (!goalId) return { latencyMs: 0, metadata: { input: test.input, error: `wake.goal ${test.wake?.goal} names no fixture row` } };
  await getDb().insert(companionEvents).values({ goalId, sessionId: ref(test.wake?.session) ?? null, kind: 'eval', sourceId: randomUUID(), state: test.wake?.state ?? 'failed' });
  const userId = test.context?.userId as string;
  while (Date.now() - start < timeoutMs) {
    const [done] = await getDb().select({ status: companionWakes.status, result: companionWakes.result }).from(companionWakes)
      .innerJoin(companionSettings, eq(companionSettings.id, companionWakes.settingsId))
      .where(and(eq(companionSettings.userId, userId), gte(companionWakes.createdAt, since), inArray(companionWakes.status, ['completed', 'failed', 'unknown'])))
      .limit(1);
    if (done) {
      const failed = done.status !== 'completed';
      return { response: done.result ?? '', latencyMs: Date.now() - start,
        metadata: { input: test.input, mode: 'companion_wake', wakeStatus: done.status, ...(failed ? { error: `Companion check-in ${done.status}: ${(done.result ?? '').slice(0, 200)}` } : {}) } };
    }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return { latencyMs: Date.now() - start, metadata: { input: test.input, mode: 'companion_wake',
    error: `No Companion check-in finished within ${Math.round(timeoutMs / 1000)}s: is the backend running with Companion enabled and a controller model bound?` } };
}

/**
 * Run a single eval test and return the result.
 */
export async function runTest(
  test: EvalTest,
  suiteId: string,
  options: EvalRunnerOptions = {},
  attempt = 1,
  timeoutMs = 120_000,
): Promise<EvalResult> {
  const model = options.model;
  const graderFn = options.graderModel ? createGraderFn(options.graderModel) : undefined;

  // ── Memory setup ───────────────────────────────────────────────────
  // Facts are written before the request and removed after it, whatever the
  // outcome — a fixture left behind would change what the NEXT test recalls.
  // A test that cannot be seeded is reported as a failed test with the reason,
  // never quietly run without its facts: that would score a setup problem as a
  // recall problem.
  const blocker = memorySetupBlocker(test.memorySetup, {
    integration: options.integration,
    userId: test.context?.userId,
  });
  if (blocker) return errorResult(test, suiteId, blocker);

  // Same refusal, for the same reason. Unit mode never spawns a specialist, so
  // it has no routing to observe; it used to answer `routes_to_role` from the
  // classifier's own topic, which is the function under test answering the
  // question about itself. Reported as a setup problem, loudly, rather than
  // scored either way — a green routing suite that never routed is worse than
  // no routing suite.
  const routingBlocker = routingObservabilityBlocker(test.assertions, options.integration)
    ?? toolUsageObservabilityBlocker(test.assertions, options.integration)
    ?? rendersObservabilityBlocker(test, options.integration)
    ?? stateObservabilityBlocker(test, options.integration);
  if (routingBlocker) return errorResult(test, suiteId, routingBlocker, attempt);

  const stateful = usesState(test);
  if (stateful) {
    const dbBlocker = await stateDatabase().catch((err: unknown) => `Could not open the database for end-state checks: ${(err as Error).message}`);
    if (dbBlocker) return errorResult(test, suiteId, dbBlocker, attempt);
  }

  const userId = test.context?.userId as string;
  const workspaceId = test.context?.workspaceId;
  let fixtures: InsertedFixtures = { refs: {}, created: [] };
  let page: Awaited<ReturnType<typeof serveFixture>> | undefined;
  let seededIds: string[] = [];
  let scope: StateScope | undefined;
  try {
    if (test.memorySetup?.length) seededIds = await seedMemories(userId, test.memorySetup);
    if (test.stateSetup?.length) fixtures = await insertFixtures(test.stateSetup, { userId, workspaceId });
    if (test.fixturePage) page = await serveFixture(resolve(options.evalDir ?? resolve(process.cwd(), 'eval'), test.fixturePage));
  } catch (err) {
    await teardown(test, { fixtures, page, seededIds });
    return errorResult(test, suiteId, (err as Error).message, attempt);
  }

  try {
    // Fixture rows carry an explicit created_at before this instant, so
    // `since: test` counts only what the turn did.
    if (stateful) scope = { userId, workspaceId, since: new Date(), refs: fixtures.refs };
    const input = page ? test.input.replaceAll('{{fixtureUrl}}', page.url) : test.input;
    const sessionRef = test.context?.sessionId?.startsWith('$') ? test.context.sessionId.slice(1) : undefined;
    const session = sessionRef ? fixtures.refs[sessionRef] : undefined;
    if (sessionRef && !session) return errorResult(test, suiteId, `context.sessionId $${sessionRef} names no fixture row`, attempt);

    // Execute the test
    let ctx: TestExecutionContext;
    if (test.trigger === 'companion_wake') ctx = await runCompanionWake(test, fixtures.refs, scope?.since ?? new Date(), timeoutMs);
    else if (options.integration) ctx = await runTestIntegration(test, options.baseUrl || 'http://localhost:3005', model, input, session);
    else ctx = await runTestUnit(test, model);

    // Seeded facts go before grading, as they always did: a fixture left
    // behind would change what the NEXT test recalls.
    if (seededIds.length) {
      await clearMemories(seededIds).catch((err: unknown) =>
        console.warn(`Failed to clear seeded memories for "${test.id}": ${(err as Error).message}`),
      );
      seededIds = [];
    }
    // Memory extraction and other post-turn work run after the reply.
    if (stateful && test.settleMs) await new Promise((ok) => setTimeout(ok, test.settleMs));

    // Add input to metadata for grader context
    ctx.metadata = { ...(ctx.metadata ?? {}), input };
    ctx.state = scope;

    // Evaluate all assertions
    const { results: assertionResults, score, passed, completed, unsafe } = await evaluateAllAssertions(
      test.assertions,
      ctx,
      graderFn,
    );

    return {
      suiteId,
      testId: test.id,
      input,
      output: ctx.response || '',
      assertions: assertionResults,
      passed,
      completed,
      unsafe,
      attempt,
      score,
      latencyMs: ctx.latencyMs,
      tokenCount: ctx.tokenCount,
      metadata: ctx.metadata,
      timestamp: new Date(),
    };
  } finally {
    await teardown(test, { fixtures, page, seededIds, scope });
  }
}

/**
 * Undo a test's setup whatever happened: seeded memories, rows the turn
 * created in `cleanup` tables, fixture rows, the fixture server. Failures are
 * reported, not thrown — the verdict is already decided — but never hidden.
 */
async function teardown(test: EvalTest, state: { fixtures: InsertedFixtures; page?: { close: () => Promise<void> }; seededIds: string[]; scope?: StateScope }) {
  const warn = (what: string) => (err: unknown) => console.warn(`Failed to ${what} for "${test.id}": ${(err as Error).message}`);
  if (state.seededIds.length) await clearMemories(state.seededIds).catch(warn('clear seeded memories'));
  if (test.cleanup?.length && state.scope) await cleanupCreated(test.cleanup, state.scope).catch(warn('clean up created rows'));
  if (state.fixtures.created.length) await removeFixtures(state.fixtures).catch(warn('remove fixture rows'));
  if (state.page) await state.page.close().catch(warn('stop the fixture server'));
}

/**
 * Why a routing assertion cannot be judged in this run, or undefined when it can.
 *
 * `routes_to_role` asks which specialist actually took the work. Only the
 * integration path spawns one, so unit mode has no answer — and the answer it
 * used to give was `classification.topic`, produced by the same classifier the
 * assertion is checking.
 */
export function routingObservabilityBlocker(
  assertions: EvalTest['assertions'],
  integration?: boolean,
): string | undefined {
  if (integration) return undefined;
  if (!assertions.some((a) => a.type === 'routes_to_role')) return undefined;
  return (
    'routes_to_role needs a running backend: unit mode never spawns a specialist, so there is no ' +
    'routing to observe. Re-run with --integration.'
  );
}

/**
 * Why a tool-usage assertion cannot be judged in this run, or undefined when
 * it can. Unit mode runs no tools; `not_uses_tool` used to pass there on an
 * empty list, which is the absence of an observation, not an observation.
 */
export function toolUsageObservabilityBlocker(
  assertions: EvalTest['assertions'],
  integration?: boolean,
): string | undefined {
  if (integration) return undefined;
  if (!assertions.some((a) => a.type === 'uses_tool' || a.type === 'not_uses_tool')) return undefined;
  return 'uses_tool / not_uses_tool need a running backend: unit mode runs no tools. Re-run with --integration.';
}

/**
 * Why a test of what a client renders cannot be judged in this run. Unit mode
 * asks the model without the root prompt, so it is never told it can write an
 * interactive answer: a "does not use one" case would pass on nothing.
 */
export function rendersObservabilityBlocker(test: Pick<EvalTest, 'context'>, integration?: boolean): string | undefined {
  if (integration || !test.context?.renders?.length) return undefined;
  return 'context.renders needs a running backend: unit mode never builds the root prompt that offers it. Re-run with --integration.';
}

/**
 * A test that could not be RUN. Reported as a failed result carrying the
 * reason, rather than thrown: one un-runnable test must not abort the suite,
 * and a setup problem has to be visible in the report next to the tests that
 * did run.
 */
function errorResult(test: EvalTest, suiteId: string, reason: string, attempt = 1): EvalResult {
  return {
    suiteId,
    testId: test.id,
    input: test.input,
    output: '',
    assertions: [{
      type: 'recalls_memory',
      passed: false,
      expected: 'test setup',
      actual: 'SETUP_ERROR',
      score: 0,
      message: reason,
      id: 'setup',
      kind: 'process',
      failure: 'incomplete',
    }],
    passed: false,
    completed: false,
    unsafe: [],
    attempt,
    score: 0,
    latencyMs: 0,
    metadata: { input: test.input, setupError: reason },
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

  // Every attempt of every test, attempts of one test adjacent in the results.
  const repeat = Math.max(1, Math.floor(options.repeat ?? 1));
  const jobs = tests.flatMap(test => Array.from({ length: repeat }, (_, i) => ({ test, attempt: i + 1 })));
  const results = await mapWithConcurrency(jobs, concurrency, ({ test, attempt }) =>
    runTest(test, suite.name, runOptions, attempt, suite.defaultTimeout ?? 120_000),
  );

  const passed = results.filter(r => r.passed).length;
  const totalScore = results.reduce((sum, r) => sum + r.score, 0);

  return {
    suite: suite.name,
    // Attempts, so passed + failed = totalTests still holds under --repeat;
    // per-test numbers are in `stats`.
    totalTests: results.length,
    passed,
    failed: results.length - passed,
    score: results.length > 0 ? totalScore / results.length : 0,
    results,
    stats: summarizeAttempts(suite.name, results, Math.max(1, Math.floor(options.k ?? repeat))),
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
