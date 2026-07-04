import { classifyError, ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import type { AgentMessage, ToolCall } from '@/core/types';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { transformMessagesForProvider } from '@/models/message-transform';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../../litellm-client';
import { createIdleAbort, fetchWithRetryAfter, withTimeoutSignal } from '../http-retry';
import type { ModelProvider, ProviderHealthStatus } from '../interface';
import { BaseCustomProvider, type ResolvedCustomConfig } from './base-custom-provider';

/**
 * Custom Anthropic-compatible provider.
 *
 * Speaks the native Anthropic Messages wire protocol (`POST /v1/messages` with
 * `content` blocks and `stop_reason`). Targets any gateway that exposes a
 * drop-in Anthropic Messages API — e.g. the TPG AI Platform, LiteLLM's
 * Anthropic passthrough, or Bedrock-fronting proxies.
 *
 * Scope is chat + tool use only. Image generation and other bespoke endpoints
 * are intentionally out of scope.
 *
 * Configuration lives entirely on the model_config row:
 *   - endpoint: base URL (e.g. https://api.the-platform-group.ai)
 *   - apiKeyRef: vault key name, or 'env:VAR_NAME'
 *   - metadata.customProvider.auth: bearer | header | query
 *   - metadata.customProvider.pathOverride: defaults to '/v1/messages'
 *   - metadata.customProvider.extraHeaders: optional headers
 */
export class CustomAnthropicCompatProvider extends BaseCustomProvider implements ModelProvider {
  readonly name = 'custom-anthropic';
  readonly type = 'direct' as const;
  protected readonly providerName = 'custom-anthropic';

  /** Anthropic's Messages API requires a version header; default to the stable one. */
  private static readonly DEFAULT_VERSION = '2023-06-01';
  /** Messages API requires max_tokens — fall back when the caller omits it. */
  private static readonly DEFAULT_MAX_TOKENS = 4096;

  supportsModel(_modelName: string): boolean {
    return false; // routed by DB provider column, not name heuristic
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const cfg = await this.resolveModelConfig(options.model, options);
    const startTime = Date.now();
    const { url, body, headers } = this.buildRequest(cfg, options, false);

    modelLogger.debug(
      { model: body.model, messageCount: options.messages.length, provider: this.name, url },
      'Sending completion request to custom-anthropic',
    );

    let res: Response;
    try {
      res = await fetchWithRetryAfter(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: withTimeoutSignal(120_000, options.signal),
      }, this.name);
    } catch (err) {
      throw classifyError(err, this.name);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw classifyError(
        { status: res.status, message: extractErrorMessage(errText) || `HTTP ${res.status}` },
        this.name,
      );
    }

    const data = (await res.json()) as AnthropicResponse;
    return this.parseResponse(data, (cfg.model?.modelId || options.model), Date.now() - startTime);
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const cfg = await this.resolveModelConfig(options.model, options);
    const { url, body, headers } = this.buildRequest(cfg, options, true);

    modelLogger.debug({ model: body.model, provider: this.name, url }, 'Starting streaming completion via custom-anthropic');

    // Idle (read) timeout that resets per chunk — a long streamed tool-call
    // must not be killed by a fixed total-duration cap; caller signal aborts.
    const idle = createIdleAbort(180_000, options.signal);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: idle.signal,
      });
    } catch (err) {
      idle.clear();
      throw classifyError(err, this.name);
    }

    if (!res.ok || !res.body) {
      idle.clear();
      const errText = await res.text().catch(() => '');
      throw classifyError(
        { status: res.status, message: extractErrorMessage(errText) || `HTTP ${res.status}` },
        this.name,
      );
    }

    try {
      yield* parseAnthropicSseStream(res.body, this.name, idle.touch);
    } finally {
      idle.clear();
    }
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    // Per-model provider; reachability is verified at first call via classifyError.
    return { healthy: true };
  }

  // ── Private ──

  private buildRequest(
    cfg: ResolvedCustomConfig,
    options: CompletionOptions,
    streaming: boolean,
  ): { url: string; body: Record<string, unknown>; headers: Record<string, string> } {
    // A10: id normalization + pairing enforcement before Anthropic conversion.
    const { system, messages } = toAnthropicMessages(transformMessagesForProvider(options.messages, this.name));

    const body: Record<string, unknown> = {
      model: cfg.model?.modelId || options.model,
      messages,
      max_tokens: options.maxTokens ?? CustomAnthropicCompatProvider.DEFAULT_MAX_TOKENS,
      stream: streaming,
    };
    if (system) body.system = system;
    if (options.temperature != null) body.temperature = options.temperature;
    if (options.topP != null) body.top_p = options.topP;
    if (options.stopSequences?.length) body.stop_sequences = options.stopSequences;
    if (options.tools?.length) body.tools = toAnthropicTools(options.tools);
    if (options.extraBody) Object.assign(body, options.extraBody);

    const path = cfg.custom.pathOverride || '/v1/messages';
    const { headers, queryParams } = this.buildHeaders(cfg.custom, cfg.apiKey);
    if (!('anthropic-version' in headers)) {
      headers['anthropic-version'] = CustomAnthropicCompatProvider.DEFAULT_VERSION;
    }
    const url = this.appendQuery(`${cfg.baseUrl}${path}`, queryParams);

    return { url, body, headers };
  }

  private parseResponse(data: AnthropicResponse, modelId: string, latencyMs: number): CompletionResult {
    const blocks = data.content || [];
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && block.name) {
        const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : {};
        toolCalls.push({
          id: block.id || `call_${toolCalls.length}`,
          name: block.name,
          arguments: input,
        });
      }
    }

    const cacheRead = data.usage?.cache_read_input_tokens;
    const cacheCreate = data.usage?.cache_creation_input_tokens;
    const result: CompletionResult = {
      content: textParts.join(''),
      finishReason: mapStopReason(data.stop_reason),
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
        totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
        ...(cacheRead != null ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheCreate != null ? { cacheCreationTokens: cacheCreate } : {}),
      },
      model: data.model || modelId,
      latencyMs,
    };

    if (toolCalls.length) result.toolCalls = toolCalls;
    return result;
  }
}

// ── Request conversion (OpenAI-shaped AgentMessage → Anthropic wire) ──

interface AnthropicBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

/**
 * Convert our internal AgentMessage[] into Anthropic's `system` + `messages`.
 *
 * - system messages are concatenated into the top-level `system` string.
 * - assistant tool calls become `tool_use` blocks.
 * - tool results become `tool_result` blocks on a user turn.
 *
 * Anthropic requires strictly alternating user/assistant turns, so consecutive
 * same-role messages (notably a user message followed by tool results, or
 * several parallel tool results) are merged into one turn with combined blocks.
 */
export function toAnthropicMessages(messages: AgentMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systems: string[] = [];
  const out: AnthropicMessage[] = [];

  const pushMerged = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return; // drop empty turns (Anthropic 400s on them)
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      const prevBlocks = Array.isArray(prev.content)
        ? prev.content
        : [{ type: 'text' as const, text: prev.content }];
      prev.content = [...prevBlocks, ...blocks];
      return;
    }
    out.push({ role, content: blocks });
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.content?.trim()) systems.push(msg.content);
      continue;
    }

    if (msg.role === 'tool') {
      pushMerged('user', [{
        type: 'tool_result',
        // Keep the empty-id fallback: A10's transform normalizes present ids but
        // does not synthesize ids for genuinely-empty ones, and tool_use/
        // tool_result fallback ids must line up (see the ordinal below).
        tool_use_id: msg.toolCallId || 'call_0',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      }]);
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const blocks: AnthropicBlock[] = [];
      if (msg.content?.trim()) blocks.push({ type: 'text', text: msg.content });
      // Index tool_use fallback ids off the tool-call ordinal, not blocks.length
      // (which includes the leading text block) so they line up with the
      // tool_result fallback ids when upstream omitted explicit ids.
      msg.toolCalls.forEach((tc, i) => {
        blocks.push({
          type: 'tool_use',
          id: tc.id || `call_${i}`,
          name: tc.name,
          input: typeof tc.arguments === 'string' ? safeParse(tc.arguments) : (tc.arguments || {}),
        });
      });
      pushMerged('assistant', blocks);
      continue;
    }

    // Plain user / assistant text turn — skip empty text (Anthropic rejects
    // empty text blocks; pushMerged drops the resulting empty turn).
    if (!msg.content?.trim()) continue;
    pushMerged(msg.role === 'assistant' ? 'assistant' : 'user', [{ type: 'text', text: msg.content }]);
  }

  return { system: systems.length ? systems.join('\n\n') : undefined, messages: out };
}

/** Translate OpenAI tool schema → Anthropic tool schema (`input_schema`). */
export function toAnthropicTools(tools: ChatCompletionTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => {
    if (t.type !== 'function') {
      throw new Error(`Unsupported tool type for Anthropic: ${t.type}`);
    }
    return {
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    };
  });
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    // Degradation: an assistant tool_call's arguments weren't valid JSON. Log
    // rather than silently sending {} so the loss is visible in triage.
    modelLogger.warn({ provider: 'custom-anthropic', rawLength: s.length, preview: s.slice(0, 120) }, 'custom-anthropic: tool-call arguments not valid JSON — sending empty input');
    return {};
  }
}

// ── Wire types ──

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return reason || 'stop';
  }
}

function extractErrorMessage(errText: string): string {
  try {
    const parsed = JSON.parse(errText);
    return parsed?.error?.message || parsed?.message || errText.slice(0, 300);
  } catch {
    return errText.slice(0, 300);
  }
}

/**
 * Parse an Anthropic Messages SSE stream. Emits text deltas as `content` and
 * accumulates `tool_use` blocks, surfacing their partial JSON as toolCallDelta.
 */
async function* parseAnthropicSseStream(body: ReadableStream<Uint8Array>, providerName: string, touch?: () => void): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Map content-block index → buffered tool_use call.
  const toolBlocks = new Map<number, { id: string; name: string }>();
  let finishReason: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      touch?.();
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        // Concatenate `data:` lines WITHOUT trimming their content — trimming a
        // continuation line corrupts a JSON payload split across `data:` lines.
        // Per SSE, strip only a single optional leading space.
        let payload = '';
        for (const line of event.split('\n')) {
          if (line.startsWith('data:')) payload += line.slice(5).replace(/^ /, '');
        }
        if (!payload || payload === '[DONE]') continue;

        let data: AnthropicStreamEvent;
        try { data = JSON.parse(payload) as AnthropicStreamEvent; }
        catch { continue; }

        switch (data.type) {
          case 'content_block_start': {
            const block = data.content_block;
            if (block?.type === 'tool_use' && data.index != null) {
              toolBlocks.set(data.index, { id: block.id || `call_${data.index}`, name: block.name || '' });
              yield { toolCallDelta: { id: block.id || `call_${data.index}`, name: block.name, arguments: '' } };
            }
            break;
          }
          case 'content_block_delta': {
            const delta = data.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              yield { content: delta.text };
            } else if (delta?.type === 'input_json_delta' && data.index != null) {
              const tb = toolBlocks.get(data.index);
              if (tb) yield { toolCallDelta: { id: tb.id, name: tb.name, arguments: delta.partial_json || '' } };
            }
            break;
          }
          case 'message_delta': {
            if (data.delta?.stop_reason) finishReason = mapStopReason(data.delta.stop_reason);
            break;
          }
          case 'error': {
            throw new ClassifiedError({
              reason: FailoverReason.UNKNOWN,
              recovery: RecoveryAction.RETRY_NOW,
              message: `custom-anthropic stream error: ${data.error?.message || 'unknown'}`,
              providerHint: providerName,
            });
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (finishReason) yield { finishReason };
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  error?: { message?: string };
}
