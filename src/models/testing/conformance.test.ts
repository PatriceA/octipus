import { describe, expect, test } from 'vitest';
import {
  runConformanceTests,
  capabilitiesFromModel,
  getTestCaseNames,
  getTestCases,
  type ConformanceReport,
  type ModelCapabilities,
} from './conformance';
import type { LiteLLMClient } from '../litellm-client';
import type { ModelProvider } from '../providers/interface';
import type { ModelConfigEntry } from '@/db/schema/models';

// ── Fixtures ──────────────────────────────────────────────────

function makeModel(overrides: Partial<ModelConfigEntry> = {}): ModelConfigEntry {
  return {
    id: 'test-id',
    name: 'Test Model',
    provider: 'test',
    modelId: 'test-model',
    endpoint: null,
    apiKeyRef: null,
    maxTokens: 4096,
    contextWindow: 128000,
    supportsVision: false,
    supportsTools: true,
    supportsStreaming: true,
    defaultTemperature: 0.7,
    defaultTopP: 1.0,
    defaultMaxTokens: 4096,
    topics: [],
    priority: 0,
    topicRoles: {},
    costPerInputToken: 0,
    costPerOutputToken: 0,
    isEnabled: true,
    isDefault: false,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ModelConfigEntry;
}

/** A mock LiteLLMClient that returns canned responses for complete(). */
function makeMockClient(
  completeImpl?: (opts: any) => Promise<any>,
): LiteLLMClient {
  const defaultComplete = async () => ({
    content: '4',
    toolCalls: undefined,
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: 'test-model',
    latencyMs: 100,
  });

  return {
    complete: completeImpl ?? defaultComplete,
    stream: async function* () { /* noop */ },
    embed: async () => [[0.1, 0.2, 0.3]],
    completeVision: async () => ({
      content: 'A red pixel.',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: 'test-model',
      latencyMs: 100,
    }),
  } as unknown as LiteLLMClient;
}

/** A minimal mock ModelProvider.
 * Default content is "4" so it matches the basic-completion math question
 * ("What is 2+2?") by default — tests that need a failing response override
 * this (e.g. the "fails when response does not contain 4" test below).
 */
function makeMockProvider(name = 'test', content = '4'): ModelProvider {
  return {
    name,
    type: 'direct',
    supportsModel: () => true,
    complete: async () => ({
      content,
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: 'test-model',
      latencyMs: 100,
    }),
    stream: async function* () {},
    checkHealth: async () => ({ healthy: true }),
  } as unknown as ModelProvider;
}

// ── capabilitiesFromModel ──────────────────────────────────────

describe('capabilitiesFromModel', () => {
  test('embedding model: embeddings=true, multiturn=false, tools=false', () => {
    const model = makeModel({ topics: ['embedding'], supportsTools: false, supportsStreaming: false });
    const caps = capabilitiesFromModel(model);
    expect(caps.embeddings).toBe(true);
    expect(caps.multiturn).toBe(false);
    expect(caps.systemRole).toBe(false);
    expect(caps.tools).toBe(false);
  });

  test('chat model: multiturn=true, tools from supportsTools, media from supportsVision', () => {
    const model = makeModel({ supportsTools: true, supportsStreaming: true, supportsVision: true });
    const caps = capabilitiesFromModel(model);
    expect(caps.multiturn).toBe(true);
    expect(caps.systemRole).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.media).toBe(true);
    expect(caps.streaming).toBe(true);
  });

  test('model with supportsTools=false: tools=false', () => {
    const model = makeModel({ supportsTools: false });
    const caps = capabilitiesFromModel(model);
    expect(caps.tools).toBe(false);
    expect(caps.structuredOutput).toBe(false);
  });
});

// ── getTestCaseNames / getTestCases ───────────────────────────

describe('getTestCaseNames', () => {
  test('returns a non-empty array of strings', () => {
    const names = getTestCaseNames();
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(typeof n).toBe('string');
    }
  });

  test('includes expected test names', () => {
    const names = getTestCaseNames();
    expect(names).toContain('basic-completion');
    expect(names).toContain('tool-calling');
    expect(names).toContain('streaming');
    expect(names).toContain('embeddings');
  });
});

describe('getTestCases', () => {
  test('each test case has name, description, and run function', () => {
    const cases = getTestCases();
    for (const tc of cases) {
      expect(typeof tc.name).toBe('string');
      expect(typeof tc.description).toBe('string');
      expect(typeof tc.run).toBe('function');
    }
  });
});

// ── runConformanceTests ───────────────────────────────────────

describe('runConformanceTests', () => {
  test('report has correct structure (timestamp, results, summary)', async () => {
    const model = makeModel({ provider: 'test' });
    const client = makeMockClient();
    const providers = new Map([['test', makeMockProvider('test')]]);

    // Run only basic-completion to keep the test fast
    const report = await runConformanceTests(client, [model], providers, {
      tests: ['basic-completion'],
    });

    expect(typeof report.timestamp).toBe('string');
    expect(Array.isArray(report.results)).toBe(true);
    expect(typeof report.summary).toBe('object');
    expect(typeof report.summary.total).toBe('number');
    expect(typeof report.summary.passed).toBe('number');
    expect(typeof report.summary.failed).toBe('number');
    expect(typeof report.summary.skipped).toBe('number');
    expect(typeof report.summary.durationMs).toBe('number');
  });

  test('basic-completion passes when response contains "4"', async () => {
    const model = makeModel({ provider: 'test' });
    const client = makeMockClient(async () => ({
      content: '4',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      model: 'test-model',
      latencyMs: 50,
    }));
    // Provider must also return '4' since non-litellm models route through provider.complete()
    const providers = new Map([['test', makeMockProvider('test', '4')]]);

    const report = await runConformanceTests(client, [model], providers, {
      tests: ['basic-completion'],
    });

    const result = report.results.find((r) => r.test === 'basic-completion');
    expect(result).toBeDefined();
    expect(result!.status).toBe('passed');
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(0);
  });

  test('basic-completion fails when response does not contain "4"', async () => {
    const model = makeModel({ provider: 'test' });
    const client = makeMockClient(async () => ({
      content: 'I do not know.',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: 'test-model',
      latencyMs: 50,
    }));
    // Provider must also return a failing content since non-litellm models
    // route through provider.complete() (not the litellm client).
    const providers = new Map([['test', makeMockProvider('test', 'I do not know.')]]);

    const report = await runConformanceTests(client, [model], providers, {
      tests: ['basic-completion'],
    });

    const result = report.results.find((r) => r.test === 'basic-completion');
    expect(result!.status).toBe('failed');
    expect(result!.error).toBeDefined();
    expect(report.summary.failed).toBe(1);
  });

  test('capability gating: tool-calling is skipped when supportsTools=false', async () => {
    const model = makeModel({ provider: 'test', supportsTools: false });
    const client = makeMockClient();
    const providers = new Map([['test', makeMockProvider()]]);

    const report = await runConformanceTests(client, [model], providers, {
      tests: ['tool-calling'],
    });

    const result = report.results.find((r) => r.test === 'tool-calling');
    expect(result).toBeDefined();
    expect(result!.status).toBe('skipped');
    expect(report.summary.skipped).toBe(1);
  });

  test('capability gating: streaming is skipped when supportsStreaming=false', async () => {
    const model = makeModel({ provider: 'test', supportsStreaming: false });
    const client = makeMockClient();
    const providers = new Map([['test', makeMockProvider()]]);

    const report = await runConformanceTests(client, [model], providers, {
      tests: ['streaming'],
    });

    const result = report.results.find((r) => r.test === 'streaming');
    expect(result!.status).toBe('skipped');
  });

  test('provider not found: all tests skipped with explanation', async () => {
    const model = makeModel({ provider: 'missing' });
    const client = makeMockClient();
    const providers = new Map<string, ModelProvider>(); // empty

    const report = await runConformanceTests(client, [model], providers, {
      tests: ['basic-completion'],
    });

    const result = report.results.find((r) => r.test === 'basic-completion');
    expect(result!.status).toBe('skipped');
    expect(result!.details).toContain('No provider instance');
  });

  test('provider in skip list: all tests marked skipped', async () => {
    const model = makeModel({ provider: 'test' });
    const client = makeMockClient();
    const providers = new Map([['test', makeMockProvider()]]);

    const report = await runConformanceTests(client, [model], providers, {
      tests: ['basic-completion'],
      skipProviders: ['test'],
    });

    const result = report.results.find((r) => r.test === 'basic-completion');
    expect(result!.status).toBe('skipped');
    expect(result!.details).toContain('skip list');
  });

  test('error handling: provider that throws results in "failed", not a crash', async () => {
    const model = makeModel({ provider: 'test' });
    const client = makeMockClient();
    // Provider throws — since non-litellm models route through provider.complete()
    const throwingProvider = {
      ...makeMockProvider(),
      complete: async () => { throw new Error('Simulated provider failure'); },
    } as unknown as ModelProvider;
    const providers = new Map([['test', throwingProvider]]);

    // Should not throw
    const report = await runConformanceTests(client, [model], providers, {
      tests: ['basic-completion'],
    });

    const result = report.results.find((r) => r.test === 'basic-completion');
    expect(result!.status).toBe('failed');
    expect(result!.error).toContain('Simulated provider failure');
  });

  test('timeout handling: slow provider results in failure with timeout message', async () => {
    const model = makeModel({ provider: 'test' });
    const client = makeMockClient();
    // Provider is slow — since non-litellm models route through provider.complete()
    const slowProvider = {
      ...makeMockProvider(),
      complete: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          content: '4',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          model: 'test-model',
          latencyMs: 200,
        };
      },
    } as unknown as ModelProvider;
    const providers = new Map([['test', slowProvider]]);

    // Set an aggressive timeout of 50ms so the provider times out
    const report = await runConformanceTests(client, [model], providers, {
      tests: ['basic-completion'],
      timeout: 50,
    });

    const result = report.results.find((r) => r.test === 'basic-completion');
    expect(result!.status).toBe('failed');
    expect(result!.error).toContain('timed out');
  }, 5000);

  test('summary counts match individual result statuses', async () => {
    // One model with tools capability, one without — so tool-calling will pass and skip
    const modelWithTools = makeModel({ provider: 'test', modelId: 'model-a', name: 'Model A' });
    const modelNoTools = makeModel({
      provider: 'test',
      modelId: 'model-b',
      name: 'Model B',
      supportsTools: false,
    });
    const client = makeMockClient();
    const providers = new Map([['test', makeMockProvider()]]);

    const report = await runConformanceTests(
      client,
      [modelWithTools, modelNoTools],
      providers,
      { tests: ['basic-completion', 'tool-calling'] },
    );

    const passed = report.results.filter((r) => r.status === 'passed').length;
    const failed = report.results.filter((r) => r.status === 'failed').length;
    const skipped = report.results.filter((r) => r.status === 'skipped').length;

    expect(report.summary.passed).toBe(passed);
    expect(report.summary.failed).toBe(failed);
    expect(report.summary.skipped).toBe(skipped);
    expect(report.summary.total).toBe(passed + failed + skipped);
  });

  test('empty model list returns report with zero results', async () => {
    const client = makeMockClient();
    const providers = new Map<string, ModelProvider>();

    const report = await runConformanceTests(client, [], providers);

    expect(report.results).toHaveLength(0);
    expect(report.summary.total).toBe(0);
    expect(report.summary.passed).toBe(0);
  });

  test('result includes latencyMs for passed tests', async () => {
    const model = makeModel({ provider: 'test' });
    const client = makeMockClient();
    const providers = new Map([['test', makeMockProvider()]]);

    const report = await runConformanceTests(client, [model], providers, {
      tests: ['basic-completion'],
    });

    const result = report.results.find((r) => r.test === 'basic-completion');
    expect(result!.latencyMs).toBeDefined();
    expect(result!.latencyMs!).toBeGreaterThanOrEqual(0);
  });
});
