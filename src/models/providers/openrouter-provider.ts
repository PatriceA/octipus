import { cacheAffinityKey, normalizeUsage } from './usage';
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
import { applyAnthropicCacheControl, isAnthropicFamily, logMissedCacheSplit } from './prompt-cache';

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

  /**
   * The upstream provider that served a given conversation, so every later
   * request in it lands on the same one.
   *
   * OpenRouter load-balances across endpoints per request. Measured live: two
   * identical deepseek calls went to StreamLake then DeepInfra, and GLM rotated
   * across four — a different endpoint is a cold prompt cache, so every turn
   * paid full price. Pinning GLM to the endpoint that served turn 1 read 5376
   * of 5446 input tokens from cache and halved the bill on turn 2.
   *
   * Process-local and unbounded-in-principle, so it is capped and evicted
   * oldest-first. Losing an entry costs one uncached request, nothing more, and
   * upstream caches expire in minutes anyway.
   * ponytail: a Map, not a table — the pin only has to outlive the conversation.
   */
  private static readonly stickyProviders = new Map<string, string>();
  private static readonly STICKY_MAX = 500;

  private static rememberProvider(key: string | undefined, provider: unknown): void {
    if (!key || typeof provider !== 'string' || !provider) return;
    const map = OpenRouterProvider.stickyProviders;
    map.delete(key);
    map.set(key, provider);
    if (map.size > OpenRouterProvider.STICKY_MAX) map.delete(map.keys().next().value!);
  }

  private buildParams(options: CompletionOptions, stream: boolean): ChatCompletionCreateParams {
    const params: ChatCompletionCreateParams = {
      model: options.model, messages: this.formatMessages(options.messages, options.model),
      temperature: options.temperature, max_tokens: options.maxTokens,
      top_p: options.topP, stop: options.stopSequences, response_format: options.responseFormat,
      ...(options.tools?.length ? { tools: options.tools, tool_choice: options.toolChoice ?? 'auto' } : {}),
      ...options.extraBody,
      stream,
    };
    const body = params as unknown as Record<string, unknown>;
    // Routing/cache affinity for this conversation. Sent as `user`, the
    // OpenAI-compatible field OpenRouter is guaranteed to accept and forward —
    // NOT a bespoke top-level `session_id`, which is unverified against the
    // live API and would 400 every request here if the gateway rejects unknown
    // body parameters. Revisit once a live call proves otherwise.
    const key = cacheAffinityKey(options.sessionId, options.userId, options.cacheScope ?? 'root');
    if (key && body.user === undefined) body.user = key;

    // Routing policy: cheapest endpoint that can serve the request, then STAY
    // there for the rest of the conversation (see `stickyProviders`). The pin
    // keeps `allow_fallbacks`, so an endpoint going down costs a cache miss,
    // not a failed turn — and the reply's own `provider` re-pins to whoever
    // actually served it. `require_parameters` is kept where tools or a
    // response format are in play: an endpoint that would silently drop them
    // is not cheaper, it is wrong.
    //
    // An explicit `provider` from extraBody is an operator decision and wins
    // outright — it is spread last, so nothing here overrides it.
    const explicit = body.provider && typeof body.provider === 'object' ? body.provider as Record<string, unknown> : undefined;
    const pinned = OpenRouterProvider.stickyProviders.get(this.stickyKey(options));
    const requireParameters = params.tools?.length || params.response_format ? { require_parameters: true } : {};
    body.provider = explicit
      ? { ...requireParameters, ...explicit }
      : { sort: 'price', ...(pinned ? { order: [pinned], allow_fallbacks: true } : {}), ...requireParameters };
    if (options.cachePolicy !== 'off' && isAnthropicFamily(String(body.model))) {
      const cached = applyAnthropicCacheControl(params.messages, String(body.model), { conversation: Boolean(options.cacheScope) });
      if (!cached.system) logMissedCacheSplit(String(body.model));
    }
    return params;
  }

  /**
   * One conversation on one model. The model is part of the key because the
   * endpoint that serves GLM has nothing to do with the one that serves
   * DeepSeek, and switching model invalidates the upstream cache anyway.
   */
  private stickyKey(options: CompletionOptions): string {
    return `${options.model}::${options.cacheScope ?? options.sessionId ?? ''}`;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = await this.createClient(options.apiKey);
    const startTime = Date.now();

    const params = { ...this.buildParams(options, false), stream: false as const };

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to OpenRouter',
    );

    try {
      const response = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
      // OpenRouter names the endpoint that served this call in a top-level
      // `provider` the OpenAI types don't model. Pin the conversation to it.
      OpenRouterProvider.rememberProvider(this.stickyKey(options), (response as unknown as { provider?: unknown }).provider);
      options.accountingResponse?.({ model: response.model ?? options.model, requestId: response.id, usage: normalizeUsage(response.usage) });
      const latencyMs = Date.now() - startTime;

      if (!response.choices?.length) {
        throw classifyError(new Error(`OpenRouter returned empty response (no choices) for model ${params.model}. The model may be unavailable or overloaded.`), 'openrouter');
      }

      const choice = response.choices[0];
      const usage = response.usage as any; // OpenRouter extends standard usage

      const result: CompletionResult = {
        content: choice.message.content || '',
        finishReason: choice.finish_reason || 'stop',
        usage: normalizeUsage(usage),
        requestId: response.id,
        model: response.model,
        latencyMs,
        providerRaw: { openrouterModel: response.model ?? options.model, reasoning_details: (choice.message as unknown as Record<string, unknown>).reasoning_details,
          reasoning: (choice.message as unknown as Record<string, unknown>).reasoning },
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
    const client = await this.createClient(options.apiKey);

    const params = { ...this.buildParams(options, true), stream: true as const };

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via OpenRouter');

    let stream;
    try {
      stream = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
    } catch (err) {
      throw classifyError(err, 'openrouter');
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

    const reasoning = new Map<string, Record<string, unknown>>();
    let reasoningText = '';
    for await (const chunk of stream) {
      const wire = chunk as unknown as { error?: { message?: string; code?: number }; provider?: unknown };
      if (wire.error) throw classifyError({ status: wire.error.code, message: wire.error.message ?? 'OpenRouter stream failed' }, this.name);
      OpenRouterProvider.rememberProvider(this.stickyKey(options), wire.provider);
      if (chunk.usage) yield { usage: normalizeUsage(chunk.usage), requestId: chunk.id, model: chunk.model };
      const delta = chunk.choices[0]?.delta;
      const details = (delta as unknown as { reasoning_details?: Array<Record<string, unknown>> } | undefined)?.reasoning_details;
      for (const detail of details ?? []) {
        const index = typeof detail.index === 'number' ? `index:${detail.index}` : typeof detail.id === 'string' ? `id:${detail.id}` : `anonymous:${reasoning.size}`;
        const prior = reasoning.get(index);
        const merged = { ...prior, ...detail };
        for (const field of ['text', 'data', 'summary', 'signature']) {
          if (typeof prior?.[field] === 'string' && typeof detail[field] === 'string') merged[field] = prior[field] + detail[field];
        }
        reasoning.set(index, merged);
      }
      const plainReasoning = (delta as unknown as { reasoning?: string } | undefined)?.reasoning;
      if (plainReasoning) reasoningText += plainReasoning;
      if (details?.length || plainReasoning) yield { providerRaw: { openrouterModel: chunk.model ?? options.model,
        reasoning_details: [...reasoning.values()], reasoning: reasoningText || undefined } };

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

  private async createClient(overrideKey?: string): Promise<OpenAI> {
    const apiKey = overrideKey || await this.getApiKey();
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
        'X-OpenRouter-Title': 'Octipus',
      },
    });
  }

  private reasoningFields(message: AgentMessage, model: string): Record<string, unknown> {
    if (message.providerRaw?.openrouterModel !== model) return {};
    const details = message.providerRaw.reasoning_details;
    if (Array.isArray(details) && details.length) return { reasoning_details: details };
    return typeof message.providerRaw.reasoning === 'string' ? { reasoning: message.providerRaw.reasoning } : {};
  }

  private formatMessages(messages: AgentMessage[], model: string): ChatCompletionMessageParam[] {
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
          ...this.reasoningFields(msg, model),
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
        ...(msg.role === 'assistant' ? this.reasoningFields(msg, model) : {}),
      };
    });
  }
}
