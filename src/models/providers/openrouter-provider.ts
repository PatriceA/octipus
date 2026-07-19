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
import type { ModelProvider, ProviderHealthStatus, QuotaStatus } from './interface';
import { applyAnthropicCacheControl, isAnthropicFamily } from './prompt-cache';
import { extractCachedTokens } from './usage';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter direct provider — calls the OpenRouter API (OpenAI-compatible)
 * without going through the LiteLLM proxy.
 *
 * OpenRouter model IDs use a `provider/model` format (e.g., `openai/gpt-4o`,
 * `anthropic/claude-sonnet-4-6`). However, primary routing is DB-based: models
 * are configured with `provider: 'openrouter'` in the model registry.
 */
export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';
  readonly type = 'direct' as const;

  supportsModel(modelName: string): boolean {
    // OpenRouter model IDs contain a slash (e.g., "openai/gpt-4o").
    // Only match if it looks like an OpenRouter slug and doesn't match other providers.
    if (!modelName.includes('/')) return false;
    // Avoid matching file paths or URLs
    if (modelName.startsWith('/') || modelName.includes('://')) return false;
    return true;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = await this.createClient();
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

    // Anthropic prompt caching (Phase A1): OpenRouter forwards `cache_control`
    // content blocks to Anthropic upstreams, so cache the static prefix.
    if (isAnthropicFamily(options.model)) applyAnthropicCacheControl(params.messages, options.model);

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = options.toolChoice ?? 'auto';
    }

    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to OpenRouter',
    );

    try {
      const response = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
      const latencyMs = Date.now() - startTime;

      if (!response.choices?.length) {
        throw classifyError(new Error(`OpenRouter returned empty response (no choices) for model ${params.model}. The model may be unavailable or overloaded.`), 'openrouter');
      }

      const choice = response.choices[0];
      const usage = response.usage as any; // OpenRouter extends standard usage

      const result: CompletionResult = {
        content: choice.message.content || '',
        finishReason: choice.finish_reason || 'stop',
        usage: {
          inputTokens: usage?.prompt_tokens || 0,
          outputTokens: usage?.completion_tokens || 0,
          totalTokens: usage?.total_tokens || 0,
          ...extractCachedTokens(usage),
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
          cost: usage?.cost,
          provider: this.name,
        },
        'OpenRouter completion successful',
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model, provider: this.name }, 'OpenRouter completion failed');

      // Surface provider-specific error details so users see it's an OpenRouter issue
      const err = error as any;
      const status = err?.status || err?.response?.status;
      const raw = err?.error?.metadata?.raw || err?.error?.message || err?.message || '';
      const providerName = err?.error?.metadata?.provider_name || '';

      if (status === 429) {
        const detail = providerName ? ` (upstream: ${providerName})` : '';
        throw classifyError({ status: 429, message: `OpenRouter rate limit${detail}: ${raw}` }, 'openrouter');
      }
      if (status === 402) {
        throw classifyError({ status: 402, message: `OpenRouter credit exhausted: ${raw}. Add credits at https://openrouter.ai/settings/credits` }, 'openrouter');
      }

      throw classifyError(error, 'openrouter');
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = await this.createClient();

    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessages(options.messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stopSequences,
      stream: true,
    };

    if (isAnthropicFamily(options.model)) applyAnthropicCacheControl(params.messages, options.model);

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = options.toolChoice ?? 'auto';
    }

    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via OpenRouter');

    let stream;
    try {
      stream = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
    } catch (err) {
      throw classifyError(err, 'openrouter');
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
        return { healthy: false, error: 'OpenRouter API key not configured' };
      }

      // Use /auth/key endpoint to verify the key and check credits
      const res = await fetch(`${OPENROUTER_BASE_URL}/auth/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!res.ok) {
        return { healthy: false, error: `OpenRouter API returned ${res.status}` };
      }

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  async getQuotaStatus(): Promise<QuotaStatus> {
    try {
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        return { provider: this.name, hasQuota: false, exhausted: false, lastError: 'API key not configured' };
      }

      const res = await fetch(`${OPENROUTER_BASE_URL}/auth/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!res.ok) {
        return { provider: this.name, hasQuota: false, exhausted: false, lastError: `HTTP ${res.status}` };
      }

      const data = await res.json() as {
        data?: { limit_remaining?: number; usage?: number; is_free_tier?: boolean };
      };

      const remaining = data.data?.limit_remaining;
      const exhausted = remaining != null && remaining <= 0;

      modelLogger.debug({ provider: this.name, creditRemaining: remaining }, 'OpenRouter credit balance');

      return {
        provider: this.name,
        hasQuota: !exhausted,
        exhausted,
      };
    } catch (error) {
      return { provider: this.name, hasQuota: true, exhausted: false, lastError: (error as Error).message };
    }
  }

  // -- Private helpers --

  private async getApiKey(): Promise<string | null> {
    if (process.env.OPENROUTER_API_KEY) {
      return process.env.OPENROUTER_API_KEY;
    }

    // Recoverable: null return triggers a classified AUTH_FAILED on createClient()
    try {
      const { getVault } = await import('@/security/vault');
      const vault = getVault();
      const value = await vault.getByName('system', 'openrouter_api_key');
      return value || null;
    } catch (err) {
      modelLogger.warn({ err: (err as Error).message, provider: this.name }, 'OpenRouter vault lookup failed; falling back to env var');
      return null;
    }
  }

  private async createClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw classifyError(new Error('OpenRouter API key not available. Set OPENROUTER_API_KEY or store it in the vault.'), 'openrouter');
    }

    return new OpenAI({
      baseURL: OPENROUTER_BASE_URL,
      apiKey,
      timeout: 120_000,
      maxRetries: 2,
      defaultHeaders: {
        'HTTP-Referer': 'https://octipus.cc',
        'X-Title': 'Octipus',
      },
    });
  }

  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
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
