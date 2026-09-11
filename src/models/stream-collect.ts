/**
 * Drain a provider `stream()` into the `CompletionResult` that `complete()`
 * would have returned, surfacing text deltas on the way. Applies the same
 * content normalisation the non-streaming proxy path applies (JSON thinking
 * leak strip, DeepSeek template-leak recovery, tool-argument parsing) so the
 * agent loop sees one shape regardless of transport.
 */
import { ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import type { ToolCall } from '@/core/types';
import { DEEPSEEK_TEMPLATE_LEAK, parseDsmlToolCalls } from '@/models/deepseek-template-recovery';
import { stripJsonThinkingLeak, type CompletionOptions, type CompletionResult, type StreamChunk } from '@/models/litellm-client';
import { parseToolCallArguments } from '@/models/tool-call-args';
import { modelLogger } from '@/utils/logger';

export interface StreamProgress {
  /** Chunks seen so far. Zero after a failure means nothing reached the caller and a non-streaming retry is safe. */
  chunks: number;
}

export async function collectStream(
  chunks: AsyncIterable<StreamChunk>,
  options: CompletionOptions,
  providerName: string,
  onDelta?: (text: string) => void,
  progress: StreamProgress = { chunks: 0 },
): Promise<CompletionResult> {
  const startTime = Date.now();
  let content = '';
  let finishReason: string | undefined;
  let usage: CompletionResult['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false };
  let model = options.model;
  let requestId: string | undefined;
  let reasoningContent: string | undefined;
  let providerRaw: Record<string, unknown> | undefined;
  // Providers stream one tool call per id; arguments arrive as fragments.
  // Some (ollama, the proxy path) send no id: a fragment carrying a name opens
  // a new call and id-less argument fragments belong to the most recent one.
  const calls = new Map<string, { name: string; arguments: string }>();
  let lastKey: string | undefined;

  for await (const chunk of chunks) {
    progress.chunks++;
    if (chunk.content) { content += chunk.content; onDelta?.(chunk.content); }
    if (chunk.toolCallDelta) {
      const { id, name, arguments: args } = chunk.toolCallDelta;
      const key = id || (name || !lastKey ? `call_${calls.size}` : lastKey);
      lastKey = key;
      const call = calls.get(key) ?? { name: '', arguments: '' };
      if (name) call.name = name;
      if (args) call.arguments += args;
      calls.set(key, call);
    }
    if (chunk.usage) usage = chunk.usage;
    if (chunk.model) model = chunk.model;
    if (chunk.requestId) requestId = chunk.requestId;
    if (chunk.finishReason) finishReason = chunk.finishReason;
    if (chunk.reasoningContent) reasoningContent = chunk.reasoningContent;
    if (chunk.providerRaw) providerRaw = { ...providerRaw, ...chunk.providerRaw };
  }

  if (options.responseFormat?.type !== 'json_object') content = stripJsonThinkingLeak(content);

  const result: CompletionResult = {
    content,
    finishReason: finishReason ?? 'stop',
    usage,
    model,
    latencyMs: Date.now() - startTime,
    ...(requestId ? { requestId } : {}),
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(providerRaw ? { providerRaw } : {}),
  };

  if (calls.size > 0) {
    result.toolCalls = [...calls].map(([id, call]): ToolCall => ({
      id, name: call.name, arguments: parseToolCallArguments(call.arguments, call.name, providerName),
    }));
    return result;
  }

  // Mirrors the non-streaming proxy path: DeepSeek sometimes emits its native
  // tool-call template as prose. Recover it, or force the retry the loop knows.
  if (DEEPSEEK_TEMPLATE_LEAK.test(content)) {
    const recovered = parseDsmlToolCalls(content);
    if (recovered.length) {
      modelLogger.warn({ model, provider: providerName, recoveredTools: recovered.map((tc) => tc.name) },
        'Streamed DeepSeek template leak recovered as structured tool_calls');
      result.toolCalls = recovered;
      result.content = '';
      return result;
    }
    throw new ClassifiedError({
      reason: FailoverReason.TOOL_CALL_INVALID,
      recovery: RecoveryAction.RETRY_NOW,
      message: 'DeepSeek chat-template leak in streamed content, unrecoverable',
      providerHint: providerName,
      metadata: { contentPreview: content.slice(0, 300) },
    });
  }
  return result;
}
