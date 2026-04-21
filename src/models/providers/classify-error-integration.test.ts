import { describe, test, expect, mock } from 'bun:test';
import { ClassifiedError, FailoverReason } from '@/core/errors/classification';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { GeminiProvider } from './gemini-provider';
import { DeepSeekProvider } from './deepseek-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { CLIProvider } from './cli-provider';
import type { CompletionOptions } from '../litellm-client';

/**
 * Integration tests verifying that every migrated provider surfaces errors
 * as `ClassifiedError` instances with a matching `FailoverReason`.
 *
 * Providers that use the OpenAI SDK are fed a fake client whose `.chat.completions.create`
 * rejects with a status-bearing error; providers that use raw fetch get a mocked
 * global fetch.
 */

// ── Helpers ───────────────────────────────────────────────────────────

interface SdkError {
  status?: number;
  message: string;
  code?: string;
}

/** Build a minimal fake OpenAI-like client whose chat.completions.create rejects. */
function fakeRejectingClient(err: SdkError): any {
  return {
    chat: {
      completions: {
        create: async () => { throw Object.assign(new Error(err.message), { status: err.status, code: err.code }); },
      },
    },
    embeddings: {
      create: async () => { throw Object.assign(new Error(err.message), { status: err.status, code: err.code }); },
    },
  };
}

/** Build a fetch mock that returns an error response. */
function mockFetchResponse(status: number, body: string): typeof fetch {
  return (async () => ({
    ok: false,
    status,
    text: async () => body,
    json: async () => { try { return JSON.parse(body); } catch { return { error: { message: body } }; } },
  })) as unknown as typeof fetch;
}

/** Build a fetch mock that throws (network timeout). */
function mockFetchNetworkError(errMsg = 'fetch failed'): typeof fetch {
  return (async () => { throw Object.assign(new Error(errMsg), { code: 'ECONNRESET' }); }) as unknown as typeof fetch;
}

function baseOptions(model: string): CompletionOptions {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' } as any],
  };
}

/** Override a provider's private createClient to return a fake client. */
function stubCreateClient(provider: object, fake: any): void {
  (provider as any).createClient = async () => fake;
}

/** Override getApiKey so tests don't touch vault/env. */
function stubApiKey(provider: object, key: string | null = 'test-key'): void {
  (provider as any).getApiKey = async () => key;
}

// ── OpenAI Provider ──────────────────────────────────────────────────

describe('OpenAIProvider classified errors', () => {
  const cases: Array<{ name: string; err: SdkError; reason: FailoverReason }> = [
    { name: '429 rate limit', err: { status: 429, message: 'Rate limit exceeded' }, reason: FailoverReason.RATE_LIMIT },
    { name: '401 auth failed', err: { status: 401, message: 'Invalid API key' }, reason: FailoverReason.AUTH_FAILED },
    { name: '500 provider down', err: { status: 500, message: 'Internal server error' }, reason: FailoverReason.PROVIDER_DOWN },
    { name: 'ECONNRESET network timeout', err: { message: 'socket hang up', code: 'ECONNRESET' }, reason: FailoverReason.NETWORK_TIMEOUT },
  ];

  for (const c of cases) {
    test(`complete() throws ClassifiedError on ${c.name}`, async () => {
      const p = new OpenAIProvider();
      stubApiKey(p);
      stubCreateClient(p, fakeRejectingClient(c.err));
      let thrown: unknown;
      try { await p.complete(baseOptions('gpt-4o')); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(ClassifiedError);
      expect((thrown as ClassifiedError).reason).toBe(c.reason);
      expect((thrown as ClassifiedError).providerHint).toBe('openai');
    });
  }
});

// ── Anthropic Provider ───────────────────────────────────────────────

describe('AnthropicProvider classified errors', () => {
  const cases: Array<{ name: string; err: SdkError; reason: FailoverReason }> = [
    { name: '429 rate limit', err: { status: 429, message: 'Rate limit exceeded' }, reason: FailoverReason.RATE_LIMIT },
    { name: '401 auth failed', err: { status: 401, message: 'Invalid API key' }, reason: FailoverReason.AUTH_FAILED },
    { name: '500 provider down', err: { status: 500, message: 'Internal error' }, reason: FailoverReason.PROVIDER_DOWN },
    { name: 'ETIMEDOUT network timeout', err: { message: 'request timed out', code: 'ETIMEDOUT' }, reason: FailoverReason.NETWORK_TIMEOUT },
  ];

  for (const c of cases) {
    test(`complete() throws ClassifiedError on ${c.name}`, async () => {
      const p = new AnthropicProvider();
      stubApiKey(p);
      stubCreateClient(p, fakeRejectingClient(c.err));
      let thrown: unknown;
      try { await p.complete(baseOptions('claude-sonnet-4-6')); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(ClassifiedError);
      expect((thrown as ClassifiedError).reason).toBe(c.reason);
      expect((thrown as ClassifiedError).providerHint).toBe('anthropic');
    });
  }
});

// ── DeepSeek Provider ────────────────────────────────────────────────

describe('DeepSeekProvider classified errors', () => {
  const cases: Array<{ name: string; err: SdkError; reason: FailoverReason }> = [
    { name: '429 rate limit', err: { status: 429, message: 'Rate limit exceeded' }, reason: FailoverReason.RATE_LIMIT },
    { name: '401 auth failed', err: { status: 401, message: 'Invalid API key' }, reason: FailoverReason.AUTH_FAILED },
    { name: '500 provider down', err: { status: 500, message: 'Internal error' }, reason: FailoverReason.PROVIDER_DOWN },
    { name: 'ECONNREFUSED network timeout', err: { message: 'connection refused', code: 'ECONNREFUSED' }, reason: FailoverReason.NETWORK_TIMEOUT },
  ];

  for (const c of cases) {
    test(`complete() throws ClassifiedError on ${c.name}`, async () => {
      const p = new DeepSeekProvider();
      stubApiKey(p);
      stubCreateClient(p, fakeRejectingClient(c.err));
      let thrown: unknown;
      try { await p.complete(baseOptions('deepseek-chat')); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(ClassifiedError);
      expect((thrown as ClassifiedError).reason).toBe(c.reason);
      expect((thrown as ClassifiedError).providerHint).toBe('deepseek');
    });
  }
});

// ── OpenRouter Provider ──────────────────────────────────────────────

describe('OpenRouterProvider classified errors', () => {
  const cases: Array<{ name: string; err: SdkError; reason: FailoverReason }> = [
    { name: '429 rate limit', err: { status: 429, message: 'Upstream rate limit' }, reason: FailoverReason.RATE_LIMIT },
    { name: '401 auth failed', err: { status: 401, message: 'Invalid API key' }, reason: FailoverReason.AUTH_FAILED },
    { name: '500 provider down', err: { status: 500, message: 'Internal error' }, reason: FailoverReason.PROVIDER_DOWN },
    { name: 'ENOTFOUND network timeout', err: { message: 'DNS lookup failed', code: 'ENOTFOUND' }, reason: FailoverReason.NETWORK_TIMEOUT },
  ];

  for (const c of cases) {
    test(`complete() throws ClassifiedError on ${c.name}`, async () => {
      const p = new OpenRouterProvider();
      stubApiKey(p);
      stubCreateClient(p, fakeRejectingClient(c.err));
      let thrown: unknown;
      try { await p.complete(baseOptions('openai/gpt-4o')); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(ClassifiedError);
      expect((thrown as ClassifiedError).reason).toBe(c.reason);
      expect((thrown as ClassifiedError).providerHint).toBe('openrouter');
    });
  }
});

// ── Gemini Provider (uses raw fetch) ─────────────────────────────────

describe('GeminiProvider classified errors', () => {
  const originalFetch = globalThis.fetch;

  const cases: Array<{ name: string; setup: () => void; reason: FailoverReason }> = [
    {
      name: '429 rate limit',
      setup: () => { globalThis.fetch = mockFetchResponse(429, JSON.stringify({ error: { message: 'Rate limit exceeded' } })); },
      reason: FailoverReason.RATE_LIMIT,
    },
    {
      name: '401 auth failed',
      setup: () => { globalThis.fetch = mockFetchResponse(401, JSON.stringify({ error: { message: 'Invalid API key' } })); },
      reason: FailoverReason.AUTH_FAILED,
    },
    {
      name: '500 provider down',
      setup: () => { globalThis.fetch = mockFetchResponse(500, JSON.stringify({ error: { message: 'Internal error' } })); },
      reason: FailoverReason.PROVIDER_DOWN,
    },
    {
      name: 'ECONNRESET network timeout',
      setup: () => { globalThis.fetch = mockFetchNetworkError('socket hang up'); },
      reason: FailoverReason.NETWORK_TIMEOUT,
    },
  ];

  for (const c of cases) {
    test(`complete() throws ClassifiedError on ${c.name}`, async () => {
      c.setup();
      try {
        const p = new GeminiProvider();
        stubApiKey(p);
        let thrown: unknown;
        try { await p.complete(baseOptions('gemini-2.0-flash')); } catch (e) { thrown = e; }
        expect(thrown).toBeInstanceOf(ClassifiedError);
        expect((thrown as ClassifiedError).reason).toBe(c.reason);
        expect((thrown as ClassifiedError).providerHint).toBe('gemini');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

// ── CLI Provider ─────────────────────────────────────────────────────

describe('CLIProvider classified errors', () => {
  test('complete() throws ClassifiedError when no CLI tool matches model', async () => {
    const p = new CLIProvider();
    let thrown: unknown;
    try { await p.complete(baseOptions('cli/unknown-tool')); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ClassifiedError);
    expect((thrown as ClassifiedError).providerHint).toBe('cli');
  });

  test('complete() throws ClassifiedError on subprocess failure (simulating auth/network)', async () => {
    const p = new CLIProvider();
    // Stub execCli to simulate a 401-like failure from the subprocess (stderr)
    (p as any).execCli = async () => { throw new Error('unauthorized: invalid API key'); };

    // Stub quotaTracker to be unexhausted
    const { getQuotaTracker } = await import('../quota-tracker');
    const tracker = getQuotaTracker();
    const origGet = tracker.getStatus.bind(tracker);
    tracker.getStatus = mock(async () => ({ provider: 'claude-code', hasQuota: true, exhausted: false })) as any;

    try {
      let thrown: unknown;
      try { await p.complete(baseOptions('cli/claude')); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(ClassifiedError);
      expect((thrown as ClassifiedError).providerHint).toBe('cli');
      // 'unauthorized' triggers AUTH_FAILED classification
      expect((thrown as ClassifiedError).reason).toBe(FailoverReason.AUTH_FAILED);
    } finally {
      tracker.getStatus = origGet;
    }
  });

  test('complete() throws ClassifiedError on quota-shaped error (network-y message but quota pattern)', async () => {
    const p = new CLIProvider();
    (p as any).execCli = async () => { throw new Error('rate limit exceeded'); };

    const { getQuotaTracker } = await import('../quota-tracker');
    const tracker = getQuotaTracker();
    const origGet = tracker.getStatus.bind(tracker);
    const origMark = tracker.markExhausted.bind(tracker);
    tracker.getStatus = mock(async () => ({ provider: 'claude-code', hasQuota: true, exhausted: false })) as any;
    tracker.markExhausted = mock(async () => {}) as any;

    try {
      let thrown: unknown;
      try { await p.complete(baseOptions('cli/claude')); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(ClassifiedError);
      expect((thrown as ClassifiedError).providerHint).toBe('cli');
      // 'rate limit' phrasing makes classifier pick RATE_LIMIT
      expect((thrown as ClassifiedError).reason).toBe(FailoverReason.RATE_LIMIT);
    } finally {
      tracker.getStatus = origGet;
      tracker.markExhausted = origMark;
    }
  });
});
