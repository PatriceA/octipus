import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { classifyError, ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { coerceDeepseekToolChoice, DEEPSEEK_TEMPLATE_LEAK, isDeepSeekReasoningModel, parseDsmlToolCalls } from '@/models/deepseek-template-recovery';
import { transformMessagesForProvider } from '@/models/message-transform';
import { parseToolCallArguments } from '@/models/tool-call-args';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';
import { extractCachedTokens } from './usage';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

// Reasoner / R1 / Flash-Preview style models can think for minutes.
// Mirror the Grok pattern: long timeout for reasoning, shorter for chat.
const REASONING_TIMEOUT_MS = 1_800_000; // 30 min
const DEFAULT_TIMEOUT_MS = 120_000;

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
      params.tool_choice = coerceDeepseekToolChoice(options.model, options.toolChoice) ?? 'auto';
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
      const response = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
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
          ...extractCachedTokens(response.usage),
        },
        model: response.model,
        latencyMs,
        ...(reasoningContent ? { reasoningContent } : {}),
      };

      // DeepSeek chat-template leak: model emits native tool-call markup
      // (DSML or V3 SentencePiece) as content instead of structured
      // tool_calls. Detection + recovery shared with the LiteLLM proxy path
      // — see @/models/deepseek-template-recovery for the two formats and
      // why throwing TOOL_CALL_INVALID alone is insufficient.
      if (!choice.message.tool_calls?.length && DEEPSEEK_TEMPLATE_LEAK.test(result.content)) {
        // Try to recover the tool calls from the markup before falling back
        // to a retry — DeepSeek-v4-flash/pro get stuck in this pattern, so
        // throwing RETRY_NOW just burns the retry budget. Recovery keeps the
        // agent moving and gets the tools actually executed.
        const recovered = parseDsmlToolCalls(result.content);
        if (recovered.length) {
          modelLogger.warn(
            {
              model: response.model,
              recoveredCount: recovered.length,
              recoveredTools: recovered.map((tc) => tc.name),
              provider: this.name,
            },
            'DeepSeek emitted native DSML/template markup in content channel — recovered as structured tool_calls',
          );
          result.toolCalls = recovered;
          result.content = '';
          return result;
        }

        modelLogger.warn(
          { model: response.model, contentPreview: result.content.slice(0, 200), provider: this.name },
          'DeepSeek emitted native tool-call template in content channel — recovery failed, forcing retry',
        );
        throw new ClassifiedError({
          reason: FailoverReason.TOOL_CALL_INVALID,
          recovery: RecoveryAction.RETRY_NOW,
          message: `DeepSeek chat-template leak: tool-call markup emitted as content, unrecoverable`,
          providerHint: this.name,
          metadata: { contentPreview: result.content.slice(0, 300) },
        });
      }

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
        'DeepSeek completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model, provider: this.name }, 'DeepSeek completion failed');
      throw classifyError(error, 'deepseek');
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
      params.tool_choice = coerceDeepseekToolChoice(options.model, options.toolChoice) ?? 'auto';
    }

    // Merge extra body parameters
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via DeepSeek');

    let stream;
    try {
      stream = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
    } catch (err) {
      throw classifyError(err, 'deepseek');
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    let accumulated = '';
    let reasoning = '';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        accumulated += delta.content;
        yield { content: delta.content };
      }

      // reasoning_content rides outside the typed delta shape on reasoner models.
      const dAny = delta as Record<string, unknown> | undefined;
      if (typeof dAny?.reasoning_content === 'string') reasoning += dAny.reasoning_content;

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
        // DeepSeek chat-template leak also happens in streaming: native
        // tool-call markup lands in the content channel. Recover it as
        // structured tool-call deltas before closing out the stream.
        if (DEEPSEEK_TEMPLATE_LEAK.test(accumulated)) {
          const recovered = parseDsmlToolCalls(accumulated);
          for (const tc of recovered) {
            yield {
              toolCallDelta: {
                id: tc.id,
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            };
          }
        }
        yield {
          finishReason: chunk.choices[0].finish_reason,
          ...(reasoning.trim() ? { reasoningContent: reasoning } : {}),
        };
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

  private async createClient(modelName?: string): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw classifyError(new Error('DeepSeek API key not available. Set DEEPSEEK_API_KEY or store it in the vault.'), 'deepseek');
    }

    const timeout = modelName && isDeepSeekReasoningModel(modelName)
      ? REASONING_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS;

    return new OpenAI({
      baseURL: this.baseUrl,
      apiKey,
      timeout,
      maxRetries: 2,
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
        // Always emit reasoning_content on a tool_calls turn — DeepSeek 400s
        // if it's absent, and it can be absent whenever capture saw an
        // empty/whitespace reasoning or this is a recovered/synthetic call.
        // A minimal placeholder satisfies the requirement.
        out.reasoning_content = msg.reasoningContent || ' ';
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
