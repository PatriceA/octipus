import { mock } from 'bun:test';

// This is a pure unit suite: every dependency below is replaced via
// `mock.module`, which bun applies process-globally for the whole `bun test`
// run. Under the integration runner (INTEGRATION=1) those mocks add no coverage
// and leak into real-DB suites — e.g. the partial `model-registry` mock omits
// `registerModel`, breaking the topics/swarm-spawner integration tests. So make
// the global mocks no-ops and skip this suite when INTEGRATION=1; the unit pass
// (`bun test src scripts`, INTEGRATION unset) still runs it in full.
const inIntegration = process.env.INTEGRATION === '1';
const mockModule: typeof mock.module = inIntegration ? (() => {}) as typeof mock.module : mock.module;

// Set the env vars `loadConfig()` needs BEFORE importing anything that may
// touch `@/config`. We can't safely mock `@/config` itself: bun's
// `mock.module` is process-wide for the whole test run, so any partial mock
// here would leak into integration tests later in the same `bun test` run
// and break them (e.g. config.database.url ends up empty → postgres-js
// connects as the local OS user). Setting env vars is local: integration
// tests set their own DATABASE_URL/REDIS_URL via the test:integration
// runner before any test code runs.
process.env.MASTER_KEY ??= 'a'.repeat(32);
process.env.JWT_SECRET ??= 'b'.repeat(32);
process.env.SESSION_SECRET ??= 'c'.repeat(32);
process.env.LITELLM_PROXY_URL ??= 'http://localhost:4000';
process.env.LITELLM_API_KEY ??= 'test-key';

// Mock the provider router BEFORE importing evaluators (which import it transitively).
// This prevents any real network calls or config reads.
const mockComplete = async () => ({
  content: '{"score": 8, "reasoning": "Good response"}',
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  finishReason: 'stop',
  model: 'test',
  latencyMs: 100,
});

mockModule('@/models/providers', () => ({
  getProviderRouter: () => ({
    complete: mockComplete,
    stream: async function* () {},
    resolveProvider: async () => ({ name: 'test', type: 'direct', complete: mockComplete }),
  }),
}));

// Also mock model-registry to avoid DB access in llmJudge
mockModule('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getModelForTopic: async () => ({
      modelId: 'test-model',
      provider: 'test',
      metadata: { extraBody: {} },
    }),
    getDefaultModel: async () => ({
      modelId: 'test-model',
      provider: 'test',
      metadata: { extraBody: {} },
    }),
  }),
}));

import { describe, test, expect } from 'bun:test';
import {
  defineEvaluator,
  ALL_EVALUATORS,
} from './evaluators';

const describeUnit = inIntegration ? describe.skip : describe;
import type { EvalDataPoint } from './types';

// ── Helpers ───────────────────────────────────────────────────

function makeDataPoint(overrides: Partial<EvalDataPoint> = {}): EvalDataPoint {
  return {
    id: 'dp-1',
    input: 'What is 2+2?',
    output: 'The answer is 4.',
    model: 'test-model',
    provider: 'test',
    ...overrides,
  };
}

function getEvaluator(name: string) {
  const ev = ALL_EVALUATORS.find((e) => e.name === name);
  if (!ev) throw new Error(`Evaluator "${name}" not found in ALL_EVALUATORS`);
  return ev;
}

// ── defineEvaluator factory ───────────────────────────────────

describeUnit('defineEvaluator', () => {
  test('returns evaluator with correct name and description', () => {
    const ev = defineEvaluator('my-metric', 'A test metric', async () => ({
      metric: 'my-metric',
      score: 0.8,
      status: 'PASS',
    }));
    expect(ev.name).toBe('my-metric');
    expect(ev.description).toBe('A test metric');
    expect(typeof ev.evaluate).toBe('function');
  });

  test('evaluate function is the one passed to defineEvaluator', async () => {
    let called = false;
    const ev = defineEvaluator('test', 'desc', async (dp) => {
      called = true;
      return { metric: 'test', score: 1.0, status: 'PASS' };
    });
    await ev.evaluate(makeDataPoint());
    expect(called).toBe(true);
  });
});

// ── latency evaluator ─────────────────────────────────────────

describeUnit('latency evaluator', () => {
  const ev = getEvaluator('latency');

  test('<3000ms returns PASS with score 1.0', async () => {
    const dp = makeDataPoint({ latencyMs: 500 });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('PASS');
    expect(score.score).toBe(1.0);
    expect(score.metric).toBe('latency');
  });

  test('1500ms also returns PASS score 1.0', async () => {
    const dp = makeDataPoint({ latencyMs: 1500 });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('PASS');
    expect(score.score).toBe(1.0);
  });

  test('between 3000-10000ms returns PASS with score 0.7', async () => {
    const dp = makeDataPoint({ latencyMs: 5000 });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('PASS');
    expect(score.score).toBe(0.7);
  });

  test('between 10001-30000ms returns FAIL with score 0.4', async () => {
    const dp = makeDataPoint({ latencyMs: 15000 });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('FAIL');
    expect(score.score).toBe(0.4);
  });

  test('>30000ms returns FAIL with score 0.0', async () => {
    const dp = makeDataPoint({ latencyMs: 35000 });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('FAIL');
    expect(score.score).toBe(0.0);
  });

  test('missing latencyMs returns UNKNOWN status with score 0.5', async () => {
    const dp = makeDataPoint({ latencyMs: undefined });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('UNKNOWN');
    expect(score.score).toBe(0.5);
  });
});

// ── format-compliance evaluator ───────────────────────────────

describeUnit('format-compliance evaluator', () => {
  const ev = getEvaluator('format-compliance');

  test('JSON reference + valid JSON output returns PASS', async () => {
    const dp = makeDataPoint({
      reference: '{"key": "value"}',
      output: '{"result": "ok", "count": 3}',
    });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('PASS');
    expect(score.score).toBe(1.0);
  });

  test('JSON reference + invalid JSON output returns FAIL', async () => {
    const dp = makeDataPoint({
      reference: '{"key": "value"}',
      output: 'This is not valid JSON at all.',
    });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('FAIL');
    expect(score.score).toBe(0.0);
  });

  test('JSON array reference + valid JSON array output returns PASS', async () => {
    const dp = makeDataPoint({
      reference: '["red", "green", "blue"]',
      output: '["a", "b"]',
    });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('PASS');
    expect(score.score).toBe(1.0);
  });

  test('no reference returns PASS (no format expectation)', async () => {
    const dp = makeDataPoint({ reference: undefined });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('PASS');
    expect(score.score).toBe(1.0);
  });

  test('bullet reference + output with bullets returns PASS', async () => {
    const dp = makeDataPoint({
      reference: '- Item one\n- Item two',
      output: '- First thing\n- Second thing\n- Third thing',
    });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('PASS');
    expect(score.score).toBe(1.0);
  });

  test('bullet reference + plain-text output returns FAIL', async () => {
    const dp = makeDataPoint({
      reference: '- Item one\n- Item two',
      output: 'This is a plain paragraph with no bullet points.',
    });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('FAIL');
  });
});

// ── tool-accuracy evaluator ───────────────────────────────────

describeUnit('tool-accuracy evaluator', () => {
  const ev = getEvaluator('tool-accuracy');

  test('exact match: correct name, keys, and values returns score 1.0', async () => {
    const dp = makeDataPoint({
      expectedToolCall: { name: 'get_weather', args: { location: 'London', unit: 'celsius' } },
      actualToolCall: { name: 'get_weather', args: { location: 'London', unit: 'celsius' } },
    });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('PASS');
    expect(score.score).toBeCloseTo(1.0);
  });

  test('wrong tool name: score ~0.7 (keys/values still match)', async () => {
    const dp = makeDataPoint({
      expectedToolCall: { name: 'get_weather', args: { location: 'London' } },
      actualToolCall: { name: 'fetch_weather', args: { location: 'London' } },
    });
    const score = await ev.evaluate(dp);
    // Name mismatch (-0.3) but keys and values match (+0.3 +0.4) = 0.7
    expect(score.score).toBeCloseTo(0.7);
  });

  test('no actual tool call when one is expected: score 0.0, FAIL', async () => {
    const dp = makeDataPoint({
      expectedToolCall: { name: 'get_weather', args: { location: 'London' } },
      actualToolCall: undefined,
    });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('FAIL');
    expect(score.score).toBe(0.0);
  });

  test('no expected tool call: returns UNKNOWN with score 0.5', async () => {
    const dp = makeDataPoint({
      expectedToolCall: undefined,
      actualToolCall: undefined,
    });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('UNKNOWN');
    expect(score.score).toBe(0.5);
  });

  test('correct name and keys but wrong values: score 0.6', async () => {
    const dp = makeDataPoint({
      expectedToolCall: { name: 'add', args: { a: 5, b: 3 } },
      actualToolCall: { name: 'add', args: { a: 99, b: 0 } },
    });
    const score = await ev.evaluate(dp);
    // name: +0.3, keys: +0.3, values: +0.0 = 0.6
    expect(score.score).toBeCloseTo(0.6);
    expect(score.status).toBe('FAIL'); // below 0.7 threshold
  });

  test('completely wrong: wrong name, wrong keys, wrong values: low score', async () => {
    const dp = makeDataPoint({
      expectedToolCall: { name: 'get_weather', args: { location: 'London' } },
      actualToolCall: { name: 'send_email', args: { to: 'test@test.com', subject: 'hi' } },
    });
    const score = await ev.evaluate(dp);
    // name: 0, keys: 0 (0/1 match), values: 0 = 0.0
    expect(score.score).toBeLessThan(0.4);
    expect(score.status).toBe('FAIL');
  });

  test('correct name but no args expected: full score', async () => {
    const dp = makeDataPoint({
      expectedToolCall: { name: 'ping', args: {} },
      actualToolCall: { name: 'ping', args: {} },
    });
    const score = await ev.evaluate(dp);
    // name: +0.3, no args to check: +0.3 +0.4 = 1.0
    expect(score.score).toBeCloseTo(1.0);
    expect(score.status).toBe('PASS');
  });
});

// ── LLM-as-judge evaluators ───────────────────────────────────

describeUnit('LLM-as-judge evaluators (mocked provider)', () => {
  // These tests verify the evaluators do not crash and return structurally valid scores.
  // The mocked provider router returns { score: 8, reasoning: "Good response" }.
  // Normalized score = 8/10 = 0.8 → PASS.

  const llmEvaluatorNames = ['relevance', 'faithfulness', 'coherence', 'instruction-following', 'completeness'];

  for (const name of llmEvaluatorNames) {
    test(`${name}: does not crash, returns valid score structure`, async () => {
      const ev = getEvaluator(name);
      const dp = makeDataPoint({
        systemPrompt: 'Be concise.',
        constraints: ['No profanity'],
        context: ['Some relevant context.'],
      });
      const score = await ev.evaluate(dp);
      expect(score.metric).toBe(name);
      expect(typeof score.score).toBe('number');
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(1);
      expect(['PASS', 'FAIL', 'UNKNOWN']).toContain(score.status);
    });
  }

  test('faithfulness with no context returns UNKNOWN with -1 (non-applicable)', async () => {
    const ev = getEvaluator('faithfulness');
    const dp = makeDataPoint({ context: undefined });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('UNKNOWN');
    expect(score.score).toBe(-1);
  });

  test('instruction-following with no system prompt and no constraints returns UNKNOWN', async () => {
    const ev = getEvaluator('instruction-following');
    const dp = makeDataPoint({ systemPrompt: undefined, constraints: undefined });
    const score = await ev.evaluate(dp);
    expect(score.status).toBe('UNKNOWN');
  });

  test('mocked judge score 8/10 normalizes to 0.8 → PASS for relevance', async () => {
    const ev = getEvaluator('relevance');
    const dp = makeDataPoint();
    const score = await ev.evaluate(dp);
    expect(score.score).toBeCloseTo(0.8);
    expect(score.status).toBe('PASS');
  });
});

// ── ALL_EVALUATORS registry ───────────────────────────────────

describeUnit('ALL_EVALUATORS', () => {
  test('contains at least 5 evaluators', () => {
    expect(ALL_EVALUATORS.length).toBeGreaterThanOrEqual(5);
  });

  test('each evaluator has name, description, and evaluate function', () => {
    for (const ev of ALL_EVALUATORS) {
      expect(typeof ev.name).toBe('string');
      expect(ev.name.length).toBeGreaterThan(0);
      expect(typeof ev.description).toBe('string');
      expect(typeof ev.evaluate).toBe('function');
    }
  });

  test('evaluator names are unique', () => {
    const names = ALL_EVALUATORS.map((e) => e.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test('includes expected standard evaluator names', () => {
    const names = ALL_EVALUATORS.map((e) => e.name);
    expect(names).toContain('latency');
    expect(names).toContain('format-compliance');
    expect(names).toContain('tool-accuracy');
    expect(names).toContain('relevance');
  });
});
