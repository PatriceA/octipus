import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { classifyError, ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/** Model names / prefixes supported by the DeepSeek API */
const SUPPORTED_PREFIXES = ['deepseek-'];

/**
 * DeepSeek direct provider -- calls the DeepSeek API (OpenAI-compatible)
 * without going through the LiteLLM proxy. API key is retrieved from the
 * vault at runtime.
 */
export class DeepSeekProvider implements ModelProvider {
  readonly name = 'deepseek';
  readonly type = 'direct' as const;

  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || DEEPSEEK_BASE_URL;
  }

  supportsModel(modelName: string): boolean {
    const lower = modelName.toLowerCase();
    return SUPPORTED_PREFIXES.some((prefix) => lower.startsWith(prefix));
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

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    // Merge extra body parameters
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to DeepSeek'
    );

    try {
      const response = await client.chat.completions.create(params);
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw classifyError(new Error(`Provider returned empty response (no choices) for model ${params.model || options.model}`), 'deepseek');
      }
      const choice = response.choices[0];

      // deepseek-reasoner returns reasoning_content alongside content. Capture
      // it so the next turn can echo it back (DeepSeek rejects with 400
      // "reasoning_content in the thinking mode must be passed back" otherwise).
      const reasoningContent = (choice.message as { reasoning_content?: string }).reasoning_content;

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
        ...(reasoningContent ? { reasoningContent } : {}),
      };

      if (choice.message.tool_calls?.length) {
        result.toolCalls = choice.message.tool_calls.map((tc) => {
          const rawArgs = tc.function.arguments || '';
          try {
            return { id: tc.id, name: tc.function.name, arguments: JSON.parse(rawArgs) as Record<string, unknown> };
          } catch (parseErr) {
            throw new ClassifiedError({
              reason: FailoverReason.TOOL_CALL_INVALID,
              recovery: RecoveryAction.RETRY_NOW,
              message: `Malformed tool call JSON from ${this.name} for tool "${tc.function.name}": ${(parseErr as Error).message}`,
              providerHint: this.name,
              metadata: { toolName: tc.function.name, rawLength: rawArgs.length, raw: rawArgs.slice(0, 300) },
              cause: parseErr,
            });
          }
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
        'DeepSeek completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model, provider: this.name }, 'DeepSeek completion failed');
      throw classifyError(error, 'deepseek');
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

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    // Merge extra body parameters
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via DeepSeek');

    let stream;
    try {
      stream = await client.chat.completions.create(params);
    } catch (err) {
      throw classifyError(err, 'deepseek');
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
        return { healthy: false, error: 'DeepSeek API key not configured' };
      }

      const client = new OpenAI({ baseURL: this.baseUrl, apiKey });
      await client.models.list();

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  /**
   * Live-list models from the DeepSeek API. Returns the array of model IDs
   * the account currently has access to. Throws if no API key is configured
   * or the upstream call fails — callers handle the error and fall back to
   * the static catalog.
   */
  async listModels(): Promise<string[]> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('DeepSeek API key not configured');
    }
    const client = new OpenAI({ baseURL: this.baseUrl, apiKey });
    const res = await client.models.list();
    return res.data.map((m) => m.id);
  }

  // -- Private helpers --

  private async getApiKey(): Promise<string | null> {
    // Check environment variable first
    if (process.env.DEEPSEEK_API_KEY) {
      return process.env.DEEPSEEK_API_KEY;
    }

    // Fall back to vault — recoverable: null return triggers a classified AUTH_FAILED on createClient()
    try {
      const { getVault } = await import('@/security/vault');
      const vault = getVault();
      const value = await vault.getByName('system', 'deepseek_api_key');
      return value || null;
    } catch (err) {
      modelLogger.warn({ err: (err as Error).message, provider: this.name }, 'DeepSeek vault lookup failed; falling back to env var');
      return null;
    }
  }

  private async createClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw classifyError(new Error('DeepSeek API key not available. Set DEEPSEEK_API_KEY or store it in the vault.'), 'deepseek');
    }

    return new OpenAI({
      baseURL: this.baseUrl,
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
        // Echo reasoning_content back when present (DeepSeek thinking mode
        // requires it on every prior assistant turn or returns 400).
        const out: ChatCompletionMessageParam & { reasoning_content?: string } = {
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
        if (msg.reasoningContent) out.reasoning_content = msg.reasoningContent;
        return out;
      }

      const base: ChatCompletionMessageParam & { reasoning_content?: string } = {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      };
      if (msg.role === 'assistant' && msg.reasoningContent) {
        base.reasoning_content = msg.reasoningContent;
      }
      return base;
    });
  }
}
