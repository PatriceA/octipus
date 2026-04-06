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
  'voyage-',
];

/** Reject model names that look like OpenRouter slugs (contain `/` but aren't `cli/`) */
function looksLikeOpenRouterSlug(name: string): boolean {
  return name.includes('/') && !name.startsWith('cli/');
}

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
    const url = this.fixedEndpoint || getConfig().ollama.url;
    if (!url) throw new Error('Ollama URL not configured');
    return url;
  }

  /**
   * Returns true when the model name does not match any known cloud provider prefix.
   * This is a heuristic: Ollama hosts open-weight models whose names typically
   * do not overlap with cloud API model identifiers.
   */
  supportsModel(modelName: string): boolean {
    const lower = modelName.toLowerCase();
    if (CLOUD_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
    if (looksLikeOpenRouterSlug(lower)) return false;
    return true;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    // Ollama's /v1 endpoint doesn't properly support think:false — use native /api/chat
    // when thinking is disabled (with or without tools)
    if (options.extraBody?.think === false) {
      return this.completeNative(options);
    }

    const client = this.createClient(options.endpoint, options.apiKey);
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

    // Merge extra body parameters (but NOT think:false — that goes to native endpoint)
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

  /**
   * Use Ollama's native /api/chat endpoint which properly supports think:false.
   * The OpenAI-compatible /v1 endpoint ignores this parameter.
   * Supports tools via Ollama's native tool calling format.
   */
  private async completeNative(options: CompletionOptions): Promise<CompletionResult> {
    const resolvedEndpoint = options.endpoint || this.endpoint;
    const startTime = Date.now();

    // Format messages for native API — include tool_call_id for tool responses
    const messages = this.formatMessages(options.messages).map((m) => {
      const native: Record<string, unknown> = { role: m.role };
      if (m.role === 'tool') {
        native.content = typeof (m as any).content === 'string' ? (m as any).content : '';
      } else if (m.role === 'assistant' && (m as any).tool_calls?.length) {
        native.content = (m as any).content || '';
        native.tool_calls = (m as any).tool_calls;
      } else {
        native.content = typeof (m as any).content === 'string' ? (m as any).content : '';
      }
      return native;
    });

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: false,
      think: false,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
        ...(options.topP != null ? { top_p: options.topP } : {}),
        ...(options.stopSequences?.length ? { stop: options.stopSequences } : {}),
      },
    };

    // Add tools in Ollama's native format
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }

    modelLogger.debug(
      { model: options.model, messageCount: messages.length, provider: this.name, native: true, hasTools: !!options.tools?.length },
      'Sending native completion request to Ollama (think:false)'
    );

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.apiKey) headers['Authorization'] = `Bearer ${options.apiKey}`;

    const response = await fetch(`${resolvedEndpoint}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      throw new Error(`Ollama native API error (${response.status}): ${err}`);
    }

    const data = await response.json() as {
      message: { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> };
      done: boolean;
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const latencyMs = Date.now() - startTime;

    const result: CompletionResult = {
      content: data.message.content || '',
      finishReason: data.done_reason || 'stop',
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
      model: options.model,
      latencyMs,
    };

    // Parse tool calls from native response
    if (data.message.tool_calls?.length) {
      result.toolCalls = data.message.tool_calls.map((tc, i) => ({
        id: `call_${i}`,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
    }

    modelLogger.debug(
      {
        model: options.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        latencyMs,
        hasToolCalls: !!result.toolCalls?.length,
        provider: this.name,
        native: true,
      },
      'Ollama native completion successful'
    );

    return result;
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = this.createClient(options.endpoint, options.apiKey);

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
    const url = this.fixedEndpoint || getConfig().ollama.url;
    if (!url) {
      return { healthy: false, error: 'Ollama URL not configured' };
    }

    const startTime = Date.now();

    try {
      const response = await fetch(`${url}/api/tags`, {
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

  private createClient(endpointOverride?: string, apiKeyOverride?: string): OpenAI {
    const base = endpointOverride || this.endpoint;
    return new OpenAI({
      baseURL: `${base}/v1`,
      apiKey: apiKeyOverride || 'ollama',
      timeout: 120_000,
      maxRetries: 2,
    });
  }

  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        // Ollama's OpenAI-compat endpoint requires tool_call_id to match the
        // assistant's tool_calls[].id exactly, and content must be a string.
        // Ensure content is always a plain string (not undefined/null).
        return {
          role: 'tool' as const,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          tool_call_id: msg.toolCallId || 'call_0',
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Ollama requires content to be null (not empty string) when tool_calls are present.
        // Some Ollama versions reject the message if content is '' alongside tool_calls.
        return {
          role: 'assistant' as const,
          content: msg.content?.trim() || null,
          tool_calls: msg.toolCalls.map((tc, i) => ({
            id: tc.id || `call_${i}`,
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
