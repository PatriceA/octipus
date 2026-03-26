import { getConfig } from '@/config';
import { getLiteLLMClient } from './litellm-client';
import { getModelRegistry } from './model-registry';
import { RedisCache } from '@/db/redis';
import { modelLogger } from '@/utils/logger';
import type { HealthStatus } from '@/core/types';
import { getRateLimitManager, type RateLimitStats } from './rate-limiter';
import { getCircuitBreakerRegistry, type CircuitBreakerStatus } from './circuit-breaker';

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
   * Providers that cannot be health-checked via a LiteLLM completion call.
   * CLI tools are local subprocess wrappers; direct providers have their own health endpoints.
   */
  private static SKIP_LITELLM_PROVIDERS = new Set(['cli', 'ollama', 'openai', 'anthropic', 'gemini', 'deepseek', 'voyage']);

  /**
   * Check health of a specific model
   */
  async checkModel(modelName: string, provider?: string, isEmbedding?: boolean): Promise<ModelHealth> {
    const cacheKey = `health:model:${modelName}`;
    const cached = await this.cache.get<ModelHealth>(cacheKey);
    if (cached) return cached;

    // Skip LiteLLM completion check for CLI and direct providers
    const providerPrefix = provider || modelName.split('/')[0];
    if (HealthChecker.SKIP_LITELLM_PROVIDERS.has(providerPrefix)) {
      const result: ModelHealth = {
        name: modelName,
        status: 'healthy', // Assume available; provider router handles actual errors
      };
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
