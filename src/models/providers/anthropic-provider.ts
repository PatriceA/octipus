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
import {
  buildCachedSystem,
  clampAnthropicTemperature,
  parseAnthropicResponse,
  parseAnthropicSseStream,
  toAnthropicMessages,
  toAnthropicTools,
} from './custom/anthropic-compat-provider';
import { createIdleAbort, fetchWithRetryAfter, withTimeoutSignal } from './http-retry';
import type { ModelProvider, ProviderHealthStatus } from './interface';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1/';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Opt-in flag (Phase A2) to route this provider through the NATIVE
 * `/v1/messages` endpoint instead of the OpenAI-compat `/v1/chat/completions`
 * one. The native path supports `cache_control` prompt caching (the compat
 * layer strips it); the compat path stays the default until failover parity is
 * proven on the native path (see the follow-ups plan). Default OFF — set
 * ANTHROPIC_NATIVE_MESSAGES=1 to enable and A/B it.
 */
function nativeMessagesEnabled(): boolean {
  const v = process.env.ANTHROPIC_NATIVE_MESSAGES;
  return v === '1' || v === 'true';
}

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
    if (nativeMessagesEnabled()) return this.completeNative(options);
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
      // response_format deliberately NOT sent: Anthropic's OpenAI-compat layer
      // documents it as ignored, so a json_object request silently degrades to
      // prose either way. Callers needing structured output must validate
      // in-app (B1) — don't imply a JSON mode this endpoint doesn't have.
      stream: false,
    };

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = options.toolChoice ?? 'auto';
    }

    // Merge extra body parameters
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    // Prompt caching is NOT supported through Anthropic's OpenAI-compat
    // layer — it requires the native /v1/messages endpoint with
    // cache_control content blocks. Don't send the no-op
    // `anthropic-beta: prompt-caching-2024-07-31` header, and don't read
    // cache_*_input_tokens (always 0 on this path). If you need caching,
    // route this provider through the native @anthropic-ai/sdk.

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to Anthropic'
    );

    try {
      const response = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw classifyError(new Error(`Provider returned empty response (no choices) for model ${params.model || options.model}`), 'anthropic');
      }
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
        'Anthropic completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model, provider: this.name }, 'Anthropic completion failed');
      throw classifyError(error, 'anthropic');
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    if (nativeMessagesEnabled()) {
      yield* this.streamNative(options);
      return;
    }
    const client = await this.createClient();

    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessages(options.messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens || 4096,
      top_p: options.topP,
      stop: options.stopSequences,
      // response_format deliberately NOT sent — ignored by the compat layer
      // (see complete()).
      stream: true,
    };

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = options.toolChoice ?? 'auto';
    }

    // Merge extra body parameters
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via Anthropic');

    let stream;
    try {
      stream = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
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
        // Do NOT re-emit the accumulated tool-call buffers here: every other
        // provider yields only per-delta fragments + the finish chunk, and a
        // consumer that accumulates `arguments +=` across deltas would double
        // the argument string if the full buffer were replayed at finish.
        yield { finishReason: chunk.choices[0].finish_reason };
      }
    }
  }

  // -- Native /v1/messages path (Phase A2, opt-in) --

  /** Build the native Anthropic request body. `system` is cached at the
   * static/volatile boundary (buildCachedSystem) so this path gets prompt
   * caching the OpenAI-compat path can't. Errors keep the 'anthropic' provider
   * tag so failover classification is identical to the compat path. */
  private buildNativeBody(options: CompletionOptions, stream: boolean): Record<string, unknown> {
    const { system, messages } = toAnthropicMessages(transformMessagesForProvider(options.messages, this.name));
    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      max_tokens: options.maxTokens || 4096,
      stream,
    };
    if (system) body.system = buildCachedSystem(system, options.model);
    if (options.temperature != null) body.temperature = clampAnthropicTemperature(options.temperature);
    if (options.topP != null) body.top_p = options.topP;
    if (options.stopSequences?.length) body.stop_sequences = options.stopSequences;
    if (options.tools?.length) {
      body.tools = toAnthropicTools(options.tools);
      // Mirror the compat/default path's tool policy. Anthropic tool_choice:
      // required→any, none→none, else auto (Anthropic's own default).
      body.tool_choice =
        options.toolChoice === 'required' ? { type: 'any' }
        : options.toolChoice === 'none' ? { type: 'none' }
        : { type: 'auto' };
    }
    // NOTE: options.responseFormat is intentionally NOT forwarded — Anthropic's
    // native /v1/messages has no response_format field (structured output is via
    // tools/prefill, not a JSON mode). The compat endpoint accepts it; the native
    // path can't, so a json_object request degrades to prose here. B1's schema
    // enforcement validates in-app and doesn't depend on this, but callers that
    // rely on provider JSON mode must keep the flag off.
    if (options.extraBody) Object.assign(body, options.extraBody);
    return body;
  }

  private async nativeHeaders(): Promise<Record<string, string>> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw classifyError(new Error('Anthropic API key not available. Set ANTHROPIC_API_KEY or store it in the vault.'), 'anthropic');
    }
    return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' };
  }

  private async completeNative(options: CompletionOptions): Promise<CompletionResult> {
    const startTime = Date.now();
    const headers = await this.nativeHeaders();
    const body = this.buildNativeBody(options, false);

    let res: Response;
    try {
      // Same transport as the compat native provider: single Retry-After-honoring
      // 429 retry, and a 120s request timeout ANDed with the caller signal (so a
      // caller signal never disables the timeout).
      res = await fetchWithRetryAfter(`${ANTHROPIC_BASE_URL}messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: withTimeoutSignal(120_000, options.signal),
      }, 'anthropic');
    } catch (err) {
      throw classifyError(err, 'anthropic');
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw classifyError({ status: res.status, message: errText.slice(0, 500) || `HTTP ${res.status}` }, 'anthropic');
    }
    const data = await res.json();
    return parseAnthropicResponse(data, options.model, Date.now() - startTime);
  }

  private async *streamNative(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const headers = await this.nativeHeaders();
    const body = this.buildNativeBody(options, true);

    // Idle (per-chunk) timeout that resets on each streamed chunk — a long but
    // healthy stream must not be killed by a fixed total-duration cap; the caller
    // signal still aborts. Mirrors the compat native provider's stream path.
    const idle = createIdleAbort(180_000, options.signal);
    let res: Response;
    try {
      res = await fetch(`${ANTHROPIC_BASE_URL}messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: idle.signal,
      });
    } catch (err) {
      idle.clear();
      throw classifyError(err, 'anthropic');
    }
    if (!res.ok || !res.body) {
      idle.clear();
      const errText = await res.text().catch(() => '');
      throw classifyError({ status: res.status, message: errText.slice(0, 500) || `HTTP ${res.status}` }, 'anthropic');
    }
    try {
      yield* parseAnthropicSseStream(res.body, 'anthropic', idle.touch);
    } finally {
      idle.clear();
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
