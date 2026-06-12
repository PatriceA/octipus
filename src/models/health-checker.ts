import { getConfig } from '@/config';
import type { HealthStatus } from '@/core/types';
import { RedisCache } from '@/db/redis';
import { modelLogger } from '@/utils/logger';
import { type CircuitBreakerStatus, getCircuitBreakerRegistry } from './circuit-breaker';
import { getLiteLLMClient } from './litellm-client';
import { getModelRegistry } from './model-registry';
import { getRateLimitManager, type RateLimitStats } from './rate-limiter';

const HEALTH_CHECK_INTERVAL = 60000; // 1 minute
const HEALTH_CACHE_TTL = 30; // 30 seconds

export interface ProviderHealth {
  provider: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  models: ModelHealth[];
  lastChecked: Date;
  error?: string;
}

export interface ModelHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  error?: string;
}

/**
 * Shape of the LiteLLM proxy `/health` response. Each endpoint's `model` is
 * the underlying `litellm_params.model` (e.g. `deepseek/deepseek-chat`), so we
 * match it against our registry `modelId` by substring.
 */
interface LiteLLMHealthResponse {
  healthy_endpoints?: Array<{ model?: string }>;
  unhealthy_endpoints?: Array<{ model?: string; error?: string }>;
}

export class HealthChecker {
  private cache = new RedisCache(HEALTH_CACHE_TTL);
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private healthCallbacks: Set<(health: ProviderHealth[]) => void> = new Set();

  /**
   * Check health of all providers
   */
  async checkAllProviders(): Promise<ProviderHealth[]> {
    const cached = await this.cache.get<ProviderHealth[]>('health:all');
    if (cached) return cached;

    const registry = getModelRegistry();
    const models = await registry.getAllModels();

    // Group models by provider
    const providerModels = new Map<string, typeof models>();
    for (const model of models) {
      if (!providerModels.has(model.provider)) {
        providerModels.set(model.provider, []);
      }
      providerModels.get(model.provider)!.push(model);
    }

    const results: ProviderHealth[] = [];

    for (const [provider, providerModelList] of providerModels) {
      const health = await this.checkProvider(provider, providerModelList);
      results.push(health);
    }

    await this.cache.set('health:all', results);

    // Notify listeners
    for (const callback of this.healthCallbacks) {
      try {
        callback(results);
      } catch (error) {
        modelLogger.error({ error }, 'Health callback error');
      }
    }

    return results;
  }

  /**
   * Check health of a specific provider
   */
  async checkProvider(
    provider: string,
    models: { name: string; modelId: string; topics?: string[] | null }[]
  ): Promise<ProviderHealth> {
    // LiteLLM-routed models are NOT probed with per-model completions. The
    // proxy's own `/health` endpoint reports every configured route in a single
    // call, so issuing a real "Hi" completion per model every 60s just burned
    // upstream tokens / rate limit (the same reason direct providers are
    // skipped). Status comes from `/health` + the `litellm` circuit breaker.
    if (provider === 'litellm') {
      return this.checkLiteLLMRoutes(models);
    }

    const modelResults: ModelHealth[] = [];
    let overallLatency = 0;
    let healthyCount = 0;

    for (const model of models.slice(0, 3)) {
      // Check up to 3 models per provider — use modelId (LiteLLM-facing name)
      const isEmbedding = model.topics?.includes('embedding') ||
        model.modelId.includes('embed') || model.name.includes('embed');
      const health = await this.checkModel(model.modelId, provider, isEmbedding);
      modelResults.push(health);

      if (health.status === 'healthy') {
        healthyCount++;
        overallLatency += health.latency || 0;
      }
    }

    const avgLatency = healthyCount > 0 ? overallLatency / healthyCount : undefined;

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (healthyCount === modelResults.length) {
      status = 'healthy';
    } else if (healthyCount > 0) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    const result: ProviderHealth = {
      provider,
      status,
      latency: avgLatency,
      models: modelResults,
      lastChecked: new Date(),
    };

    modelLogger.debug({ provider, status, modelsChecked: modelResults.length }, 'Provider health check completed');

    return result;
  }

  /**
   * Fetch the LiteLLM proxy's `/health` once (cached for HEALTH_CACHE_TTL) —
   * a single call that reports the status of every configured route. Returns
   * null when the proxy is unreachable or errors.
   *
   * NOTE: by default LiteLLM probes upstreams live on each `/health` call. For
   * accurate, token-free results, configure the proxy with
   * `background_health_checks: true` so it serves cached status instead.
   */
  private async fetchLiteLLMModelHealth(): Promise<LiteLLMHealthResponse | null> {
    const cached = await this.cache.get<LiteLLMHealthResponse>('health:litellm:routes');
    if (cached) return cached;

    const config = getConfig();
    try {
      const headers: Record<string, string> = {};
      if (config.litellm.apiKey) {
        headers['Authorization'] = `Bearer ${config.litellm.apiKey}`;
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${config.litellm.proxyUrl}/health`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) return null;

      const data = (await response.json()) as LiteLLMHealthResponse;
      await this.cache.set('health:litellm:routes', data);
      return data;
    } catch (err) {
      modelLogger.debug({ err }, 'LiteLLM /health fetch failed');
      return null;
    }
  }

  /**
   * Build provider health for LiteLLM-routed models WITHOUT issuing any
   * completions. Status is derived from the proxy `/health` endpoint and the
   * `litellm` circuit breaker (real-traffic failure signal).
   */
  private async checkLiteLLMRoutes(
    models: { name: string; modelId: string; topics?: string[] | null }[]
  ): Promise<ProviderHealth> {
    const health = await this.fetchLiteLLMModelHealth();
    const breakerOpen = getCircuitBreakerRegistry()
      .getAllStatuses()
      .some((cb) => cb.provider === 'litellm' && cb.state === 'open');

    const matches = (endpointModel: string | undefined, modelId: string) =>
      !!endpointModel && (endpointModel === modelId || endpointModel.includes(modelId));

    const modelResults: ModelHealth[] = models.map((model) => {
      // Real-traffic failures trump anything the synthetic probe could tell us.
      if (breakerOpen) {
        return { name: model.modelId, status: 'unhealthy', error: 'litellm circuit breaker open' };
      }
      // Proxy unreachable — can't confirm the route; report degraded rather
      // than lie healthy.
      if (!health) {
        return { name: model.modelId, status: 'degraded', error: 'litellm /health unavailable' };
      }
      const unhealthy = health.unhealthy_endpoints?.find((e) => matches(e.model, model.modelId));
      if (unhealthy) {
        return { name: model.modelId, status: 'unhealthy', error: unhealthy.error || 'route reported unhealthy' };
      }
      return { name: model.modelId, status: 'healthy' };
    });

    const healthyCount = modelResults.filter((m) => m.status === 'healthy').length;
    let status: ProviderHealth['status'];
    if (healthyCount === modelResults.length) {
      status = 'healthy';
    } else if (healthyCount > 0) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    const result: ProviderHealth = {
      provider: 'litellm',
      status,
      models: modelResults,
      lastChecked: new Date(),
    };

    modelLogger.debug(
      { provider: 'litellm', status, modelsChecked: modelResults.length },
      'LiteLLM route health resolved via /health (no per-model completion)'
    );

    return result;
  }

  /**
   * Providers that cannot be health-checked via a LiteLLM completion call.
   * CLI tools are local subprocess wrappers; direct providers have their own
   * health endpoints (and probing free-tier OpenRouter models every 60s
   * burns through rate limits — the user sees 429s for no reason).
   */
  private static SKIP_LITELLM_PROVIDERS = new Set([
    'cli', 'ollama', 'openai', 'anthropic', 'gemini', 'deepseek', 'voyage', 'openrouter',
    // Custom (per-model) providers use their free checkHealth() like the native
    // ones — without this they got a real billed "Hi" completion every 60s.
    // Per-model reachability still surfaces lazily via classifyError + circuit breaker.
    'custom-openai', 'custom-anthropic', 'custom-gemini',
  ]);

  /**
   * Model-name patterns that indicate a non-chat model — OCR, vision-only,
   * TTS, transcription, and embedding models. These don't answer "Hi" with
   * a sensible chat response; probing them wastes tokens and pollutes logs.
   * Embeddings are already handled via the `isEmbedding` branch.
   */
  private static NON_CHAT_PATTERNS = /ocr|tts|whisper|transcrib|dall-?e|vision-preview/i;

  /**
   * Check health of a specific model
   */
  async checkModel(modelName: string, provider?: string, isEmbedding?: boolean): Promise<ModelHealth> {
    const cacheKey = `health:model:${modelName}`;
    const cached = await this.cache.get<ModelHealth>(cacheKey);
    if (cached) return cached;

    // Skip LiteLLM completion check for CLI and direct providers — but still
    // ask the provider itself whether it is configured (e.g. API key present).
    // Without this, a provider with no credentials reports healthy, lying to
    // the dashboard.
    const providerPrefix = provider || modelName.split('/')[0];
    if (HealthChecker.SKIP_LITELLM_PROVIDERS.has(providerPrefix)) {
      let status: ModelHealth['status'] = 'healthy';
      let error: string | undefined;
      try {
        const { getProviderRouter } = await import('@/models/providers');
        const p = getProviderRouter().getProviderByName(providerPrefix);
        if (p) {
          const h = await p.checkHealth();
          if (!h.healthy) {
            status = 'unhealthy';
            error = h.error;
          }
        }
      } catch (err) {
        modelLogger.debug({ err, providerPrefix }, 'Direct-provider health check failed');
      }
      const result: ModelHealth = { name: modelName, status, error };
      await this.cache.set(cacheKey, result);
      return result;
    }

    // Skip non-chat models (OCR, TTS, transcription, vision-only) — they
    // don't answer "Hi" sensibly and shouldn't be chat-probed.
    if (!isEmbedding && HealthChecker.NON_CHAT_PATTERNS.test(modelName)) {
      const result: ModelHealth = { name: modelName, status: 'healthy' };
      await this.cache.set(cacheKey, result);
      return result;
    }

    const client = getLiteLLMClient();
    const startTime = Date.now();

    try {
      if (isEmbedding) {
        // Embedding models use the /v1/embeddings endpoint, not /v1/completions
        await client.embed('health check', modelName);
      } else {
        // Send a minimal test request
        await client.complete({
          model: modelName,
          messages: [
            {
              role: 'user',
              content: 'Hi',
              timestamp: new Date(),
            },
          ],
          maxTokens: 1,
          temperature: 0,
        });
      }

      const latency = Date.now() - startTime;

      const result: ModelHealth = {
        name: modelName,
        status: latency < 5000 ? 'healthy' : 'degraded',
        latency,
      };

      await this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      const result: ModelHealth = {
        name: modelName,
        status: 'unhealthy',
        error: (error as Error).message,
      };

      await this.cache.set(cacheKey, result, 10); // Shorter cache for errors
      return result;
    }
  }

  /**
   * Check LiteLLM proxy health
   */
  async checkLiteLLMProxy(): Promise<HealthStatus> {
    const config = getConfig();
    const startTime = Date.now();

    try {
      const headers: Record<string, string> = {};
      if (config.litellm.apiKey) {
        headers['Authorization'] = `Bearer ${config.litellm.apiKey}`;
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${config.litellm.proxyUrl}/health/liveliness`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          service: 'litellm',
          status: 'unhealthy',
          message: `HTTP ${response.status}`,
          lastChecked: new Date(),
        };
      }

      return {
        service: 'litellm',
        status: 'healthy',
        latency: Date.now() - startTime,
        lastChecked: new Date(),
      };
    } catch (error) {
      const msg = (error as Error).message;
      const isTimeout = (error as Error).name === 'AbortError';
      const isNetworkError = msg.includes('Unable to connect') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed');

      return {
        service: 'litellm',
        status: isNetworkError ? 'not_configured' : 'unhealthy',
        message: isTimeout ? 'Health check timed out' : isNetworkError ? 'Not configured' : msg,
        lastChecked: new Date(),
      };
    }
  }

  /**
   * Check Ollama health
   */
  async checkOllama(): Promise<HealthStatus> {
    const config = getConfig();
    const url = config.ollama?.url;

    if (!url) {
      return { service: 'ollama', status: 'not_configured', message: 'Not configured', lastChecked: new Date() };
    }

    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${url}/api/tags`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return { service: 'ollama', status: 'unhealthy', message: `HTTP ${response.status}`, lastChecked: new Date() };
      }

      return { service: 'ollama', status: 'healthy', latency: Date.now() - startTime, lastChecked: new Date() };
    } catch (error) {
      const msg = (error as Error).message;
      const isNetworkError = msg.includes('Unable to connect') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed');

      return {
        service: 'ollama',
        status: isNetworkError ? 'not_configured' : 'unhealthy',
        message: isNetworkError ? 'Not configured' : msg,
        lastChecked: new Date(),
      };
    }
  }

  /**
   * Check a direct provider's health via its checkHealth() method.
   * Returns 'not_configured' when the provider reports a missing API key or connection error.
   */
  async checkDirectProvider(
    name: string,
    provider: { checkHealth(): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> },
  ): Promise<HealthStatus> {
    try {
      const result = await provider.checkHealth();

      if (!result.healthy && result.error) {
        const lower = result.error.toLowerCase();
        const isNotConfigured = lower.includes('not configured') || lower.includes('api key');
        return {
          service: name,
          status: isNotConfigured ? 'not_configured' : 'unhealthy',
          message: isNotConfigured ? 'Not configured' : result.error,
          lastChecked: new Date(),
        };
      }

      return {
        service: name,
        status: result.healthy ? 'healthy' : 'unhealthy',
        latency: result.latencyMs,
        message: result.error,
        lastChecked: new Date(),
      };
    } catch (error) {
      const msg = (error as Error).message;
      const isNetworkError = msg.includes('Unable to connect') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed');

      return {
        service: name,
        status: isNetworkError ? 'not_configured' : 'unhealthy',
        message: isNetworkError ? 'Not configured' : msg,
        lastChecked: new Date(),
      };
    }
  }

  /**
   * Get rate limit stats for all tracked providers
   */
  getRateLimitStats(): RateLimitStats[] {
    return getRateLimitManager().getAllStats();
  }

  /**
   * Get circuit breaker statuses for all tracked providers
   */
  getCircuitBreakerStatuses(): CircuitBreakerStatus[] {
    return getCircuitBreakerRegistry().getAllStatuses();
  }

  /**
   * Get overall system health
   */
  async getSystemHealth(): Promise<{
    overall: 'healthy' | 'degraded' | 'unhealthy';
    services: HealthStatus[];
    providers: ProviderHealth[];
    rateLimits: RateLimitStats[];
    circuitBreakers: CircuitBreakerStatus[];
  }> {
    const [litellm, ollama, providers] = await Promise.all([
      this.checkLiteLLMProxy(),
      this.checkOllama(),
      this.checkAllProviders(),
    ]);

    const services = [litellm, ollama];
    const rateLimits = this.getRateLimitStats();
    const circuitBreakers = this.getCircuitBreakerStatuses();

    // Determine overall status — ignore 'not_configured' services
    const allStatuses = [
      ...services.map((s) => s.status),
      ...providers.map((p) => p.status),
    ].filter((s) => s !== 'not_configured');

    // Factor in circuit breakers — open circuits degrade health
    const openCircuits = circuitBreakers.filter(cb => cb.state === 'open');
    if (openCircuits.length > 0) {
      allStatuses.push('degraded');
    }

    let overall: 'healthy' | 'degraded' | 'unhealthy';
    if (allStatuses.length === 0 || allStatuses.every((s) => s === 'healthy')) {
      overall = 'healthy';
    } else if (allStatuses.some((s) => s === 'healthy')) {
      overall = 'degraded';
    } else {
      overall = 'unhealthy';
    }

    return { overall, services, providers, rateLimits, circuitBreakers };
  }

  /**
   * Start periodic health checks
   */
  startPeriodicChecks(intervalMs: number = HEALTH_CHECK_INTERVAL): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    // Initial check
    this.checkAllProviders().catch((error) => {
      modelLogger.error({ error }, 'Initial health check failed');
    });

    this.checkInterval = setInterval(() => {
      this.checkAllProviders().catch((error) => {
        modelLogger.error({ error }, 'Periodic health check failed');
      });
    }, intervalMs);

    modelLogger.info({ intervalMs }, 'Started periodic health checks');
  }

  /**
   * Stop periodic health checks
   */
  stopPeriodicChecks(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      modelLogger.info('Stopped periodic health checks');
    }
  }

  /**
   * Subscribe to health updates
   */
  onHealthUpdate(callback: (health: ProviderHealth[]) => void): () => void {
    this.healthCallbacks.add(callback);
    return () => {
      this.healthCallbacks.delete(callback);
    };
  }
}

// Singleton instance
let checkerInstance: HealthChecker | null = null;

export function getHealthChecker(): HealthChecker {
  if (!checkerInstance) {
    checkerInstance = new HealthChecker();
  }
  return checkerInstance;
}
