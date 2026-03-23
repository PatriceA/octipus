import type { ModelProvider } from './interface';
import { LiteLLMProvider } from './litellm-provider';
import { CLIProvider } from './cli-provider';
import { OllamaProvider } from './ollama-provider';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { GeminiProvider } from './gemini-provider';
import { DeepSeekProvider } from './deepseek-provider';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import { getConfig } from '@/config';
import { modelLogger } from '@/utils/logger';
import { getRateLimitManager, RateLimitError } from '../rate-limiter';
import { getCircuitBreakerRegistry, CircuitOpenError } from '../circuit-breaker';

export type { ModelProvider, ProviderType, ProviderHealthStatus, QuotaStatus } from './interface';
export { LiteLLMProvider } from './litellm-provider';
export { CLIProvider } from './cli-provider';
export { OllamaProvider } from './ollama-provider';
export { OpenAIProvider } from './openai-provider';
export { AnthropicProvider } from './anthropic-provider';
export { GeminiProvider } from './gemini-provider';
export { DeepSeekProvider } from './deepseek-provider';

/**
 * Resolve the rate-limit provider key from a ModelProvider + model name.
 * CLI providers use per-tool keys; others use the provider name.
 */
function resolveRateLimitKey(provider: ModelProvider, model: string): string {
  if (provider.type === 'cli') {
    const lower = model.toLowerCase();
    if (lower.includes('claude')) return 'cli-claude';
    if (lower.includes('gemini')) return 'cli-gemini';
    if (lower.includes('codex')) return 'cli-codex';
    return 'cli-claude'; // default CLI
  }
  return provider.name;
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
 * Priority: CLI → Ollama → OpenAI → Anthropic → Gemini → DeepSeek → LiteLLM (catch-all)
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
    this.providers.push(new DeepSeekProvider());

    // LiteLLM as catch-all fallback — only if configured
    if (config.litellm.proxyUrl) {
      this.providers.push(new LiteLLMProvider());
    }
  }

  /** Get the provider that handles a given model */
  getProvider(modelName: string): ModelProvider {
    for (const provider of this.providers) {
      if (provider.supportsModel(modelName)) {
        return provider;
      }
    }
    // Default to LiteLLM (it accepts everything)
    return this.providers[this.providers.length - 1];
  }

  /** Complete with automatic provider selection, rate limiting, and circuit breaking */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const provider = this.getProvider(options.model);
    const rateLimitKey = resolveRateLimitKey(provider, options.model);

    modelLogger.debug({
      model: options.model,
      provider: provider.name,
      rateLimitKey,
    }, 'Routing completion request');

    // Check circuit breaker
    const circuitBreakers = getCircuitBreakerRegistry();
    try {
      circuitBreakers.checkAllowed(rateLimitKey);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        // Try fallback to LiteLLM if available and it's not the same provider
        if (provider.name !== 'litellm' && this.hasLiteLLM()) {
          modelLogger.warn({
            provider: provider.name,
            model: options.model,
          }, 'Circuit open, falling back to LiteLLM');
          return this.completeViaFallback(options);
        }
      }
      throw error;
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

      return result;
    } catch (error) {
      const isRL = isRateLimitResponse(error);
      token.reportError(isRL);
      circuitBreakers.recordFailure(rateLimitKey);

      // On rate limit, try fallback if available
      if (isRL && provider.name !== 'litellm' && this.hasLiteLLM()) {
        modelLogger.warn({
          provider: provider.name,
          model: options.model,
        }, 'Rate limited, falling back to LiteLLM');
        token.release();
        return this.completeViaFallback(options);
      }

      throw error;
    } finally {
      token.release();
    }
  }

  /** Stream with automatic provider selection, rate limiting, and circuit breaking */
  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const provider = this.getProvider(options.model);
    const rateLimitKey = resolveRateLimitKey(provider, options.model);

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
      if (error instanceof CircuitOpenError && provider.name !== 'litellm' && this.hasLiteLLM()) {
        modelLogger.warn({
          provider: provider.name,
          model: options.model,
        }, 'Circuit open, falling back to LiteLLM for stream');
        yield* this.streamViaFallback(options);
        return;
      }
      throw error;
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
      circuitBreakers.recordFailure(rateLimitKey);
      throw error;
    } finally {
      token.release();
    }
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
      throw error;
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
      throw error;
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
