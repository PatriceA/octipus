import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { classifyError, ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { repairTruncatedJson } from '@/utils/json-repair';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';
import { extractCachedTokens } from './usage';

const GROK_BASE_URL = 'https://api.x.ai/v1';

// Reasoning streams may run minutes; vendor recommends ~3600s client timeout.
// https://docs.x.ai/docs/guides/streaming-response
const REASONING_TIMEOUT_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Grok (xAI) direct provider. OpenAI-compatible API at https://api.x.ai/v1.
 * https://docs.x.ai/docs/overview
 */
export class GrokProvider implements ModelProvider {
  readonly name = 'grok';
  readonly type = 'direct' as const;

  supportsModel(modelName: string): boolean {
    const lower = modelName.toLowerCase();
    return lower.startsWith('grok-') || lower.startsWith('xai/');
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
      params.tool_choice = 'auto';
    }

    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to Grok'
    );

    try {
      const response = await client.chat.completions.create(params);
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw classifyError(new Error(`Provider returned empty response (no choices) for model ${params.model || options.model}`), 'grok');
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
          const rawArgs = tc.function.arguments || '';
          try {
            return { id: tc.id, name: tc.function.name, arguments: JSON.parse(rawArgs) as Record<string, unknown> };
          } catch (parseErr) {
            const repaired = repairTruncatedJson(rawArgs);
            if (repaired) {
              try {
                const parsed = JSON.parse(repaired) as Record<string, unknown>;
                modelLogger.warn(
                  { toolName: tc.function.name, rawLength: rawArgs.length, provider: this.name },
                  'Recovered truncated tool-call JSON via repairTruncatedJson',
                );
                return { id: tc.id, name: tc.function.name, arguments: parsed };
              } catch { /* fall through */ }
            }
            throw new ClassifiedError({
              reason: FailoverReason.TOOL_CALL_INVALID,
              recovery: RecoveryAction.RETRY_NOW,
              message: `Malformed tool call JSON from ${this.name} for tool "${tc.function.name}": ${(parseErr as Error).message}`,
              providerHint: this.name,
              metadata: { toolName: tc.function.name, raw: rawArgs.slice(0, 300) },
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
        'Grok completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model, provider: this.name }, 'Grok completion failed');
      throw classifyError(error, 'grok');
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
      params.tool_choice = 'auto';
    }

    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via Grok');

    let stream;
    try {
      stream = await client.chat.completions.create(params);
    } catch (err) {
      throw classifyError(err, 'grok');
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        yield { content: delta.content };
      }

      // Vendor: tool calls are NOT streamed token-by-token — full call arrives in one delta.
      // https://docs.x.ai/docs/guides/function-calling
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
        return { healthy: false, error: 'Grok (xAI) API key not configured' };
      }

      const client = new OpenAI({ baseURL: GROK_BASE_URL, apiKey });
      await client.models.list();

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  // -- Private helpers --

  private async getApiKey(): Promise<string | null> {
    if (process.env.XAI_API_KEY) {
      return process.env.XAI_API_KEY;
    }

    try {
      const { getVault } = await import('@/security/vault');
      const vault = getVault();
      const value = await vault.getByName('system', 'xai_api_key');
      return value || null;
    } catch (err) {
      modelLogger.warn({ err: (err as Error).message, provider: this.name }, 'Grok vault lookup failed; falling back to env var');
      return null;
    }
  }

  private async createClient(modelName: string): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw classifyError(new Error('Grok (xAI) API key not available. Set XAI_API_KEY or store it in the vault.'), 'grok');
    }

    // Reasoning models can stream for minutes — bump timeout per vendor guidance.
    // Per xAI docs, grok-4, grok-code-*, grok-3-mini and *-reasoning all reason.
    // Only "*-non-reasoning" variants are explicitly non-reasoning.
    const lower = modelName.toLowerCase();
    const isExplicitlyNonReasoning = /non-reasoning/.test(lower);
    const isReasoning = !isExplicitlyNonReasoning && (
      /reasoning/.test(lower) ||
      /^grok-4(\b|-)/.test(lower) ||
      /^grok-code/.test(lower) ||
      /^grok-3-mini/.test(lower)
    );
    const timeout = isReasoning ? REASONING_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

    return new OpenAI({
      baseURL: GROK_BASE_URL,
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
