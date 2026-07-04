import { getConfig } from '@/config';
import { coreLogger, modelLogger } from '@/utils/logger';
import { classifyError, ClassifiedError, FailoverReason } from '@/core/errors/classification';
import { CircuitOpenError, getCircuitBreakerRegistry } from '../circuit-breaker';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import { transformMessagesForProvider } from '../message-transform';
import { getRateLimitManager, } from '../rate-limiter';
import { adjustMaxTokensForThinking, supportsThinking, type ThinkingLevel } from '../thinking-budget';
import { AnthropicProvider } from './anthropic-provider';
import { CLIProvider } from './cli-provider';
import { CustomAnthropicCompatProvider } from './custom/anthropic-compat-provider';
import { CustomGeminiCompatProvider } from './custom/gemini-compat-provider';
import { CustomOpenAICompatProvider } from './custom/openai-compat-provider';
import { DeepSeekProvider } from './deepseek-provider';
import { GeminiProvider } from './gemini-provider';
import { GrokProvider } from './grok-provider';
import type { ModelProvider } from './interface';
import { LiteLLMProvider } from './litellm-provider';
import { MistralProvider } from './mistral-provider';
import { OllamaProvider } from './ollama-provider';
import { OpenAIProvider } from './openai-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { VoyageProvider } from './voyage-provider';

export { AnthropicProvider } from './anthropic-provider';
export { CLIProvider } from './cli-provider';
export { CustomAnthropicCompatProvider } from './custom/anthropic-compat-provider';
export { CustomGeminiCompatProvider } from './custom/gemini-compat-provider';
export { CustomOpenAICompatProvider } from './custom/openai-compat-provider';
export { DeepSeekProvider } from './deepseek-provider';
export { GeminiProvider } from './gemini-provider';
export { GrokProvider } from './grok-provider';
export type { ModelProvider, ProviderHealthStatus, ProviderType, QuotaStatus } from './interface';
export { LiteLLMProvider } from './litellm-provider';
export { MistralProvider } from './mistral-provider';
export { OllamaProvider } from './ollama-provider';
export { OpenAIProvider } from './openai-provider';
export { OpenRouterProvider } from './openrouter-provider';
export { VoyageProvider } from './voyage-provider';

/**
 * Resolve the rate-limit provider key from a ModelProvider + model name.
 * CLI providers use per-tool keys; others use the provider name.
 */
function resolveRateLimitKey(provider: ModelProvider, model: string): string {
  if (provider.type === 'cli') {
    const lower = model.toLowerCase();
    if (lower.includes('claude')) return 'cli-claude';
    // Antigravity (agy) reuses the Gemini rate bucket — same Google backend.
    if (lower.includes('gemini') || lower.includes('antigravity') || lower.includes('agy')) return 'cli-gemini';
    if (lower.includes('codex')) return 'cli-codex';
    if (lower.includes('vibe')) return 'cli-vibe';
    return 'cli-claude'; // default CLI
  }
  return provider.name;
}

/**
 * Circuit-breaker failures should count only TRANSPORT-class problems (5xx,
 * 429, network, timeout, provider-down) — A3. A model emitting bad JSON
 * (TOOL_CALL_INVALID) or a config/auth error must NOT open the provider lane
 * for everyone: one flaky small model would take down the whole provider.
 */
const TRANSPORT_REASONS = new Set<FailoverReason>([
  FailoverReason.RATE_LIMIT,
  FailoverReason.NETWORK_TIMEOUT,
  FailoverReason.PROVIDER_DOWN,
  FailoverReason.RETRY_TRANSIENT,
  FailoverReason.RETRY_WITH_BACKOFF,
]);

export function isTransportFailure(error: unknown): boolean {
  if (error instanceof ClassifiedError) return TRANSPORT_REASONS.has(error.reason);
  const e = error as { status?: number; statusCode?: number; code?: string; message?: string } | null;
  const status = e?.status ?? e?.statusCode;
  if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
  if (typeof e?.code === 'string' && /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|UND_ERR/i.test(e.code)) return true;
  const msg = e?.message || '';
  return /timeout|econn|enotfound|network|socket hang up|fetch failed|getaddrinfo/i.test(msg);
}

/** Check if an error is a 429 rate-limit response */
function isRateLimitResponse(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as any;
  // OpenAI SDK / LiteLLM proxy set status 429
  if (e.status === 429 || e.statusCode === 429) return true;
  // Some SDKs use error.code
  if (e.code === 'rate_limit_exceeded') return true;
  // Check message as fallback
  const msg = e.message || '';
  return /rate.limit|429|too.many.requests/i.test(msg);
}

/**
 * Provider router — selects the right provider based on the model name
 * and handles fallback when a provider is unhealthy or quota-exhausted.
 *
 * Now integrates per-provider rate limiting and circuit breaking.
 *
 * Priority: CLI → Ollama → OpenAI → Anthropic → Gemini → Grok → DeepSeek → Mistral → OpenRouter → LiteLLM (catch-all)
 * LiteLLM is only registered if proxyUrl is configured.
 */
export class ProviderRouter {
  private providers: ModelProvider[] = [];

  constructor() {
    const config = getConfig();

    // Apply config overrides to rate limit manager
    if (config.rateLimit) {
      const manager = getRateLimitManager();
      manager.updateGlobalConfig({
        globalMaxConcurrency: config.rateLimit.globalMaxConcurrency,
        queueTimeout: config.rateLimit.queueTimeout,
      });
      if (config.rateLimit.providers) {
        for (const [provider, overrides] of Object.entries(config.rateLimit.providers)) {
          manager.updateProviderConfig(provider, overrides);
        }
      }
    }

    // Register providers in priority order
    this.providers.push(new CLIProvider());
    this.providers.push(new OllamaProvider());
    this.providers.push(new OpenAIProvider());
    this.providers.push(new AnthropicProvider());
    this.providers.push(new GeminiProvider());
    this.providers.push(new GrokProvider());
    this.providers.push(new DeepSeekProvider());
    this.providers.push(new MistralProvider());
    this.providers.push(new OpenRouterProvider());
    this.providers.push(new VoyageProvider()); // embeddings only

    // Custom providers — routed by DB provider column
    // ('custom-openai' / 'custom-anthropic' / 'custom-gemini'). supportsModel()
    // returns false on these, so they only serve calls dispatched explicitly by
    // name via resolveProvider() / getProviderByName().
    this.providers.push(new CustomOpenAICompatProvider());
    this.providers.push(new CustomAnthropicCompatProvider());
    this.providers.push(new CustomGeminiCompatProvider());

    // LiteLLM as catch-all fallback — only if configured
    if (config.litellm.proxyUrl) {
      this.providers.push(new LiteLLMProvider());
    }
  }

  /** Get the provider that handles a given model (name-based heuristic) */
  getProvider(modelName: string): ModelProvider {
    for (const provider of this.providers) {
      if (provider.supportsModel(modelName)) {
        return provider;
      }
    }
    // Default to LiteLLM (it accepts everything)
    return this.providers[this.providers.length - 1];
  }

  /** Get a provider by its name (e.g., 'ollama', 'openai'). Used for DB-configured provider lookup. */
  getProviderByName(name: string): ModelProvider | undefined {
    return this.providers.find(p => p.name === name);
  }

  /** Resolve provider: check DB config first (handles models like "deepseek-ocr" on Ollama), fall back to name heuristic */
  async resolveProvider(modelName: string): Promise<ModelProvider> {
    try {
      const { getModelRegistry } = await import('@/models/model-registry');
      const dbModel = await getModelRegistry().getModelByModelId(modelName);
      if (dbModel?.provider) {
        const dbProvider = this.getProviderByName(dbModel.provider);
        if (dbProvider) return dbProvider;
      }
    } catch (err) {
      coreLogger.warn(
        { err, modelName },
        'Provider registry lookup failed — falling back to name-based heuristic',
      );
    }
    return this.getProvider(modelName);
  }

  /**
   * Only models configured with provider='litellm' should fall back to the LiteLLM proxy.
   * All direct providers (openai, anthropic, openrouter, ollama, etc.) handle their own
   * errors — falling back to LiteLLM would send model IDs it doesn't know about.
   */
  private canFallbackToLiteLLM(providerName: string): boolean {
    return providerName === 'litellm';
  }

  /** Complete with automatic provider selection, rate limiting, and circuit breaking */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const provider = await this.resolveProvider(options.model);
    const rateLimitKey = resolveRateLimitKey(provider, options.model);

    // Apply thinking budget for reasoning models
    options = await this.applyThinkingBudget(options);

    // Transform messages for cross-model compatibility (normalize tool call IDs,
    // strip thinking blocks) before sending to the target provider.
    options = { ...options, messages: transformMessagesForProvider(options.messages, provider.name) };

    // Mirror litellm-client.complete()'s logging so model usage is visible
    // uniformly regardless of dispatch path (this one is used by the eval
    // command). Log only the direct-provider branch — the litellm path (and the
    // rate-limit/circuit-open fallback below) reaches completeViaProxy, which
    // logs itself; gating here avoids double logging.
    const logsHere = provider.name !== 'litellm';
    if (logsHere) {
      modelLogger.info(
        { model: options.model, provider: provider.name, messageCount: options.messages.length },
        'LLM request',
      );
    }

    // Check circuit breaker
    const circuitBreakers = getCircuitBreakerRegistry();
    try {
      circuitBreakers.checkAllowed(rateLimitKey);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        if (this.canFallbackToLiteLLM(provider.name) && this.hasLiteLLM()) {
          modelLogger.warn({
            provider: provider.name,
            model: options.model,
          }, 'Circuit open, falling back to LiteLLM');
          return this.completeViaFallback(options);
        }
      }
      throw classifyError(error, provider.name);
    }

    // Acquire rate limit token
    const rateLimiter = getRateLimitManager();
    const token = await rateLimiter.acquire(rateLimitKey);

    const startTime = Date.now();
    try {
      const result = await provider.complete(options);
      const latencyMs = Date.now() - startTime;

      token.reportSuccess(latencyMs, result.usage.totalTokens);
      circuitBreakers.recordSuccess(rateLimitKey);

      if (logsHere) {
        modelLogger.info(
          {
            model: result.model || options.model,
            provider: provider.name,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            latencyMs: result.latencyMs ?? latencyMs,
            hasToolCalls: !!result.toolCalls?.length,
            finishReason: result.finishReason,
          },
          'LLM completion',
        );
      }

      return result;
    } catch (error) {
      const isRL = isRateLimitResponse(error);
      token.reportError(isRL);
      // A3: only transport-class failures trip the breaker.
      if (isTransportFailure(error)) circuitBreakers.recordFailure(rateLimitKey);

      // On rate limit, only fall back to LiteLLM for providers it understands
      if (isRL && this.canFallbackToLiteLLM(provider.name) && this.hasLiteLLM()) {
        modelLogger.warn({
          provider: provider.name,
          model: options.model,
        }, 'Rate limited, falling back to LiteLLM');
        token.release();
        return this.completeViaFallback(options);
      }

      throw classifyError(error, provider.name);
    } finally {
      token.release();
    }
  }

  /** Stream with automatic provider selection, rate limiting, and circuit breaking */
  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const provider = await this.resolveProvider(options.model);
    const rateLimitKey = resolveRateLimitKey(provider, options.model);

    // Apply thinking budget and message transformation (same as complete())
    options = await this.applyThinkingBudget(options);
    options = { ...options, messages: transformMessagesForProvider(options.messages, provider.name) };

    modelLogger.debug({
      model: options.model,
      provider: provider.name,
      rateLimitKey,
    }, 'Routing streaming request');

    // Check circuit breaker
    const circuitBreakers = getCircuitBreakerRegistry();
    try {
      circuitBreakers.checkAllowed(rateLimitKey);
    } catch (error) {
      // A2: use the SAME fallback gate as complete() — only litellm-bound
      // models may fall back to the proxy.
      if (error instanceof CircuitOpenError && this.canFallbackToLiteLLM(provider.name) && this.hasLiteLLM()) {
        modelLogger.warn({
          provider: provider.name,
          model: options.model,
        }, 'Circuit open, falling back to LiteLLM for stream');
        yield* this.streamViaFallback(options);
        return;
      }
      throw classifyError(error, provider.name);
    }

    // Acquire rate limit token
    const rateLimiter = getRateLimitManager();
    const token = await rateLimiter.acquire(rateLimitKey);

    const startTime = Date.now();
    try {
      yield* provider.stream(options);

      const latencyMs = Date.now() - startTime;
      token.reportSuccess(latencyMs);
      circuitBreakers.recordSuccess(rateLimitKey);
    } catch (error) {
      const isRL = isRateLimitResponse(error);
      token.reportError(isRL);
      // A3: only transport-class failures trip the breaker.
      if (isTransportFailure(error)) circuitBreakers.recordFailure(rateLimitKey);
      throw classifyError(error, provider.name);
    } finally {
      token.release();
    }
  }

  /** Generate embeddings via the appropriate provider */
  async embed(texts: string[], model: string, endpoint?: string): Promise<number[][]> {
    const provider = this.getProvider(model);

    if (provider.embed) {
      modelLogger.debug(
        { model, provider: provider.name },
        'Routing embed request'
      );
      return provider.embed(texts, model, endpoint);
    }

    throw new Error(`Provider ${provider.name} does not support embeddings`);
  }

  /** Get all registered providers */
  getAllProviders(): ModelProvider[] {
    return [...this.providers];
  }

  /** Get the CLI provider for quota management */
  getCLIProvider(): CLIProvider {
    return this.providers.find(p => p.type === 'cli') as CLIProvider;
  }

  // ── Private helpers ──

  /**
   * If the model supports extended thinking/reasoning, adjust maxTokens
   * to include a thinking budget. Reads the model's DB config for
   * contextWindow and applies a default 'medium' thinking level.
   */
  private async applyThinkingBudget(options: CompletionOptions): Promise<CompletionOptions> {
    if (!supportsThinking(options.model)) return options;

    try {
      const { getModelRegistry } = await import('@/models/model-registry');
      const registry = getModelRegistry();
      const dbModel = await registry.getModelByModelId(options.model) || await registry.getModel(options.model);

      if (!dbModel) return options;

      const metadata = dbModel.metadata as import('@/db/schema/models').ModelMetadata | null;
      // If the model has explicit thinking config in extraBody (e.g. think: false), respect it
      if (metadata?.extraBody && ('think' in metadata.extraBody || 'thinking' in metadata.extraBody)) {
        return options;
      }

      const baseMaxTokens = options.maxTokens || dbModel.defaultMaxTokens || 4096;
      const modelMaxTokens = dbModel.maxTokens || 128000;
      const thinkingLevel: ThinkingLevel = 'medium';

      const { maxTokens, thinkingBudget } = adjustMaxTokensForThinking(
        baseMaxTokens,
        modelMaxTokens,
        thinkingLevel,
      );

      modelLogger.debug({
        model: options.model,
        baseMaxTokens,
        adjustedMaxTokens: maxTokens,
        thinkingBudget,
        level: thinkingLevel,
      }, 'Applied thinking budget');

      return { ...options, maxTokens };
    } catch {
      return options;
    }
  }

  private hasLiteLLM(): boolean {
    return this.providers.some(p => p.name === 'litellm');
  }

  private getLiteLLM(): ModelProvider {
    return this.providers.find(p => p.name === 'litellm')!;
  }

  private async completeViaFallback(options: CompletionOptions): Promise<CompletionResult> {
    const fallback = this.getLiteLLM();
    const token = await getRateLimitManager().acquire('litellm');
    const startTime = Date.now();
    try {
      const result = await fallback.complete(options);
      token.reportSuccess(Date.now() - startTime, result.usage.totalTokens);
      getCircuitBreakerRegistry().recordSuccess('litellm');
      return result;
    } catch (error) {
      token.reportError(isRateLimitResponse(error));
      getCircuitBreakerRegistry().recordFailure('litellm');
      throw classifyError(error, 'litellm');
    } finally {
      token.release();
    }
  }

  private async *streamViaFallback(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const fallback = this.getLiteLLM();
    const token = await getRateLimitManager().acquire('litellm');
    const startTime = Date.now();
    try {
      yield* fallback.stream(options);
      token.reportSuccess(Date.now() - startTime);
      getCircuitBreakerRegistry().recordSuccess('litellm');
    } catch (error) {
      token.reportError(isRateLimitResponse(error));
      getCircuitBreakerRegistry().recordFailure('litellm');
      throw classifyError(error, 'litellm');
    } finally {
      token.release();
    }
  }
}

// Singleton
let routerInstance: ProviderRouter | null = null;

export function getProviderRouter(): ProviderRouter {
  if (!routerInstance) {
    routerInstance = new ProviderRouter();
  }
  return routerInstance;
}
