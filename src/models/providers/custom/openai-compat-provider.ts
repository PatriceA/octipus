import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { classifyError } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from '../interface';
import { BaseCustomProvider } from './base-custom-provider';

/**
 * Custom OpenAI-compatible provider.
 *
 * Handles any HTTP endpoint that speaks OpenAI's `/v1/chat/completions` wire
 * protocol: vLLM, Together, Groq, Fireworks, DeepInfra, custom internal proxies,
 * and self-hosted Ollama variants behind reverse proxies.
 *
 * Configuration lives entirely on the model_config row:
 *   - endpoint: base URL (e.g. https://api.example.com)
 *   - apiKeyRef: vault key name, or 'env:VAR_NAME'
 *   - metadata.customProvider.auth: bearer | header | query
 *   - metadata.customProvider.pathOverride: defaults to '/v1/chat/completions'
 *   - metadata.customProvider.extraHeaders: optional headers
 */
export class CustomOpenAICompatProvider extends BaseCustomProvider implements ModelProvider {
  readonly name = 'custom-openai';
  readonly type = 'direct' as const;
  protected readonly providerName = 'custom-openai';

  /**
   * supportsModel returns true unconditionally — actual routing is done by
   * ProviderRouter.resolveProvider() which matches by `provider` column on the
   * model row. The name-based heuristic path will not reach this provider since
   * no caller dispatches by name without a DB lookup for custom providers.
   */
  supportsModel(_modelName: string): boolean {
    return false;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const cfg = await this.resolveModelConfig(options.model, options);
    const client = this.createClient(cfg.baseUrl, cfg.apiKey, cfg.custom.extraHeaders);
    const startTime = Date.now();

    const params: ChatCompletionCreateParams = {
      model: cfg.model?.modelId || options.model,
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

    if (options.extraBody) Object.assign(params, options.extraBody);

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name, baseUrl: cfg.baseUrl },
      'Sending completion request to custom-openai',
    );

    try {
      const response = await client.chat.completions.create(params);
      const latencyMs = Date.now() - startTime;
      const choice = response.choices?.[0];
      if (!choice) {
        throw classifyError(
          new Error(`Custom provider returned no choices for model '${params.model}'`),
          this.name,
        );
      }

      const result: CompletionResult = {
        content: choice.message.content || '',
        finishReason: choice.finish_reason || 'stop',
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
        },
        model: response.model || cfg.model?.modelId || options.model,
        latencyMs,
      };

      if (choice.message.tool_calls?.length) {
        result.toolCalls = choice.message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function.arguments as Record<string, unknown>),
        }));
      }

      return result;
    } catch (err) {
      modelLogger.error({ err, model: params.model, provider: this.name }, 'custom-openai completion failed');
      throw classifyError(err, this.name);
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const cfg = await this.resolveModelConfig(options.model, options);
    const client = this.createClient(cfg.baseUrl, cfg.apiKey, cfg.custom.extraHeaders);

    const params: ChatCompletionCreateParams = {
      model: cfg.model?.modelId || options.model,
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

    if (options.extraBody) Object.assign(params, options.extraBody);

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via custom-openai');

    const stream = await client.chat.completions.create(params);
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) yield { content: delta.content };

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
    // Custom-OpenAI providers are per-model; without a specific model we cannot
    // probe a single canonical endpoint. Report healthy by default; per-model
    // health is checked at first call via classifyError.
    return { healthy: true };
  }

  // ── Private ──

  private createClient(baseUrl: string, apiKey: string, extraHeaders?: Record<string, string>): OpenAI {
    return new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey,
      timeout: 120_000,
      maxRetries: 2,
      defaultHeaders: extraHeaders,
    });
  }

  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          tool_call_id: msg.toolCallId || 'call_0',
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        return {
          role: 'assistant' as const,
          content: msg.content || '',
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
