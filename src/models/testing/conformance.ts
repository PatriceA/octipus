/**
 * Model conformance test suite.
 *
 * Validates that each provider works correctly by running a battery of
 * tests covering basic completion, streaming, multi-turn, tool calling,
 * structured output, vision, embeddings, and error handling.
 */

import type { LiteLLMClient, StreamChunk } from '../litellm-client';
import type { ModelProvider } from '../providers/interface';
import type { ModelConfigEntry } from '@/db/schema/models';
import type { AgentMessage } from '@/core/types';
import {
  PROMPTS,
  ADD_NUMBERS_TOOL,
  TINY_RED_PNG_BASE64,
  validateBasicCompletion,
  validateMultiTurn,
  validateFrenchResponse,
  validateToolCall,
  validateJSON,
  validateEmbeddings,
} from './test-fixtures';

// ── Types ─────────────────────────────────────────────────────

/**
 * Capability flags derived from the model's DB fields.
 * We define this inline so the conformance suite has no dependency
 * on a separate capabilities module that may not exist yet.
 */
export interface ModelCapabilities {
  streaming: boolean;
  multiturn: boolean;
  systemRole: boolean;
  tools: boolean;
  structuredOutput: boolean;
  media: boolean;       // vision
  embeddings: boolean;
}

export interface ConformanceTestCase {
  name: string;
  description: string;
  /** If set, the test is skipped when this capability is false */
  requiredCapability?: keyof ModelCapabilities;
  run: (ctx: TestContext) => Promise<void>;
}

export interface TestContext {
  client: LiteLLMClient;
  model: ModelConfigEntry;
  provider: ModelProvider;
  capabilities: ModelCapabilities;
  /** Always { think: true } — evaluations/tests should use reasoning */
  extraBody: Record<string, unknown>;
}

export interface ConformanceResult {
  model: string;
  provider: string;
  test: string;
  status: 'passed' | 'failed' | 'skipped';
  latencyMs?: number;
  error?: string;
  details?: string;
}

export interface ConformanceReport {
  timestamp: string;
  results: ConformanceResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
  };
}

// ── Helpers ───────────────────────────────────────────────────

function msg(role: 'system' | 'user' | 'assistant' | 'tool', content: string, extra?: Partial<AgentMessage>): AgentMessage {
  return { role, content, timestamp: new Date(), ...extra };
}

/**
 * Derive capabilities from model DB fields.
 * Most models support multi-turn and system role by default.
 */
export function capabilitiesFromModel(model: ModelConfigEntry): ModelCapabilities {
  const isEmbeddingModel = (model.topics ?? []).includes('embedding');
  return {
    streaming: model.supportsStreaming,
    multiturn: !isEmbeddingModel,
    systemRole: !isEmbeddingModel,
    tools: model.supportsTools,
    structuredOutput: model.supportsTools, // JSON mode usually available when tools are
    media: model.supportsVision,
    embeddings: isEmbeddingModel,
  };
}

// ── Test Cases ────────────────────────────────────────────────

const testCases: ConformanceTestCase[] = [
  // 1. Basic completion
  {
    name: 'basic-completion',
    description: 'Send "What is 2+2?" and verify response contains "4"',
    async run(ctx) {
      const result = await ctx.client.complete({
        model: ctx.model.modelId,
        messages: [msg('user', PROMPTS.basicCompletion)],
        temperature: 0,
        maxTokens: 64,
        extraBody: ctx.extraBody,
      });

      const v = validateBasicCompletion(result.content);
      if (!v.pass) throw new Error(v.detail);
    },
  },

  // 2. Streaming
  {
    name: 'streaming',
    description: 'Stream a response and verify multiple chunks arrive',
    requiredCapability: 'streaming',
    async run(ctx) {
      const chunks: StreamChunk[] = [];
      const gen = ctx.client.stream({
        model: ctx.model.modelId,
        messages: [msg('user', 'Count from 1 to 5, one number per line.')],
        temperature: 0,
        maxTokens: 128,
      });

      for await (const chunk of gen) {
        chunks.push(chunk);
      }

      if (chunks.length < 2) {
        throw new Error(`Expected multiple chunks, got ${chunks.length}`);
      }

      const hasFinish = chunks.some((c) => !!c.finishReason);
      if (!hasFinish) {
        throw new Error('No chunk with finishReason received');
      }

      const content = chunks
        .filter((c) => c.content)
        .map((c) => c.content)
        .join('');
      if (!content || content.length < 3) {
        throw new Error(`Stream content too short: "${content}"`);
      }
    },
  },

  // 3. Multi-turn
  {
    name: 'multi-turn',
    description: 'Two-turn conversation testing context retention',
    requiredCapability: 'multiturn',
    async run(ctx) {
      // First turn
      const first = await ctx.client.complete({
        model: ctx.model.modelId,
        messages: [msg('user', PROMPTS.multiTurnFirst)],
        temperature: 0,
        maxTokens: 128,
        extraBody: ctx.extraBody,
      });

      // Second turn includes history
      const result = await ctx.client.complete({
        model: ctx.model.modelId,
        messages: [
          msg('user', PROMPTS.multiTurnFirst),
          msg('assistant', first.content),
          msg('user', PROMPTS.multiTurnSecond),
        ],
        temperature: 0,
        maxTokens: 128,
        extraBody: ctx.extraBody,
      });

      const v = validateMultiTurn(result.content);
      if (!v.pass) throw new Error(v.detail);
    },
  },

  // 4. System prompt
  {
    name: 'system-prompt',
    description: 'System prompt instructs French; verify response is in French',
    requiredCapability: 'systemRole',
    async run(ctx) {
      const result = await ctx.client.complete({
        model: ctx.model.modelId,
        messages: [
          msg('system', PROMPTS.systemPromptFrench),
          msg('user', PROMPTS.systemPromptFrenchUser),
        ],
        temperature: 0,
        maxTokens: 256,
        extraBody: ctx.extraBody,
      });

      const v = validateFrenchResponse(result.content);
      if (!v.pass) throw new Error(v.detail);
    },
  },

  // 5. Tool calling
  {
    name: 'tool-calling',
    description: 'Define add_numbers tool, ask to add 5+3, verify tool_call',
    requiredCapability: 'tools',
    async run(ctx) {
      const result = await ctx.client.complete({
        model: ctx.model.modelId,
        messages: [msg('user', PROMPTS.toolCalling)],
        tools: [ADD_NUMBERS_TOOL],
        temperature: 0,
        maxTokens: 256,
        extraBody: ctx.extraBody,
      });

      const v = validateToolCall(result.toolCalls);
      if (!v.pass) throw new Error(v.detail);
    },
  },

  // 6. Tool result handling
  {
    name: 'tool-result-handling',
    description: 'Send tool call + tool result messages, verify model incorporates result',
    requiredCapability: 'tools',
    async run(ctx) {
      const toolCallId = 'call_test_001';
      const messages: AgentMessage[] = [
        msg('user', 'What is 5 + 3?'),
        msg('assistant', '', {
          toolCalls: [{ id: toolCallId, name: 'add_numbers', arguments: { a: 5, b: 3 } }],
        }),
        msg('tool', JSON.stringify({ result: 8 }), { toolCallId }),
      ];

      const result = await ctx.client.complete({
        model: ctx.model.modelId,
        messages,
        tools: [ADD_NUMBERS_TOOL],
        temperature: 0,
        maxTokens: 128,
        extraBody: ctx.extraBody,
      });

      // Model should produce a text response mentioning 8
      if (!result.content || result.content.length === 0) {
        throw new Error('No text response after tool result');
      }
      if (!/8/.test(result.content)) {
        throw new Error(`Expected "8" in response after tool result, got: "${result.content.slice(0, 200)}"`);
      }
    },
  },

  // 7. Structured output (JSON mode)
  {
    name: 'structured-output',
    description: 'Request JSON mode, verify response is valid JSON',
    requiredCapability: 'structuredOutput',
    async run(ctx) {
      const result = await ctx.client.complete({
        model: ctx.model.modelId,
        messages: [msg('user', PROMPTS.structuredOutput)],
        responseFormat: { type: 'json_object' },
        temperature: 0,
        maxTokens: 256,
        extraBody: ctx.extraBody,
      });

      const v = validateJSON(result.content);
      if (!v.pass) throw new Error(v.detail);
    },
  },

  // 8. Vision
  {
    name: 'vision',
    description: 'Send tiny test image, verify non-empty response',
    requiredCapability: 'media',
    async run(ctx) {
      const result = await ctx.client.completeVision({
        model: ctx.model.modelId,
        prompt: PROMPTS.vision,
        imageBase64: TINY_RED_PNG_BASE64,
        mimeType: 'image/png',
        maxTokens: 256,
      });

      if (!result.content || result.content.trim().length === 0) {
        throw new Error('Vision response is empty');
      }
    },
  },

  // 9. Embeddings
  {
    name: 'embeddings',
    description: 'Call embed() and verify number[][] with correct dimensionality',
    requiredCapability: 'embeddings',
    async run(ctx) {
      const embeddings = await ctx.client.embed(['Hello world', 'Test embedding'], ctx.model.modelId);
      const v = validateEmbeddings(embeddings);
      if (!v.pass) throw new Error(v.detail);
    },
  },

  // 10. Error handling
  {
    name: 'error-handling',
    description: 'Send request with invalid model name, verify error (not crash/hang)',
    async run(ctx) {
      const bogusModel = 'nonexistent-model-xyz-12345';
      let threw = false;
      try {
        await ctx.client.complete({
          model: bogusModel,
          messages: [msg('user', 'test')],
          maxTokens: 16,
        extraBody: ctx.extraBody,
        });
      } catch {
        threw = true;
      }

      if (!threw) {
        throw new Error('Expected error for invalid model name, but request succeeded');
      }
    },
  },
];

// ── Runner ────────────────────────────────────────────────────

export interface RunConformanceOptions {
  /** Only run these test names */
  tests?: string[];
  /** Per-test timeout in ms (default 30000) */
  timeout?: number;
  /** Skip these provider names */
  skipProviders?: string[];
}

/**
 * Run the conformance test suite against one or more models.
 */
export async function runConformanceTests(
  client: LiteLLMClient,
  models: ModelConfigEntry[],
  providers: Map<string, ModelProvider>,
  options?: RunConformanceOptions,
): Promise<ConformanceReport> {
  const timeout = options?.timeout ?? 30_000;
  const selectedTests = options?.tests;
  // Always skip CLI providers — they run as subprocesses, not API calls
  const skipProviders = new Set([...(options?.skipProviders ?? []), 'cli']);

  const results: ConformanceResult[] = [];
  const overallStart = Date.now();

  for (const model of models) {
    if (skipProviders.has(model.provider)) {
      // Record all tests as skipped for this model
      for (const tc of testCases) {
        if (selectedTests && !selectedTests.includes(tc.name)) continue;
        results.push({
          model: model.modelId,
          provider: model.provider,
          test: tc.name,
          status: 'skipped',
          details: `Provider "${model.provider}" is in skip list`,
        });
      }
      continue;
    }

    const provider = providers.get(model.provider);
    if (!provider) {
      for (const tc of testCases) {
        if (selectedTests && !selectedTests.includes(tc.name)) continue;
        results.push({
          model: model.modelId,
          provider: model.provider,
          test: tc.name,
          status: 'skipped',
          details: `No provider instance for "${model.provider}"`,
        });
      }
      continue;
    }

    const capabilities = capabilitiesFromModel(model);

    // Always enable thinking for tests — models perform better with reasoning
    const modelExtra = (model.metadata as any)?.extraBody ?? {};
    const extraBody = { ...modelExtra, think: true };
    const ctx: TestContext = { client, model, provider, capabilities, extraBody };

    for (const tc of testCases) {
      if (selectedTests && !selectedTests.includes(tc.name)) continue;

      // Check required capability
      if (tc.requiredCapability && !capabilities[tc.requiredCapability]) {
        results.push({
          model: model.modelId,
          provider: model.provider,
          test: tc.name,
          status: 'skipped',
          details: `Requires capability "${tc.requiredCapability}" which is false`,
        });
        continue;
      }

      // Run test with timeout
      const testStart = Date.now();
      console.log(`  [${model.name}] ${tc.name} ...`);

      try {
        await Promise.race([
          tc.run(ctx),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Test timed out after ${timeout}ms`)), timeout),
          ),
        ]);

        const latencyMs = Date.now() - testStart;
        results.push({
          model: model.modelId,
          provider: model.provider,
          test: tc.name,
          status: 'passed',
          latencyMs,
        });
        console.log(`  [${model.name}] ${tc.name} PASSED (${latencyMs}ms)`);
      } catch (err) {
        const latencyMs = Date.now() - testStart;
        const errorMsg = err instanceof Error ? err.message : String(err);
        results.push({
          model: model.modelId,
          provider: model.provider,
          test: tc.name,
          status: 'failed',
          latencyMs,
          error: errorMsg,
        });
        console.log(`  [${model.name}] ${tc.name} FAILED (${latencyMs}ms): ${errorMsg}`);
      }
    }
  }

  const durationMs = Date.now() - overallStart;
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    durationMs,
  };

  return {
    timestamp: new Date().toISOString(),
    results,
    summary,
  };
}

/** Get all registered test case names */
export function getTestCaseNames(): string[] {
  return testCases.map((tc) => tc.name);
}

/** Get all test cases (for external inspection) */
export function getTestCases(): readonly ConformanceTestCase[] {
  return testCases;
}
