import { normalizeUsage } from '../usage';
import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { classifyError } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { transformMessagesForProvider } from '@/models/message-transform';
import { parseToolCallArguments } from '@/models/tool-call-args';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from '../interface';
import { BaseCustomProvider, type ResolvedCustomConfig } from './base-custom-provider';

/**
 * Custom OpenAI-compatible provider.
 *
 * Handles any HTTP endpoint that speaks OpenAI's `/v1/chat/completions` wire
 * protocol: vLLM, Together, Groq, Fireworks, DeepInfra, custom internal proxies,
 * and self-hosted Ollama variants behind reverse proxies.
 *
 * Configuration lives entirely on the model_config row:
 *   - endpoint: base URL (e.g. https://api.example.com)
 *   - apiKeyRef: vault key name, or 'env:VAR_NAME'
 *   - metadata.customProvider.auth: bearer | header | query
 *   - metadata.customProvider.pathOverride: defaults to '/v1/chat/completions'
 *   - metadata.customProvider.extraHeaders: optional headers
 */
export class CustomOpenAICompatProvider extends BaseCustomProvider implements ModelProvider {
  readonly name = 'custom-openai';
  readonly type = 'direct' as const;
  protected readonly providerName = 'custom-openai';

  /**
   * Routed by DB `provider` column via ProviderRouter.resolveProvider(), not by
   * the name heuristic — so this returns false (no caller dispatches a custom
   * provider by model-name alone).
   */
  supportsModel(_modelName: string): boolean {
    return false;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const cfg = await this.resolveModelConfig(options.model, options);
    const client = this.createClient(cfg);
    const startTime = Date.now();

    const params: ChatCompletionCreateParams = {
      model: cfg.model?.modelId || options.model,
      messages: this.formatMessages(options.messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stopSequences,
      response_format: options.responseFormat,
      stream: false,
    };

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = options.toolChoice ?? 'auto';
    }

    if (options.extraBody) Object.assign(params, options.extraBody);

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name, baseUrl: cfg.baseUrl },
      'Sending completion request to custom-openai',
    );

    try {
      const response = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
      options.accountingResponse?.({ model: response.model ?? options.model, requestId: response.id, usage: normalizeUsage(response.usage) });
      const latencyMs = Date.now() - startTime;
      const choice = response.choices?.[0];
      if (!choice) {
        throw classifyError(
          new Error(`Custom provider returned no choices for model '${params.model}'`),
          this.name,
        );
      }

      const result: CompletionResult = {
        content: choice.message.content || '',
        finishReason: choice.finish_reason || 'stop',
        usage: normalizeUsage(response.usage),
        requestId: response.id,
        model: response.model || cfg.model?.modelId || options.model,
        latencyMs,
      };

      if (choice.message.tool_calls?.length) {
        result.toolCalls = choice.message.tool_calls.map((tc) => {
          if (tc.type !== 'function') {
            throw new Error(`Unexpected tool call type from ${this.name}: ${tc.type}`);
          }
          return {
            id: tc.id,
            name: tc.function.name,
            arguments: parseToolCallArguments(tc.function.arguments, tc.function.name, this.name),
          };
        });
      }

      return result;
    } catch (err) {
      modelLogger.error({ err, model: params.model, provider: this.name }, 'custom-openai completion failed');
      throw classifyError(err, this.name);
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const cfg = await this.resolveModelConfig(options.model, options);
    const client = this.createClient(cfg);

    const params: ChatCompletionCreateParams = {
      model: cfg.model?.modelId || options.model,
      messages: this.formatMessages(options.messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stopSequences,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = options.toolChoice ?? 'auto';
    }

    if (options.extraBody) Object.assign(params, options.extraBody);

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via custom-openai');

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    let activeParams = params;
    let retriedWithoutUsage = false;
    let receivedUpstreamChunk = false;

    while (true) {
      try {
        const stream = await client.chat.completions.create(activeParams, options.signal ? { signal: options.signal } : undefined);
        for await (const chunk of stream) {
          // Once an upstream chunk arrives, retrying could duplicate output even
          // if that chunk itself carries no user-visible delta.
          receivedUpstreamChunk = true;
          if (chunk.usage) yield { usage: normalizeUsage(chunk.usage), requestId: chunk.id, model: chunk.model };
          const delta = chunk.choices[0]?.delta;

          if (delta?.content) yield { content: delta.content };

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCallBuffers.has(tc.index)) {
                toolCallBuffers.set(tc.index, { id: tc.id || '', name: '', arguments: '' });
              }
              const buffer = toolCallBuffers.get(tc.index)!;
              if (tc.id) buffer.id = tc.id;
              if (tc.function?.name) buffer.name = tc.function.name;
              if (tc.function?.arguments) buffer.arguments += tc.function.arguments;

              yield {
                toolCallDelta: {
                  id: buffer.id,
                  name: tc.function?.name,
                  arguments: tc.function?.arguments,
                },
              };
            }
          }

          if (chunk.choices[0]?.finish_reason) {
            yield { finishReason: chunk.choices[0].finish_reason };
          }
        }
        return;
      } catch (err) {
        const requestedUsage = (activeParams.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
        if (!retriedWithoutUsage && !receivedUpstreamChunk && requestedUsage && isUnsupportedStreamUsageError(err)) {
          retriedWithoutUsage = true;
          activeParams = { ...activeParams };
          delete activeParams.stream_options;
          modelLogger.warn({ model: params.model, provider: this.name }, 'Upstream rejected stream usage; retrying without stream_options');
          continue;
        }
        throw classifyError(err, this.name);
      }
    }
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    // Custom-OpenAI providers are per-model; without a specific model we cannot
    // probe a single canonical endpoint. Report healthy by default; per-model
    // health is checked at first call via classifyError.
    return { healthy: true };
  }

  // ── Private ──

  /**
   * Build the OpenAI SDK client honoring the model row's custom-provider auth
   * (A4). Previously buildHeaders() was never called (header/query auth 401'd,
   * always Bearer), pathOverride was ignored, and `/v1` was double-appended.
   *
   * The SDK always requests `${baseURL}/chat/completions`, so we derive baseURL
   * from pathOverride (default `/v1/chat/completions`) by stripping the trailing
   * `/chat/completions`. Auth: bearer → SDK apiKey (its native path); header/
   * query → buildHeaders()/query params, SDK apiKey unused.
   */
  private createClient(cfg: ResolvedCustomConfig): OpenAI {
    const { headers, queryParams } = this.buildHeaders(cfg.custom, cfg.apiKey);
    const path = cfg.custom.pathOverride || '/v1/chat/completions';
    const prefix = path.replace(/\/chat\/completions\/?$/, '');
    const baseURL = this.appendQuery(`${cfg.baseUrl}${prefix}`, queryParams);
    const isBearer = cfg.custom.auth.type === 'bearer';
    return new OpenAI({
      baseURL,
      // Non-bearer auth travels in defaultHeaders/query; the SDK still requires
      // a non-empty apiKey placeholder. ponytail: an extra Authorization header
      // may ride along on header/query auth — harmless for every gateway seen.
      apiKey: isBearer ? cfg.apiKey : 'unused',
      timeout: 120_000,
      maxRetries: 2,
      defaultHeaders: headers,
    });
  }

  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    // A10: pairing + id normalization + thinking-strip shared across providers.
    return transformMessagesForProvider(messages, this.name).map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          tool_call_id: msg.toolCallId as string,
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        return {
          role: 'assistant' as const,
          content: msg.content || '',
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
            },
          })),
        };
      }

      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      };
    });
  }
}

/** True only for a 400 that identifies the optional streaming-usage field. */
export function isUnsupportedStreamUsageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; message?: unknown; error?: unknown; body?: unknown };
  if (candidate.status !== 400) return false;
  const detail = [candidate.message, candidate.error, candidate.body]
    .map((value) => typeof value === 'string' ? value : safeStringify(value))
    .join(' ');
  return /stream_options|include_usage/i.test(detail);
}

function safeStringify(value: unknown): string {
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}
