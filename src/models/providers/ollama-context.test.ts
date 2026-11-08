/**
 * A pinned Ollama context window (`ollama.contextLength`): every call goes
 * through native /api/chat with `options.num_ctx` (the only endpoint that
 * takes it), keeps streaming there, fails loud before sending a prompt that
 * cannot fit, and a server-side truncation is detected and logged.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ contextLength: undefined as number | undefined }));
vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    getConfig: () => {
      const real = actual.getConfig();
      return { ...real, ollama: { ...real.ollama, contextLength: cfg.contextLength } };
    },
  };
});

import { assertFitsNumCtx, detectTruncation, estimatePromptTokens, OllamaProvider } from './ollama-provider';
import type { StreamChunk } from '../litellm-client';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; cfg.contextLength = undefined; });

const opts = {
  model: 'qwen3:14b',
  messages: [{ role: 'user' as const, content: 'hi', timestamp: new Date() }],
  maxTokens: 512,
  tools: [{ type: 'function' as const, function: { name: 'probe', description: 'p', parameters: { type: 'object', properties: {} } } }],
};

function capture(reply: (body: any) => Response) {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(input), body });
    return Promise.resolve(reply(body));
  }) as typeof fetch;
  return calls;
}

const ndjson = (lines: unknown[]) => new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200 });

describe('pinned Ollama context window', () => {
  test('a tool-loop completion goes native with num_ctx pinned, and no think:false forced', async () => {
    cfg.contextLength = 32768;
    const calls = capture(() => Response.json({ message: { role: 'assistant', content: 'ok' }, done: true, prompt_eval_count: 10, eval_count: 2 }));
    const result = await new OllamaProvider('http://localhost:11434').complete(opts);
    expect(result.content).toBe('ok');
    expect(calls[0].url).toBe('http://localhost:11434/api/chat');
    expect(calls[0].body.options.num_ctx).toBe(32768);
    expect(calls[0].body).not.toHaveProperty('think');
    expect(calls[0].body.tools).toHaveLength(1);
  });

  test('without a pinned window the tool loop stays on /v1', async () => {
    const calls = capture(() => Response.json({ id: 'c', model: 'qwen3:14b', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    await new OllamaProvider('http://localhost:11434').complete(opts);
    expect(calls[0].url).toContain('/v1/chat/completions');
  });

  test('streams NDJSON from native /api/chat: text, thinking, whole tool calls, usage', async () => {
    cfg.contextLength = 16384;
    const calls = capture(() => ndjson([
      { message: { thinking: 'hmm' }, done: false },
      { message: { content: 'Hel' }, done: false },
      { message: { content: 'lo' }, done: false },
      { message: { tool_calls: [{ function: { name: 'probe', arguments: { q: 1 } } }] }, done: false },
      { done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 5, model: 'qwen3:14b' },
    ]));
    const chunks: StreamChunk[] = [];
    for await (const c of new OllamaProvider('http://localhost:11434').stream(opts)) chunks.push(c);
    expect(calls[0].body).toMatchObject({ stream: true, options: { num_ctx: 16384 } });
    expect(chunks.map((c) => c.content).filter(Boolean).join('')).toBe('Hello');
    expect(chunks.find((c) => c.reasoningContent)?.reasoningContent).toBe('hmm');
    const tool = chunks.find((c) => c.toolCallDelta)?.toolCallDelta;
    expect(tool).toMatchObject({ name: 'probe', arguments: '{"q":1}' });
    expect(chunks.find((c) => c.usage)?.usage).toMatchObject({ inputTokens: 40, outputTokens: 5 });
    expect(chunks.at(-1)?.finishReason).toBe('stop');
  });

  test('a prompt that cannot fit fails loud, as a context overflow, before anything is sent', async () => {
    cfg.contextLength = 1024;
    const calls = capture(() => Response.json({}));
    const big = { ...opts, messages: [{ role: 'user' as const, content: 'x'.repeat(8_000), timestamp: new Date() }] };
    await expect(new OllamaProvider('http://localhost:11434').complete(big)).rejects.toThrow(/context window of 1024/);
    expect(calls).toHaveLength(0);
    expect(() => assertFitsNumCtx(big, 1024)).toThrow(/Maximum context length exceeded/);
    expect(() => assertFitsNumCtx(opts, 1024)).not.toThrow();
  });
});

describe('truncation detection', () => {
  test('a reported prompt far below what was sent, just under a default window, is truncation', () => {
    expect(detectTruncation('m-a', 12_000, 4_000)).toBe(true);
    expect(detectTruncation('m-b', 12_000, 31_000, 32_768)).toBe(false); // not truncated
    expect(detectTruncation('m-c', 12_000, 11_500)).toBe(false);         // saw it all
    expect(detectTruncation('m-d', 12_000, 900)).toBe(false);            // not near a window
    expect(detectTruncation('m-e', 1_500, 600)).toBe(false);             // too small to tell
  });

  test('the estimate counts tool schemas and tool calls too', () => {
    expect(estimatePromptTokens(opts)).toBeGreaterThan(estimatePromptTokens({ ...opts, tools: undefined }));
  });
});
