import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionCreateParams,
} from 'openai/resources/chat/completions';
import type { ModelProvider, ProviderHealthStatus } from './interface';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import { getConfig } from '@/config';
import { modelLogger } from '@/utils/logger';
import type { AgentMessage } from '@/core/types';

/**
 * Known cloud provider model prefixes. If a model name starts with any of these,
 * it is NOT an Ollama model.
 */
const CLOUD_PREFIXES = [
  'gpt-',
  'o1-',
  'o3-',
  'claude-',
  'gemini-',
  'deepseek-',
  'dall-e-',
  'chatgpt-',
  'cli/',
  'text-embedding-',
  'whisper-',
  'tts-',
];

/**
 * Ollama provider -- connects directly to a local Ollama server via its
 * OpenAI-compatible API at {endpoint}/v1.
 */
export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';
  readonly type = 'direct' as const;

  private fixedEndpoint?: string;

  constructor(endpoint?: string) {
    this.fixedEndpoint = endpoint;
  }

  private get endpoint(): string {
    return this.fixedEndpoint || getConfig().ollama.url;
  }

  /**
   * Returns true when the model name does not match any known cloud provider prefix.
   * This is a heuristic: Ollama hosts open-weight models whose names typically
   * do not overlap with cloud API model identifiers.
   */
  supportsModel(modelName: string): boolean {
    const lower = modelName.toLowerCase();
    return !CLOUD_PREFIXES.some((prefix) => lower.startsWith(prefix));
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = this.createClient();
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
      params.tool_choice = 'auto';
    }

    // Merge extra body parameters (e.g. { think: false } for Qwen3)
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to Ollama'
    );

    try {
      const response = await client.chat.completions.create(params);
      const latencyMs = Date.now() - startTime;
      const choice = response.choices[0];

      // Qwen3/thinking models may put output in 'reasoning' instead of 'content'
      const msg = choice.message as unknown as Record<string, unknown>;
      const content = (choice.message.content || msg.reasoning || '') as string;

      const result: CompletionResult = {
        content,
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
        'Ollama completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model, provider: this.name }, 'Ollama completion failed');
      throw error;
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = this.createClient();

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
      params.tool_choice = 'auto';
    }

    // Merge extra body parameters (e.g. { think: false } for Qwen3)
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via Ollama');

    const stream = await client.chat.completions.create(params);

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      // Qwen3/thinking models may stream output in 'reasoning' instead of 'content'
      const deltaAny = delta as Record<string, unknown> | undefined;
      const text = delta?.content || (deltaAny?.reasoning as string | undefined);
      if (text) {
        yield { content: text };
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
    const client = this.createClient();

    modelLogger.debug(
      { model, inputCount: texts.length, provider: this.name },
      'Generating embeddings via Ollama'
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
      const response = await fetch(`${this.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { healthy: false, error: `Ollama HTTP ${response.status}` };
      }

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  // -- Private helpers --

  private createClient(): OpenAI {
    return new OpenAI({
      baseURL: `${this.endpoint}/v1`,
      apiKey: 'ollama', // Ollama doesn't require a real key
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
