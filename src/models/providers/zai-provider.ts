import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { classifyError } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { parseToolCallArguments } from '@/models/tool-call-args';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';
import { extractCachedTokens } from './usage';

// z.ai (Zhipu / GLM) OpenAI-compatible endpoint.
// https://docs.z.ai/guides/overview/quick-start
const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

// GLM reasoning variants (glm-z1, "thinking" mode) can stream for minutes.
// Mirror the Grok/DeepSeek pattern: long timeout for reasoning, shorter for chat.
const REASONING_TIMEOUT_MS = 1_800_000; // 30 min
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Detect GLM reasoning variants by id. GLM-4.5+ and GLM-5+ are hybrid-reasoning
 * flagships (glm-4.6 can think for minutes), so they get the long timeout too —
 * the timeout is only a ceiling, a fast response still returns immediately.
 */
function isZaiReasoningModel(modelName: string): boolean {
  const lower = (modelName || '').toLowerCase();
  return /-z1|reasoning|thinking|glm-4\.[5-9]|glm-[5-9]/.test(lower);
}

/**
 * z.ai (GLM) direct provider — calls the z.ai OpenAI-compatible API without
 * going through the LiteLLM proxy. Prompt caching is automatic on a stable
 * prefix; hit counts arrive under `usage.prompt_tokens_details.cached_tokens`
 * (captured by extractCachedTokens). API key is retrieved from the vault at
 * runtime (env var takes precedence).
 */
export class ZaiProvider implements ModelProvider {
  readonly name = 'zai';
  readonly type = 'direct' as const;

  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.ZAI_BASE_URL || ZAI_BASE_URL;
  }

  supportsModel(modelName: string): boolean {
    const lower = modelName.toLowerCase();
    return lower.startsWith('glm-') || lower.startsWith('zai/');
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = await this.createClient(options.model);
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

    // Merge extra body parameters (e.g. { thinking: { type: 'disabled' } }).
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to z.ai'
    );

    try {
      const response = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw classifyError(new Error(`Provider returned empty response (no choices) for model ${params.model || options.model}`), this.name);
      }
      const choice = response.choices[0];

      const result: CompletionResult = {
        content: choice.message.content || '',
        finishReason: choice.finish_reason || 'stop',
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
          ...extractCachedTokens(response.usage),
        },
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
        'z.ai completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model, provider: this.name }, 'z.ai completion failed');
      throw classifyError(error, this.name);
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = await this.createClient(options.model);

    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessages(options.messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stopSequences,
      stream: true,
    };

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = options.toolChoice ?? 'auto';
    }

    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via z.ai');

    let stream;
    try {
      stream = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
    } catch (err) {
      throw classifyError(err, this.name);
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
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
        yield { finishReason: chunk.choices[0].finish_reason };
      }
    }
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    const startTime = Date.now();

    try {
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        return { healthy: false, error: 'z.ai API key not configured' };
      }

      const client = new OpenAI({ baseURL: this.baseUrl, apiKey });
      await client.models.list();

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  /**
   * Live-list models from the z.ai API (OpenAI-compatible `/models`). Throws if
   * no API key is configured or the upstream call fails — callers fall back to
   * the static catalog / manual entry.
   */
  async listModels(): Promise<string[]> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('z.ai API key not configured');
    }
    const client = new OpenAI({ baseURL: this.baseUrl, apiKey });
    const res = await client.models.list();
    return res.data.map((m) => m.id);
  }

  // -- Private helpers --

  private async getApiKey(): Promise<string | null> {
    if (process.env.ZAI_API_KEY) {
      return process.env.ZAI_API_KEY;
    }

    try {
      const { getVault } = await import('@/security/vault');
      const vault = getVault();
      const value = await vault.getByName('system', 'zai_api_key');
      return value || null;
    } catch (err) {
      modelLogger.warn({ err: (err as Error).message, provider: this.name }, 'z.ai vault lookup failed; falling back to env var');
      return null;
    }
  }

  private async createClient(modelName?: string): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw classifyError(new Error('z.ai API key not available. Set ZAI_API_KEY or store it in the vault.'), this.name);
    }

    const timeout = modelName && isZaiReasoningModel(modelName)
      ? REASONING_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS;

    return new OpenAI({
      baseURL: this.baseUrl,
      apiKey,
      timeout,
      maxRetries: 2,
    });
  }

  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content,
          tool_call_id: msg.toolCallId || '',
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        return {
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
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      };
    });
  }
}
