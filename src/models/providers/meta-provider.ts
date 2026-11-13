import { normalizeUsage } from './usage';
import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { ClassifiedError, classifyError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { transformMessagesForProvider } from '@/models/message-transform';
import { parseToolCallArguments } from '@/models/tool-call-args';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';

// Meta Muse OpenAI-compatible endpoint. Override via META_BASE_URL.
const META_BASE_URL = 'https://api.meta.ai/v1';

// Every Muse chat model reasons (default effort high), so every call gets the
// long ceiling. It is only a ceiling: fast responses still return immediately.
const REASONING_TIMEOUT_MS = 1_800_000; // 30 min

/** Chat ids only: the image and voice models share the `muse-` prefix. */
export function isMuseChatModel(modelName: string): boolean {
  const lower = (modelName || '').toLowerCase();
  return lower.startsWith('muse-') && !/^muse-(?:image|voice)-/.test(lower);
}

/**
 * A key billed to a Muse Code subscription lists models fine but is refused
 * chat from any other client (403 `client_attestation_denied`). Retrying or
 * rotating cannot help, so it aborts with the fix spelled out.
 */
export function classifyMetaError(err: unknown): ClassifiedError {
  const c = classifyError(err, 'meta');
  if (c.metadata?.code !== 'client_attestation_denied') return c;
  return new ClassifiedError({
    reason: FailoverReason.AUTH_FAILED,
    recovery: RecoveryAction.ABORT,
    message: 'Meta rejected this API key: it is billed to a Muse Code subscription, which only covers the Muse Code client. Use a pay-as-you-go Meta API key, or run the subscription through the cli/muse agent.',
    providerHint: 'meta',
    metadata: c.metadata,
    cause: err,
  });
}

/**
 * Meta (Muse) direct provider — calls the Meta Muse OpenAI-compatible API
 * without going through the LiteLLM proxy. Cached prompt tokens are read from
 * the OpenAI-standard `usage.prompt_tokens_details.cached_tokens`.
 * API key is retrieved from the vault at runtime (env var takes precedence).
 */
export class MetaProvider implements ModelProvider {
  readonly name = 'meta';
  readonly type = 'direct' as const;

  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.META_BASE_URL || META_BASE_URL;
  }

  supportsModel(modelName: string): boolean {
    return isMuseChatModel(modelName);
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = await this.createClient(options.model, options.apiKey);
    const startTime = Date.now();

    const params: ChatCompletionCreateParams = {
      model: options.model,
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

    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to Meta'
    );

    try {
      const response = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
      options.accountingResponse?.({ model: response.model ?? options.model, requestId: response.id, usage: normalizeUsage(response.usage) });
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw classifyMetaError(new Error(`Provider returned empty response (no choices) for model ${params.model || options.model}`));
      }
      const choice = response.choices[0];

      const result: CompletionResult = {
        reasoningContent: (choice.message as any).reasoning_content,
        content: choice.message.content || '',
        finishReason: choice.finish_reason || 'stop',
        usage: normalizeUsage(response.usage),
        requestId: response.id,
        model: response.model,
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

      modelLogger.debug(
        {
          model: response.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          latencyMs,
          hasToolCalls: !!result.toolCalls?.length,
          provider: this.name,
        },
        'Meta completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model, provider: this.name }, 'Meta completion failed');
      throw classifyMetaError(error);
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = await this.createClient(options.model, options.apiKey);

    const params: ChatCompletionCreateParams = {
      model: options.model,
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

    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via Meta');

    let stream;
    try {
      stream = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
    } catch (err) {
      throw classifyMetaError(err);
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

    let reasoning = '';
    for await (const chunk of stream) {
      reasoning += (chunk.choices[0]?.delta as any)?.reasoning_content ?? '';
      if (chunk.usage) yield { usage: normalizeUsage(chunk.usage), requestId: chunk.id, model: chunk.model };
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        yield { content: delta.content };
      }

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
        yield { finishReason: chunk.choices[0].finish_reason, reasoningContent: reasoning || undefined };
      }
    }
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    const startTime = Date.now();

    try {
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        return { healthy: false, error: 'Meta API key not configured' };
      }

      // ponytail: models.list() still answers 200 for a Muse Code subscription
      // key that chat refuses (403 client_attestation_denied), so this reports
      // such a key healthy. Only a chat call can tell, and every Muse model
      // reasons at high effort by default, so a probe would burn paid tokens
      // each health tick. The first real request fails loudly via
      // classifyMetaError instead; add a 1-token chat probe if that is too late.
      const client = new OpenAI({ baseURL: this.baseUrl, apiKey });
      await client.models.list();

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  /**
   * Live-list models from the Meta API (OpenAI-compatible `/models`).
   * Throws if no API key is configured or the upstream call fails.
   */
  async listModels(): Promise<string[]> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Meta API key not configured');
    }
    const client = new OpenAI({ baseURL: this.baseUrl, apiKey });
    const res = await client.models.list();
    return res.data.map((m) => m.id);
  }

  // -- Private helpers --

  private async getApiKey(): Promise<string | null> {
    if (process.env.META_API_KEY) {
      return process.env.META_API_KEY;
    }

    try {
      const { getVault } = await import('@/security/vault');
      const vault = getVault();
      const value = await vault.getByName('system', 'meta_api_key');
      return value || null;
    } catch (err) {
      modelLogger.warn({ err: (err as Error).message, provider: this.name }, 'Meta vault lookup failed; falling back to env var');
      return null;
    }
  }

  private async createClient(_modelName?: string, apiKeyOverride?: string): Promise<OpenAI> {
    // A personal model row (coworking spec §8.3) carries its owner's key in
    // `options.apiKey`; it wins over the install's env/vault key.
    const apiKey = apiKeyOverride || await this.getApiKey();
    if (!apiKey) {
      throw classifyMetaError(new Error('Meta API key not available. Set META_API_KEY or store it in the vault.'));
    }

    return new OpenAI({
      baseURL: this.baseUrl,
      apiKey,
      timeout: REASONING_TIMEOUT_MS,
      maxRetries: 2,
    });
  }

  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    // A10: pairing + id normalization + thinking-strip, shared across providers.
    // Without this, a compacted/re-sliced history can send an assistant
    // `tool_calls` turn with no matching `tool` reply → provider 400.
    return transformMessagesForProvider(messages, this.name).map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content,
          tool_call_id: msg.toolCallId || '',
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        return {
          reasoning_content: msg.reasoningContent,
          role: 'assistant' as const,
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }

      return {
        ...(msg.role === 'assistant' && msg.reasoningContent ? { reasoning_content: msg.reasoningContent } : {}),
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      };
    });
  }
}
