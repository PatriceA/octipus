import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { classifyError } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1/';

/**
 * Anthropic direct provider -- calls the Anthropic API through its
 * OpenAI-compatible endpoint without going through the LiteLLM proxy.
 * API key is retrieved from the vault at runtime.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly type = 'direct' as const;

  supportsModel(modelName: string): boolean {
    return modelName.toLowerCase().startsWith('claude-');
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = await this.createClient();
    const startTime = Date.now();

    const formatted = this.formatMessages(options.messages);

    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: formatted,
      temperature: options.temperature,
      max_tokens: options.maxTokens || 4096,
      top_p: options.topP,
      stop: options.stopSequences,
      response_format: options.responseFormat,
      stream: false,
    };

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    // Merge extra body parameters
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    // Enable prompt caching for Anthropic models.
    // Mark the system message (first message) with cache_control for efficient caching
    // of the static portion of the system prompt across requests.
    const anthropicHeaders: Record<string, string> = {
      'anthropic-beta': 'prompt-caching-2024-07-31',
    };

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to Anthropic'
    );

    try {
      const response = await client.chat.completions.create(params, {
        headers: anthropicHeaders,
      });
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw classifyError(new Error(`Provider returned empty response (no choices) for model ${params.model || options.model}`), 'anthropic');
      }
      const choice = response.choices[0];

      // Extract cache stats from Anthropic's response (available via extra fields)
      const rawUsage = response.usage as Record<string, unknown> | undefined;
      const cacheReadTokens = (rawUsage?.cache_read_input_tokens || (rawUsage?.prompt_tokens_details as any)?.cached_tokens || 0) as number;
      const cacheCreationTokens = (rawUsage?.cache_creation_input_tokens || 0) as number;

      const result: CompletionResult = {
        content: choice.message.content || '',
        finishReason: choice.finish_reason || 'stop',
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
          cacheReadTokens: cacheReadTokens || undefined,
          cacheCreationTokens: cacheCreationTokens || undefined,
        },
        model: response.model,
        latencyMs,
      };

      if (choice.message.tool_calls?.length) {
        result.toolCalls = choice.message.tool_calls.map((tc) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments); }
          catch { modelLogger.warn({ toolName: tc.function.name, raw: tc.function.arguments.slice(0, 200) }, 'Truncated tool call arguments, using empty object'); }
          return { id: tc.id, name: tc.function.name, arguments: args };
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
        'Anthropic completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model, provider: this.name }, 'Anthropic completion failed');
      throw classifyError(error, 'anthropic');
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = await this.createClient();

    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessages(options.messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens || 4096,
      top_p: options.topP,
      stop: options.stopSequences,
      stream: true,
    };

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    // Merge extra body parameters
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via Anthropic');

    let stream;
    try {
      stream = await client.chat.completions.create(params);
    } catch (err) {
      throw classifyError(err, 'anthropic');
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
        return { healthy: false, error: 'Anthropic API key not configured' };
      }

      // Use Anthropic's native /v1/models endpoint with x-api-key header.
      // The OpenAI SDK sends Bearer auth which Anthropic's models endpoint rejects.
      const res = await fetch(`${ANTHROPIC_BASE_URL}models`, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { healthy: false, error: `Anthropic API error (${res.status}): ${errText.slice(0, 200)}` };
      }

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  // -- Private helpers --

  private async getApiKey(): Promise<string | null> {
    // Check environment variable first
    if (process.env.ANTHROPIC_API_KEY) {
      return process.env.ANTHROPIC_API_KEY;
    }

    // Fall back to vault — recoverable: null return triggers a classified AUTH_FAILED on createClient()
    try {
      const { getVault } = await import('@/security/vault');
      const vault = getVault();
      const value = await vault.getByName('system', 'anthropic_api_key');
      return value || null;
    } catch (err) {
      modelLogger.warn({ err: (err as Error).message, provider: this.name }, 'Anthropic vault lookup failed; falling back to env var');
      return null;
    }
  }

  private async createClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw classifyError(new Error('Anthropic API key not available. Set ANTHROPIC_API_KEY or store it in the vault.'), 'anthropic');
    }

    return new OpenAI({
      baseURL: ANTHROPIC_BASE_URL,
      apiKey,
      timeout: 120_000,
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
