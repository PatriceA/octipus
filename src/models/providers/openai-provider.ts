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
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Model names / prefixes supported by the OpenAI API */
const SUPPORTED_PREFIXES = ['gpt-', 'text-embedding-'];
const SUPPORTED_EXACT = new Set(['chatgpt-4o-latest', 'dall-e-3']);
/** o-series reasoning models: o1, o3, o4, … */
const O_SERIES = /^o\d/;

/**
 * Resolve the OpenAI API key: environment first, then the vault. Exported so
 * the realtime STT / TTS voice paths share one resolution rule with the chat
 * provider (mirrors `getMistralApiKey`).
 */
export async function getOpenAIApiKey(): Promise<string | null> {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  try {
    const { getVault } = await import('@/security/vault');
    const value = await getVault().getByName('system', 'openai_api_key');
    return value || null;
  } catch (err) {
    modelLogger.warn({ err: (err as Error).message, provider: 'openai' }, 'OpenAI vault lookup failed; falling back to env var');
    return null;
  }
}

/**
 * o-series (o1/o3/o4) and gpt-5 reject `max_tokens` (want `max_completion_tokens`)
 * and both reject a non-default `temperature` (reasoning models accept only
 * the default of 1 — sending anything else 400s).
 */
function usesMaxCompletionTokens(model: string): boolean {
  const lower = model.toLowerCase();
  return O_SERIES.test(lower) || lower.startsWith('gpt-5');
}
function omitsTemperature(model: string): boolean {
  const lower = model.toLowerCase();
  return O_SERIES.test(lower) || lower.startsWith('gpt-5');
}

/**
 * OpenAI direct provider -- calls the OpenAI API without going through
 * the LiteLLM proxy. API key is retrieved from the vault at runtime.
 */
export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai';
  readonly type = 'direct' as const;

  supportsModel(modelName: string): boolean {
    const lower = modelName.toLowerCase();
    if (SUPPORTED_EXACT.has(lower)) return true;
    if (O_SERIES.test(lower)) return true;
    return SUPPORTED_PREFIXES.some((prefix) => lower.startsWith(prefix));
  }

  /**
   * Build shared completion params (minus `stream`, which the caller sets as a
   * literal so the SDK's overload discriminates the return type). Honors the
   * o-series/gpt-5 param quirks.
   */
  private buildParams(options: CompletionOptions): Omit<ChatCompletionCreateParams, 'stream'> {
    const params: Omit<ChatCompletionCreateParams, 'stream'> = {
      model: options.model,
      messages: this.formatMessages(options.messages),
      top_p: options.topP,
      stop: options.stopSequences,
      response_format: options.responseFormat,
    };
    if (!omitsTemperature(options.model)) params.temperature = options.temperature;
    if (usesMaxCompletionTokens(options.model)) {
      (params as Record<string, unknown>).max_completion_tokens = options.maxTokens;
    } else {
      params.max_tokens = options.maxTokens;
    }
    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = options.toolChoice ?? 'auto';
    }
    if (options.extraBody) Object.assign(params, options.extraBody);
    return params;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = await this.createClient();
    const startTime = Date.now();

    const params: ChatCompletionCreateParams = { ...this.buildParams(options), stream: false };

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to OpenAI'
    );

    try {
      const response = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw classifyError(new Error(`Provider returned empty response (no choices) for model ${params.model || options.model}`), 'openai');
      }
      const choice = response.choices[0];

      const result: CompletionResult = {
        content: choice.message.content || '',
        finishReason: choice.finish_reason || 'stop',
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
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
          latencyMs,
          hasToolCalls: !!result.toolCalls?.length,
          provider: this.name,
        },
        'OpenAI completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model, provider: this.name }, 'OpenAI completion failed');
      throw classifyError(error, 'openai');
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = await this.createClient();

    const params: ChatCompletionCreateParams = { ...this.buildParams(options), stream: true };

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via OpenAI');

    let stream;
    try {
      stream = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
    } catch (err) {
      throw classifyError(err, 'openai');
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

  async embed(texts: string[], model: string): Promise<number[][]> {
    const client = await this.createClient();

    modelLogger.debug(
      { model, inputCount: texts.length, provider: this.name },
      'Generating embeddings via OpenAI'
    );

    const response = await client.embeddings.create({
      model,
      input: texts,
      encoding_format: 'float',
    });

    return response.data.map((d) => d.embedding);
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    const startTime = Date.now();

    try {
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        return { healthy: false, error: 'OpenAI API key not configured' };
      }

      const client = new OpenAI({ baseURL: OPENAI_BASE_URL, apiKey });
      await client.models.list();

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  // -- Private helpers --

  private async getApiKey(): Promise<string | null> {
    // Check environment variable first
    if (process.env.OPENAI_API_KEY) {
      return process.env.OPENAI_API_KEY;
    }

    // Fall back to vault — recoverable: null return triggers a classified AUTH_FAILED on createClient()
    try {
      const { getVault } = await import('@/security/vault');
      const vault = getVault();
      const value = await vault.getByName('system', 'openai_api_key');
      return value || null;
    } catch (err) {
      modelLogger.warn({ err: (err as Error).message, provider: this.name }, 'OpenAI vault lookup failed; falling back to env var');
      return null;
    }
  }

  private async createClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw classifyError(new Error('OpenAI API key not available. Set OPENAI_API_KEY or store it in the vault.'), 'openai');
    }

    return new OpenAI({
      baseURL: OPENAI_BASE_URL,
      apiKey,
      timeout: 120_000,
      maxRetries: 2,
    });
  }

  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    // A10: pairing + id normalization + thinking-strip, shared across providers.
    return transformMessagesForProvider(messages, this.name).map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content,
          tool_call_id: msg.toolCallId as string,
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
