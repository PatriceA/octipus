import { describe, expect, test } from 'vitest';
import type { CompletionOptions, StreamChunk } from '@/models/litellm-client';
import { collectStream } from './stream-collect';

async function* chunks(list: StreamChunk[]): AsyncGenerator<StreamChunk> { for (const c of list) yield c; }
const opts = { model: 'm', messages: [] } as unknown as CompletionOptions;

describe('collectStream', () => {
  test('concatenates text, reports every delta, and carries usage/finish/model/requestId', async () => {
    const deltas: string[] = [];
    const progress = { chunks: 0 };
    const result = await collectStream(chunks([
      { content: 'Hel' }, { content: 'lo' },
      { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, model: 'm-real', requestId: 'r1' },
      { finishReason: 'stop', providerRaw: { thought_signature: 'sig' } },
    ]), opts, 'openai', (d) => deltas.push(d), progress);
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result).toMatchObject({ content: 'Hello', finishReason: 'stop', model: 'm-real', requestId: 'r1',
      usage: { totalTokens: 5 }, providerRaw: { thought_signature: 'sig' } });
    expect(result.toolCalls).toBeUndefined();
    expect(progress.chunks).toBe(4);
  });

  test('assembles fragmented tool-call arguments per id and parses them', async () => {
    const result = await collectStream(chunks([
      { toolCallDelta: { id: 'a', name: 'read_file' } },
      { toolCallDelta: { id: 'b', name: 'bash', arguments: '{"cmd":' } },
      { toolCallDelta: { id: 'a', arguments: '{"path":"x.ts"' } },
      { toolCallDelta: { id: 'a', arguments: '}' } },
      { toolCallDelta: { id: 'b', arguments: '"ls"}' } },
      { finishReason: 'tool_calls' },
    ]), opts, 'openai');
    expect(result.toolCalls).toEqual([
      { id: 'a', name: 'read_file', arguments: { path: 'x.ts' } },
      { id: 'b', name: 'bash', arguments: { cmd: 'ls' } },
    ]);
    expect(result.finishReason).toBe('tool_calls');
  });

  test('keeps two id-less tool calls apart (ollama and the proxy send no ids)', async () => {
    const result = await collectStream(chunks([
      { toolCallDelta: { id: '', name: 'read_file', arguments: '{"path":' } },
      { toolCallDelta: { id: '', arguments: '"a.ts"}' } },
      { toolCallDelta: { id: '', name: 'bash', arguments: '{"cmd":"ls"}' } },
    ]), opts, 'ollama');
    expect(result.toolCalls).toEqual([
      { id: 'call_0', name: 'read_file', arguments: { path: 'a.ts' } },
      { id: 'call_1', name: 'bash', arguments: { cmd: 'ls' } },
    ]);
  });

  test('defaults finishReason to stop and marks usage unavailable when the provider sent none', async () => {
    const result = await collectStream(chunks([{ content: 'x' }]), opts, 'ollama');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.available).toBe(false);
  });

  test('a stream that fails before yielding leaves progress at zero so the caller may retry non-streaming', async () => {
    async function* broken(): AsyncGenerator<StreamChunk> { throw new Error('refused'); }
    const progress = { chunks: 0 };
    await expect(collectStream(broken(), opts, 'openai', undefined, progress)).rejects.toThrow('refused');
    expect(progress.chunks).toBe(0);
  });
});
