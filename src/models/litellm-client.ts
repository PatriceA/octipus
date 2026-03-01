import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionCreateParams,
} from 'openai/resources/chat/completions';
import { getConfig } from '@/config';
import { modelLogger } from '@/utils/logger';
import type { AgentMessage, ToolCall } from '@/core/types';

export interface CompletionOptions {
  model: string;
  messages: AgentMessage[];
  tools?: ChatCompletionTool[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
  stopSequences?: string[];
  responseFormat?: { type: 'text' | 'json_object' };
  /** Extra body parameters forwarded to the provider (e.g. { think: false } for Ollama Qwen3) */
  extraBody?: Record<string, unknown>;
}

export interface CompletionResult {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  model: string;
  latencyMs: number;
}

export interface StreamChunk {
  content?: string;
  toolCallDelta?: {
    id: string;
    name?: string;
    arguments?: string;
  };
  finishReason?: string;
}

/**
 * Client for LiteLLM proxy - provides unified API for all LLM providers
 */
export class LiteLLMClient {
  private client: OpenAI;
  private defaultModel: string;

  constructor() {
    const config = getConfig();

    this.client = new OpenAI({
      baseURL: config.litellm.proxyUrl,
      apiKey: config.litellm.apiKey || 'sk-litellm',
      timeout: config.litellm.timeout,
      maxRetries: config.litellm.maxRetries,
    });

    this.defaultModel = 'gpt-oss'; // Fallback; actual default resolved from DB via ModelRegistry
  }

  /**
   * Convert internal message format to OpenAI format
   */
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

  /**
   * Create a chat completion
   */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const startTime = Date.now();

    const params: ChatCompletionCreateParams = {
      model: options.model || this.defaultModel,
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

    // Merge extra body parameters (e.g. { think: false } for Ollama Qwen3)
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, messageCount: options.messages.length }, 'Sending completion request');

    try {
      const response = await this.client.chat.completions.create(params);
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
        },
        'Completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model }, 'Completion failed');
      throw error;
    }
  }

  /**
   * Create a streaming chat completion
   */
  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const params: ChatCompletionCreateParams = {
      model: options.model || this.defaultModel,
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

    modelLogger.debug({ model: params.model }, 'Starting streaming completion');

    const stream = await this.client.chat.completions.create(params);

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

  /**
   * Generate embeddings
   */
  async embed(text: string | string[], model?: string): Promise<number[][]> {
    const input = Array.isArray(text) ? text : [text];
    const embeddingModel = model || 'text-embedding-3-small';

    modelLogger.debug({ model: embeddingModel, inputCount: input.length }, 'Generating embeddings');

    const response = await this.client.embeddings.create({
      model: embeddingModel,
      input,
    });

    return response.data.map((d) => d.embedding);
  }

  /**
   * List available models
   */
  async listModels(): Promise<string[]> {
    const response = await this.client.models.list();
    return response.data.map((m) => m.id);
  }

  /**
   * Check if a specific model is available
   */
  async isModelAvailable(model: string): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.includes(model);
    } catch {
      return false;
    }
  }
}

// Singleton instance
let clientInstance: LiteLLMClient | null = null;

export function getLiteLLMClient(): LiteLLMClient {
  if (!clientInstance) {
    clientInstance = new LiteLLMClient();
  }
  return clientInstance;
}
