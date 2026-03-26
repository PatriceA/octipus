import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionCreateParams,
} from 'openai/resources/chat/completions';
import type { ModelProvider, ProviderHealthStatus } from './interface';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import { modelLogger } from '@/utils/logger';
import type { AgentMessage } from '@/core/types';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/**
 * Gemini direct provider -- calls the Google Gemini API through its
 * OpenAI-compatible endpoint without going through the LiteLLM proxy.
 * API key is retrieved from the vault at runtime.
 */
export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';
  readonly type = 'direct' as const;

  supportsModel(modelName: string): boolean {
    return modelName.toLowerCase().startsWith('gemini-');
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = await this.createClient();
    const startTime = Date.now();

    // Gemini's OpenAI-compatible endpoint is strict — only include params that are set.
    // Sending undefined/null for unsupported fields (response_format, stop) causes 400 Bad Request.
    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessages(options.messages),
      stream: false,
    };

    if (options.temperature != null) params.temperature = options.temperature;
    if (options.maxTokens != null) params.max_tokens = options.maxTokens;
    if (options.topP != null) params.top_p = options.topP;
    if (options.stopSequences?.length) params.stop = options.stopSequences;

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    // Merge extra body parameters (skip response_format — Gemini doesn't support it)
    if (options.extraBody) {
      const { response_format, ...rest } = options.extraBody as Record<string, unknown>;
      Object.assign(params, rest);
    }

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to Gemini'
    );

    try {
      const response = await client.chat.completions.create(params);
      const latencyMs = Date.now() - startTime;
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
        result.toolCalls = choice.message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        }));
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
        'Gemini completion successful'
      );

      return result;
    } catch (error) {
      // Extract detailed error from OpenAI client (Gemini often returns useful error bodies)
      const errDetail = (error as any)?.error?.message || (error as any)?.message || '';
      const status = (error as any)?.status;
      modelLogger.error(
        { error: errDetail, status, model: params.model, provider: this.name, messageCount: options.messages.length },
        'Gemini completion failed',
      );
      throw error;
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = await this.createClient();

    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessages(options.messages),
      stream: true,
    };

    if (options.temperature != null) params.temperature = options.temperature;
    if (options.maxTokens != null) params.max_tokens = options.maxTokens;
    if (options.topP != null) params.top_p = options.topP;
    if (options.stopSequences?.length) params.stop = options.stopSequences;

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    if (options.extraBody) {
      const { response_format, ...rest } = options.extraBody as Record<string, unknown>;
      Object.assign(params, rest);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via Gemini');

    const stream = await client.chat.completions.create(params);

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
        return { healthy: false, error: 'Gemini API key not configured' };
      }

      const client = new OpenAI({ baseURL: GEMINI_BASE_URL, apiKey });
      await client.models.list();

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  // -- Private helpers --

  private async getApiKey(): Promise<string | null> {
    // Check environment variable first
    if (process.env.GEMINI_API_KEY) {
      return process.env.GEMINI_API_KEY;
    }

    // Fall back to vault
    try {
      const { getVault } = await import('@/security/vault');
      const vault = getVault();
      const value = await vault.getByName('system', 'gemini_api_key');
      return value || null;
    } catch {
      return null;
    }
  }

  private async createClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Gemini API key not available. Set GEMINI_API_KEY or store it in the vault.');
    }

    return new OpenAI({
      baseURL: GEMINI_BASE_URL,
      apiKey,
      timeout: 120_000,
      maxRetries: 2,
    });
  }

  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        // Gemini requires non-empty tool_call_id and string content
        return {
          role: 'tool' as const,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          tool_call_id: msg.toolCallId || 'unknown',
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Gemini requires content to be a string (not null) when tool_calls are present
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

      // Gemini doesn't support 'system' role — convert to user message
      if (msg.role === 'system') {
        return {
          role: 'user' as const,
          content: msg.content,
        };
      }

      return {
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      };
    });
  }
}
