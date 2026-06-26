import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { randomBytes } from 'node:crypto';

// Pure unit suite: every dependency is replaced via `mock.module`, which bun
// applies process-globally for the whole `bun test` run. Under the integration
// runner (INTEGRATION=1) those mocks add no coverage and leak into real-DB
// suites — the partial `model-registry` mock omits `registerModel`, breaking
// the topics/swarm-spawner integration tests. So no-op the global mocks and
// skip this suite when INTEGRATION=1; the unit pass (INTEGRATION unset) runs it
// in full.
const inIntegration = process.env.INTEGRATION === '1';
const mockModule: typeof mock.module = inIntegration ? (() => {}) as typeof mock.module : mock.module;
const describeUnit = inIntegration ? describe.skip : describe;
import { ClassifiedError } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';

// Bun's mock.module is process-global. To avoid polluting unrelated suites
// in the same `bun test` run, every mock here is built as a SPREAD of the
// real module so its other exports remain intact, and afterAll re-mocks
// each path back to the captured real module.
//
// Logger and config are NOT mocked — we use the real ones with env-derived
// values, since they're imported transitively by half the codebase.

process.env.LOG_LEVEL ??= 'error';
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/octipus_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
const PROXY_URL = 'http://litellm.test:4000';
process.env.LITELLM_URL = PROXY_URL;
process.env.LITELLM_API_KEY = 'sk-test';
process.env.LITELLM_TIMEOUT = '5000';
process.env.LITELLM_MAX_RETRIES = '0';

// Capture real modules for spread-mocking and afterAll restoration.
const realProviders = await import('@/models/providers');
const realRegistry = await import('@/models/model-registry');
const realOpenAIMod = await import('openai');
const realConfig = await import('@/config');

// ── Mocks ────────────────────────────────────────────────────────────

// OpenAI SDK mock — every instance dispatches to the same controllable handlers.
type ChatCreateImpl = (params: any) => any;
const openaiConstructorCalls: any[] = [];
const chatCreateImpl: { current: ChatCreateImpl } = {
  current: () => { throw new Error('chatCreateImpl.current not set'); },
};
const embeddingsCreateImpl: { current: (params: any) => any } = {
  current: () => { throw new Error('embeddingsCreateImpl.current not set'); },
};
const modelsListImpl: { current: () => any } = {
  current: () => { throw new Error('modelsListImpl.current not set'); },
};

mockModule('openai', () => {
  class FakeOpenAI {
    chat: any; embeddings: any; models: any;
    constructor(opts: any) {
      openaiConstructorCalls.push(opts);
      this.chat = { completions: { create: (p: any) => chatCreateImpl.current(p) } };
      this.embeddings = { create: (p: any) => embeddingsCreateImpl.current(p) };
      this.models = { list: () => modelsListImpl.current() };
    }
  }
  return { ...realOpenAIMod, default: FakeOpenAI };
});

// Provider router mock
type FakeProvider = {
  name: string;
  type?: string;
  complete?: (o: any) => Promise<any>;
  stream?: (o: any) => AsyncGenerator<any>;
  embed?: (input: string[], model: string, endpoint?: string) => Promise<number[][]>;
};
const routerState: {
  resolveProvider: FakeProvider;
  getProvider: FakeProvider | (() => never);
  getAllProviders: FakeProvider[];
  routerStream: ((o: any) => AsyncGenerator<any>) | null;
} = {
  resolveProvider: { name: 'litellm' },
  getProvider: { name: 'litellm' },
  getAllProviders: [],
  routerStream: null,
};

mockModule('@/models/providers', () => ({
  ...realProviders,
  getProviderRouter: () => ({
    resolveProvider: async (_m: string) => routerState.resolveProvider,
    getProvider: (_m: string) => {
      const g = routerState.getProvider;
      if (typeof g === 'function') return (g as () => never)();
      return g;
    },
    getAllProviders: () => routerState.getAllProviders,
    stream: routerState.routerStream
      ? routerState.routerStream
      : async function* () {},
  }),
}));

// Model registry mock
const registryState: {
  byModelId: Record<string, any>;
  forTopic: Record<string, any>;
} = { byModelId: {}, forTopic: {} };

mockModule('@/models/model-registry', () => ({
  ...realRegistry,
  getModelRegistry: () => ({
    getModelByModelId: async (id: string) => registryState.byModelId[id] ?? null,
    getModelForTopic: async (t: string) => registryState.forTopic[t] ?? null,
  }),
}));

// Vault is NOT mocked. bun's mock.module is process-global and replacing
// `@/security/vault` would break unrelated suites that call initializeVault()
// / getVault().store(...). Vault-resolved apiKey paths therefore stay
// untested; the caller-supplied apiKey path is exercised instead.

// ── SUT (imported after mocks are registered) ────────────────────────

const {
  LiteLLMClient,
  getLiteLLMClient,
  resetLiteLLMClient,
} = await import('./litellm-client');

// ── Test helpers ─────────────────────────────────────────────────────

const ts = () => new Date(0);
const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: ts() });

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => i < items.length
          ? { value: items[i++], done: false }
          : { value: undefined as unknown as T, done: true },
      };
    },
  };
}

function chatCompletion(opts: {
  content?: string;
  finishReason?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string; type?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
  noChoices?: boolean;
}) {
  return {
    id: 'cc-1',
    object: 'chat.completion',
    created: 0,
    model: opts.model ?? 'gpt-4',
    choices: opts.noChoices ? [] : [{
      index: 0,
      message: {
        role: 'assistant',
        content: opts.content ?? null,
        ...(opts.toolCalls ? {
          tool_calls: opts.toolCalls.map(tc => ({
            id: tc.id,
            type: tc.type ?? 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        } : {}),
      },
      finish_reason: opts.finishReason ?? 'stop',
    }],
    usage: {
      prompt_tokens: opts.usage?.prompt_tokens ?? 1,
      completion_tokens: opts.usage?.completion_tokens ?? 1,
      total_tokens: opts.usage?.total_tokens ?? 2,
    },
  };
}

function resetState() {
  openaiConstructorCalls.length = 0;
  routerState.resolveProvider = { name: 'litellm' };
  routerState.getProvider = { name: 'litellm' };
  routerState.getAllProviders = [];
  routerState.routerStream = null;
  for (const k of Object.keys(registryState.byModelId)) delete registryState.byModelId[k];
  for (const k of Object.keys(registryState.forTopic)) delete registryState.forTopic[k];
  chatCreateImpl.current = () => { throw new Error('chatCreateImpl not set'); };
  embeddingsCreateImpl.current = () => { throw new Error('embeddingsCreateImpl not set'); };
  modelsListImpl.current = () => { throw new Error('modelsListImpl not set'); };
  resetLiteLLMClient();
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => resetState());

afterAll(() => {
  // mock.module is process-global and cannot truly restore mid-run. We
  // re-register defensively so any module re-imported after this point at
  // least sees a factory that returns the real exports.
  mockModule('@/models/providers', () => realProviders);
  mockModule('@/models/model-registry', () => realRegistry);
  mockModule('openai', () => realOpenAIMod);
  // Several tests here call resetConfig(), leaving the config cache cleared (or
  // loaded from a temporarily mutated env). Reset once more so the *next* test
  // file in the same worker re-derives a clean config from env on first
  // getConfig() rather than inheriting a half-mutated cache — the root of the
  // swarm-test ordering flake (T1).
  (realConfig as { resetConfig: () => void }).resetConfig();
});

describeUnit('LiteLLMClient — constructor', () => {
  test('forwards config to OpenAI client', () => {
    // Other test files in the same `bun test` run may have already cached a
    // different config — reset so this assertion reads OUR env vars.
    (realConfig as { resetConfig: () => void }).resetConfig();
    new LiteLLMClient();
    expect(openaiConstructorCalls).toHaveLength(1);
    const args = openaiConstructorCalls[0];
    expect(args.baseURL).toBe(PROXY_URL);
    expect(args.apiKey).toBe('sk-test');
    expect(args.timeout).toBe(5000);
    expect(args.maxRetries).toBe(0);
  });

  test('falls back to sk-litellm when apiKey unset', () => {
    const original = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = '';
    const { resetConfig } = realConfig as { resetConfig: () => void };
    resetConfig();
    try {
      new LiteLLMClient();
      expect(openaiConstructorCalls[0].apiKey).toBe('sk-litellm');
    } finally {
      process.env.LITELLM_API_KEY = original;
      resetConfig();
    }
  });
});

describeUnit('LiteLLMClient — sanitizeToolMessages (via completeViaProxy)', () => {
  test('drops tool messages with no matching assistant tool_call id', async () => {
    let captured: any;
    chatCreateImpl.current = (params: any) => {
      captured = params;
      return Promise.resolve(chatCompletion({ content: 'ok' }));
    };

    const client = new LiteLLMClient();
    await client.completeViaProxy({
      model: 'gpt-4',
      messages: [
        userMsg('hi'),
        { role: 'tool', content: 'orphan', toolCallId: 'missing-id', timestamp: ts() },
      ],
    });

    const roles = captured.messages.map((m: any) => m.role);
    expect(roles).toEqual(['user']);
  });

  test('synthesizes placeholder for unanswered tool_call ids', async () => {
    let captured: any;
    chatCreateImpl.current = (params: any) => {
      captured = params;
      return Promise.resolve(chatCompletion({ content: 'ok' }));
    };

    const client = new LiteLLMClient();
    await client.completeViaProxy({
      model: 'gpt-4',
      messages: [
        userMsg('do it'),
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-a', name: 'fa', arguments: {} },
            { id: 'call-b', name: 'fb', arguments: {} },
          ],
          timestamp: ts(),
        },
        { role: 'tool', content: 'result-a', toolCallId: 'call-a', timestamp: ts() },
      ],
    });

    const tools = captured.messages.filter((m: any) => m.role === 'tool');
    expect(tools).toHaveLength(2);
    const ids = tools.map((t: any) => t.tool_call_id);
    expect(ids).toContain('call-a');
    expect(ids).toContain('call-b');
    const placeholder = tools.find((t: any) => t.tool_call_id === 'call-b');
    expect(placeholder.content).toMatch(/no result recorded/);
  });

  test('keeps everything intact when pairings are clean', async () => {
    let captured: any;
    chatCreateImpl.current = (params: any) => {
      captured = params;
      return Promise.resolve(chatCompletion({ content: 'ok' }));
    };

    const client = new LiteLLMClient();
    await client.completeViaProxy({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'sys', timestamp: ts() },
        userMsg('do it'),
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-a', name: 'fa', arguments: { x: 1 } }],
          timestamp: ts(),
        },
        { role: 'tool', content: 'res', toolCallId: 'call-a', timestamp: ts() },
        userMsg('thanks'),
      ],
    });

    expect(captured.messages).toHaveLength(5);
  });
});

describeUnit('LiteLLMClient — formatMessages', () => {
  test('serializes assistant tool_calls arguments as JSON string', async () => {
    let captured: any;
    chatCreateImpl.current = (p: any) => { captured = p; return Promise.resolve(chatCompletion({ content: 'ok' })); };
    const client = new LiteLLMClient();
    await client.completeViaProxy({
      model: 'gpt-4',
      messages: [
        userMsg('hi'),
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'lookup', arguments: { q: 'hello' } }],
          timestamp: ts(),
        },
        { role: 'tool', content: 'r', toolCallId: 'c1', timestamp: ts() },
      ],
    });

    const assistantMsg = captured.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg.tool_calls[0].type).toBe('function');
    expect(assistantMsg.tool_calls[0].function.name).toBe('lookup');
    expect(JSON.parse(assistantMsg.tool_calls[0].function.arguments)).toEqual({ q: 'hello' });
  });
});

describeUnit('LiteLLMClient — completeViaProxy', () => {
  test('returns content + usage + latency', async () => {
    chatCreateImpl.current = () => Promise.resolve(chatCompletion({
      content: 'hello',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: 'gpt-4',
    }));

    const client = new LiteLLMClient();
    const res = await client.completeViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] });
    expect(res.content).toBe('hello');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(res.finishReason).toBe('stop');
    expect(res.model).toBe('gpt-4');
    expect(typeof res.latencyMs).toBe('number');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('forwards tools + extraBody to params', async () => {
    let captured: any;
    chatCreateImpl.current = (p: any) => { captured = p; return Promise.resolve(chatCompletion({ content: 'ok' })); };
    const client = new LiteLLMClient();
    await client.completeViaProxy({
      model: 'gpt-4',
      messages: [userMsg('hi')],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} as any } }] as any,
      extraBody: { think: false },
      temperature: 0.5,
      maxTokens: 100,
      topP: 0.9,
      stopSequences: ['STOP'],
      responseFormat: { type: 'json_object' },
    });
    expect(captured.tools).toBeDefined();
    expect(captured.tool_choice).toBe('auto');
    expect(captured.think).toBe(false);
    expect(captured.temperature).toBe(0.5);
    expect(captured.max_tokens).toBe(100);
    expect(captured.top_p).toBe(0.9);
    expect(captured.stop).toEqual(['STOP']);
    expect(captured.response_format).toEqual({ type: 'json_object' });
    expect(captured.stream).toBe(false);
  });

  test('strips <think>...</think>, <thinking>, and <reasoning> blocks', async () => {
    chatCreateImpl.current = () => Promise.resolve(chatCompletion({
      content: '<think>plotting</think>real answer<reasoning>more</reasoning>',
    }));
    const client = new LiteLLMClient();
    const res = await client.completeViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] });
    expect(res.content).toBe('real answer');
  });

  test('strips JSON-style {"thought":"..."} blocks', async () => {
    chatCreateImpl.current = () => Promise.resolve(chatCompletion({
      content: '{"thought":"hmm"}actual',
    }));
    const client = new LiteLLMClient();
    const res = await client.completeViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] });
    expect(res.content).toBe('actual');
  });

  test('blanks malformed thinking JSON at start of content', async () => {
    chatCreateImpl.current = () => Promise.resolve(chatCompletion({
      content: '{"thought": "<channel|>{',
    }));
    const client = new LiteLLMClient();
    const res = await client.completeViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] });
    expect(res.content).toBe('');
  });

  test('parses tool_calls into ToolCall[]', async () => {
    chatCreateImpl.current = () => Promise.resolve(chatCompletion({
      toolCalls: [{ id: 'tc-1', name: 'search', arguments: '{"q":"weather"}' }],
      finishReason: 'tool_calls',
    }));
    const client = new LiteLLMClient();
    const res = await client.completeViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] });
    expect(res.toolCalls).toEqual([{ id: 'tc-1', name: 'search', arguments: { q: 'weather' } }]);
    expect(res.finishReason).toBe('tool_calls');
  });

  test('repairs truncated tool-call JSON via repairTruncatedJson', async () => {
    chatCreateImpl.current = () => Promise.resolve(chatCompletion({
      toolCalls: [{ id: 'tc-1', name: 'broken', arguments: '{"q": "weather' }],
    }));
    const client = new LiteLLMClient();
    const res = await client.completeViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] });
    expect(res.toolCalls![0]).toEqual({ id: 'tc-1', name: 'broken', arguments: { q: 'weather' } });
  });

  test('throws ClassifiedError on unrecoverable tool-call JSON', async () => {
    chatCreateImpl.current = () => Promise.resolve(chatCompletion({
      toolCalls: [{ id: 'tc-1', name: 'broken', arguments: '}}}not json{{{' }],
    }));
    const client = new LiteLLMClient();
    await expect(
      client.completeViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] })
    ).rejects.toBeInstanceOf(ClassifiedError);
  });

  test('throws ClassifiedError on empty choices', async () => {
    chatCreateImpl.current = () => Promise.resolve(chatCompletion({ noChoices: true }));
    const client = new LiteLLMClient();
    await expect(
      client.completeViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] })
    ).rejects.toBeInstanceOf(ClassifiedError);
  });

  test('throws on unexpected tool call type', async () => {
    chatCreateImpl.current = () => Promise.resolve(chatCompletion({
      toolCalls: [{ id: 'tc-1', name: 'search', arguments: '{}', type: 'weird' }],
    }));
    const client = new LiteLLMClient();
    await expect(
      client.completeViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] })
    ).rejects.toBeInstanceOf(ClassifiedError);
  });

  test('classifies SDK rejections', async () => {
    chatCreateImpl.current = () => Promise.reject(Object.assign(new Error('rate limit'), { status: 429 }));
    const client = new LiteLLMClient();
    await expect(
      client.completeViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] })
    ).rejects.toBeInstanceOf(ClassifiedError);
  });
});

describeUnit('LiteLLMClient — complete routing', () => {
  test('routes through proxy when bound provider is litellm', async () => {
    routerState.resolveProvider = { name: 'litellm' };
    let called = false;
    chatCreateImpl.current = () => { called = true; return Promise.resolve(chatCompletion({ content: 'ok' })); };

    const client = new LiteLLMClient();
    const res = await client.complete({ model: 'gpt-4', messages: [userMsg('hi')] });
    expect(called).toBe(true);
    expect(res.content).toBe('ok');
  });

  test('calls direct provider.complete when bound provider is not litellm', async () => {
    let received: any;
    const fakeProvider: FakeProvider = {
      name: 'ollama',
      complete: async (opts) => {
        received = opts;
        return {
          content: 'from-ollama',
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          model: opts.model,
          latencyMs: 1,
        };
      },
    };
    routerState.resolveProvider = fakeProvider;

    const client = new LiteLLMClient();
    const res = await client.complete({ model: 'llama3', messages: [userMsg('hi')] });
    expect(res.content).toBe('from-ollama');
    expect(received.model).toBe('llama3');
  });

  test('applyModelOverrides merges endpoint from registry when apiKeyRef is unset', async () => {
    let received: any;
    routerState.resolveProvider = {
      name: 'ollama',
      complete: async (opts) => {
        received = opts;
        return { content: '', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model: opts.model, latencyMs: 1 };
      },
    };
    registryState.byModelId['llama3'] = { endpoint: 'http://other:11434', apiKeyRef: null };

    const client = new LiteLLMClient();
    await client.complete({ model: 'llama3', messages: [userMsg('hi')] });
    expect(received.endpoint).toBe('http://other:11434');
  });

  test('applyModelOverrides leaves caller-supplied endpoint/apiKey alone', async () => {
    let received: any;
    routerState.resolveProvider = {
      name: 'ollama',
      complete: async (opts) => {
        received = opts;
        return { content: '', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model: opts.model, latencyMs: 1 };
      },
    };
    registryState.byModelId['llama3'] = { endpoint: 'http://from-db', apiKeyRef: null };

    const client = new LiteLLMClient();
    await client.complete({
      model: 'llama3',
      messages: [userMsg('hi')],
      endpoint: 'http://caller-wins',
      apiKey: 'caller-secret',
    });
    expect(received.endpoint).toBe('http://caller-wins');
    expect(received.apiKey).toBe('caller-secret');
  });

  test('applyModelOverrides is a no-op when both endpoint and apiKey are caller-supplied', async () => {
    let received: any;
    routerState.resolveProvider = {
      name: 'ollama',
      complete: async (opts) => {
        received = opts;
        return { content: '', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model: opts.model, latencyMs: 1 };
      },
    };
    // Even with a registry entry, the early-return short-circuits before lookup.
    registryState.byModelId['llama3'] = { endpoint: 'http://db', apiKeyRef: null };

    const client = new LiteLLMClient();
    await client.complete({
      model: 'llama3',
      messages: [userMsg('hi')],
      endpoint: 'http://caller',
      apiKey: 'caller-key',
    });
    expect(received.endpoint).toBe('http://caller');
    expect(received.apiKey).toBe('caller-key');
  });
});

describeUnit('LiteLLMClient — streamViaProxy', () => {
  test('yields content chunks and finish_reason', async () => {
    chatCreateImpl.current = () => asyncIter([
      { choices: [{ delta: { content: 'hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const client = new LiteLLMClient();
    const out: any[] = [];
    for await (const c of client.streamViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] })) out.push(c);
    expect(out).toEqual([
      { content: 'hel' },
      { content: 'lo' },
      { finishReason: 'stop' },
    ]);
  });

  test('strips <think>...</think> contained in a single chunk', async () => {
    chatCreateImpl.current = () => asyncIter([
      { choices: [{ delta: { content: 'a<think>x</think>b' } }] },
    ]);
    const client = new LiteLLMClient();
    const out: any[] = [];
    for await (const c of client.streamViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] })) out.push(c);
    const text = out.filter(c => c.content).map(c => c.content).join('');
    expect(text).toBe('ab');
  });

  test('strips <think> blocks split across chunks', async () => {
    chatCreateImpl.current = () => asyncIter([
      { choices: [{ delta: { content: 'pre<think>se' } }] },
      { choices: [{ delta: { content: 'cret' } }] },
      { choices: [{ delta: { content: '</think>post' } }] },
    ]);
    const client = new LiteLLMClient();
    const out: any[] = [];
    for await (const c of client.streamViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] })) out.push(c);
    const text = out.filter(c => c.content).map(c => c.content).join('');
    expect(text).toBe('prepost');
  });

  test('accumulates tool_call deltas and emits per-delta', async () => {
    chatCreateImpl.current = () => asyncIter([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'do' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const client = new LiteLLMClient();
    const deltas: any[] = [];
    let finishReason: string | undefined;
    for await (const c of client.streamViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] })) {
      if (c.toolCallDelta) deltas.push(c.toolCallDelta);
      if (c.finishReason) finishReason = c.finishReason;
    }
    expect(deltas).toHaveLength(3);
    expect(deltas[0].id).toBe('t1');
    expect(deltas[0].name).toBe('do');
    expect(deltas[1].arguments).toBe('{"x":');
    expect(deltas[2].arguments).toBe('1}');
    expect(finishReason).toBe('tool_calls');
  });

  test('classifies stream initialization errors', async () => {
    chatCreateImpl.current = () => Promise.reject(Object.assign(new Error('boom'), { status: 500 }));
    const client = new LiteLLMClient();
    const run = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.streamViaProxy({ model: 'gpt-4', messages: [userMsg('hi')] })) { /* */ }
    };
    await expect(run()).rejects.toBeInstanceOf(ClassifiedError);
  });
});

describeUnit('LiteLLMClient — stream routing', () => {
  test('falls through to proxy when router lookup throws', async () => {
    routerState.getProvider = () => { throw new Error('not registered'); };
    chatCreateImpl.current = () => asyncIter([
      { choices: [{ delta: { content: 'fallback' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const client = new LiteLLMClient();
    const out: any[] = [];
    for await (const c of client.stream({ model: 'gpt-4', messages: [userMsg('hi')] })) out.push(c);
    expect(out.some(c => c.content === 'fallback')).toBe(true);
  });

  test('routes through router.stream for non-litellm providers', async () => {
    routerState.getProvider = { name: 'ollama' };
    routerState.routerStream = async function* () {
      yield { content: 'from-router' };
      yield { finishReason: 'stop' };
    };
    // mock.module captured initial routerStream; re-mock manually for this test:
    mockModule('@/models/providers', () => ({
      getProviderRouter: () => ({
        resolveProvider: async () => routerState.resolveProvider,
        getProvider: () => routerState.getProvider,
        getAllProviders: () => routerState.getAllProviders,
        stream: async function* (_o: any) {
          yield { content: 'from-router' };
          yield { finishReason: 'stop' };
        },
      }),
    }));
    // Re-import client so it picks up the new module mock
    const { LiteLLMClient: FreshClient } = await import('./litellm-client');
    const client = new FreshClient();
    const out: any[] = [];
    for await (const c of client.stream({ model: 'llama3', messages: [userMsg('hi')] })) out.push(c);
    expect(out).toEqual([{ content: 'from-router' }, { finishReason: 'stop' }]);
  });
});

describeUnit('LiteLLMClient — embed', () => {
  test('throws when no embedding model is configured', async () => {
    const client = new LiteLLMClient();
    await expect(client.embed('hello')).rejects.toBeInstanceOf(ClassifiedError);
  });

  test('uses explicit model arg + routes through proxy', async () => {
    routerState.resolveProvider = { name: 'litellm' };
    let captured: any;
    embeddingsCreateImpl.current = (p: any) => {
      captured = p;
      return Promise.resolve({ data: [{ embedding: [0.1, 0.2] }] });
    };
    const client = new LiteLLMClient();
    const vecs = await client.embed('hello', 'text-embedding-3-small');
    expect(captured.model).toBe('text-embedding-3-small');
    expect(captured.input).toEqual(['hello']);
    expect(captured.encoding_format).toBe('float');
    expect(vecs).toEqual([[0.1, 0.2]]);
  });

  test('uses topic-bound model when no arg supplied', async () => {
    registryState.forTopic['embedding'] = { modelId: 'bound-embed' };
    routerState.resolveProvider = { name: 'litellm' };
    let captured: any;
    embeddingsCreateImpl.current = (p: any) => {
      captured = p;
      return Promise.resolve({ data: [{ embedding: [0.5] }] });
    };
    const client = new LiteLLMClient();
    await client.embed(['a', 'b']);
    expect(captured.model).toBe('bound-embed');
    expect(captured.input).toEqual(['a', 'b']);
  });

  test('throws when bound provider lacks embed support', async () => {
    routerState.resolveProvider = { name: 'anthropic' /* no embed fn */ };
    const client = new LiteLLMClient();
    await expect(client.embed('hi', 'claude-3-opus')).rejects.toBeInstanceOf(ClassifiedError);
  });

  test('routes to direct provider.embed when not litellm', async () => {
    let received: { input: string[]; model: string; endpoint?: string } = { input: [], model: '' };
    routerState.resolveProvider = {
      name: 'voyage',
      embed: async (input, model, endpoint) => {
        received = { input, model, endpoint };
        return [[0.9]];
      },
    };
    registryState.byModelId['voyage-3'] = { endpoint: 'http://voyage.test' };
    const client = new LiteLLMClient();
    const vecs = await client.embed('hi', 'voyage-3');
    expect(received.input).toEqual(['hi']);
    expect(received.model).toBe('voyage-3');
    expect(received.endpoint).toBe('http://voyage.test');
    expect(vecs).toEqual([[0.9]]);
  });

  test('classifies proxy embedding errors', async () => {
    routerState.resolveProvider = { name: 'litellm' };
    embeddingsCreateImpl.current = () => Promise.reject(new Error('proxy down'));
    const client = new LiteLLMClient();
    await expect(client.embed('hi', 'embed-x')).rejects.toBeInstanceOf(ClassifiedError);
  });
});

describeUnit('LiteLLMClient — listModels / isModelAvailable', () => {
  test('listModels returns ids', async () => {
    modelsListImpl.current = () => Promise.resolve({ data: [{ id: 'm1' }, { id: 'm2' }] });
    const client = new LiteLLMClient();
    expect(await client.listModels()).toEqual(['m1', 'm2']);
  });

  test('isModelAvailable returns true when listed', async () => {
    modelsListImpl.current = () => Promise.resolve({ data: [{ id: 'gpt-4' }] });
    const client = new LiteLLMClient();
    expect(await client.isModelAvailable('gpt-4')).toBe(true);
  });

  test('isModelAvailable returns false when missing', async () => {
    modelsListImpl.current = () => Promise.resolve({ data: [{ id: 'gpt-4' }] });
    const client = new LiteLLMClient();
    expect(await client.isModelAvailable('gpt-5')).toBe(false);
  });

  test('isModelAvailable returns false on listing error', async () => {
    modelsListImpl.current = () => Promise.reject(new Error('boom'));
    const client = new LiteLLMClient();
    expect(await client.isModelAvailable('gpt-4')).toBe(false);
  });
});

describeUnit('LiteLLMClient — completeVision', () => {
  test('proxy path when bound provider is litellm', async () => {
    routerState.resolveProvider = { name: 'litellm' };
    routerState.getProvider = { name: 'litellm' };
    routerState.getAllProviders = [{ name: 'litellm' }];
    registryState.byModelId['vision-pro'] = { provider: 'litellm' };
    let captured: any;
    chatCreateImpl.current = (p: any) => {
      captured = p;
      return Promise.resolve(chatCompletion({ content: 'a cat', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    };
    const client = new LiteLLMClient();
    const res = await client.completeVision({
      model: 'vision-pro',
      prompt: 'what is this',
      imageBase64: 'AAA',
      mimeType: 'image/png',
    });
    expect(res.content).toBe('a cat');
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    const userContent = captured.messages[0].content;
    expect(userContent[0]).toEqual({ type: 'text', text: 'what is this' });
    expect(userContent[1].image_url.url).toBe('data:image/png;base64,AAA');
  });

  test('direct ollama path uses model endpoint override', async () => {
    routerState.getProvider = { name: 'ollama' };
    routerState.getAllProviders = [{ name: 'ollama' }, { name: 'litellm' }];
    registryState.byModelId['llava'] = { provider: 'ollama', endpoint: 'http://ollama-x:11434' };

    // Track which OpenAI ctor is the vision one (the second one — first is the LiteLLMClient itself).
    chatCreateImpl.current = () => Promise.resolve(chatCompletion({
      content: 'a dog',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));

    const client = new LiteLLMClient();
    await client.completeVision({ model: 'llava', prompt: 'p', imageBase64: 'BBB' });

    const visionCtor = openaiConstructorCalls[openaiConstructorCalls.length - 1];
    expect(visionCtor.baseURL).toBe('http://ollama-x:11434/v1');
    expect(visionCtor.apiKey).toBe('ollama');
  });

  test('strips <think>...</think> from vision response', async () => {
    routerState.resolveProvider = { name: 'litellm' };
    routerState.getProvider = { name: 'litellm' };
    registryState.byModelId['vision'] = { provider: 'litellm' };
    chatCreateImpl.current = () => Promise.resolve(chatCompletion({
      content: '<think>thinking</think>visible',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    const client = new LiteLLMClient();
    const res = await client.completeVision({ model: 'vision', prompt: 'p', imageBase64: 'E' });
    expect(res.content).toBe('visible');
  });
});

describeUnit('LiteLLMClient — singleton', () => {
  test('getLiteLLMClient returns same instance until reset', () => {
    const a = getLiteLLMClient();
    const b = getLiteLLMClient();
    expect(a).toBe(b);
    resetLiteLLMClient();
    const c = getLiteLLMClient();
    expect(c).not.toBe(a);
  });

  // Regression: the client must use the apiKey resolved AT CONSTRUCTION time,
  // and reset must rebuild it so a key that lands after the first build (e.g.
  // a vault secret resolved by loadRuntimeConfig, after the gateway self-check
  // already built the client) is actually picked up. Without the reset wired
  // into startup, the orchestrator kept the empty-default 'sk-litellm'
  // placeholder for the whole process and every completion 401'd.
  test('reset rebuilds the client with the apiKey resolved after first build', () => {
    const cfg = realConfig as { getConfig: () => unknown; refreshConfigKey: (k: string, v: unknown) => void };
    cfg.getConfig(); // ensure cachedConfig exists so refreshConfigKey applies

    cfg.refreshConfigKey('litellm.apiKey', 'sk-early');
    resetLiteLLMClient();
    getLiteLLMClient();
    expect(openaiConstructorCalls.at(-1)?.apiKey).toBe('sk-early');

    // Key arrives later (vault resolved post-boot). A cached client is stale:
    // no new OpenAI construction, so the old key is still in force.
    const before = openaiConstructorCalls.length;
    cfg.refreshConfigKey('litellm.apiKey', 'sk-real-vault-key');
    getLiteLLMClient();
    expect(openaiConstructorCalls.length).toBe(before); // still cached

    // The fix: reset → next get rebuilds with the now-resolved key.
    resetLiteLLMClient();
    getLiteLLMClient();
    expect(openaiConstructorCalls.at(-1)?.apiKey).toBe('sk-real-vault-key');
  });

  test('falls back to the sk-litellm placeholder when no apiKey is configured', () => {
    const cfg = realConfig as { getConfig: () => unknown; refreshConfigKey: (k: string, v: unknown) => void };
    cfg.getConfig();
    cfg.refreshConfigKey('litellm.apiKey', '');
    resetLiteLLMClient();
    getLiteLLMClient();
    expect(openaiConstructorCalls.at(-1)?.apiKey).toBe('sk-litellm');
  });
});
