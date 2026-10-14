import { getConfig } from '@/config';
import type { HealthStatus } from '@/core/types';
import { Cache } from '@/db/cache';
import { modelLogger } from '@/utils/logger';
import { type CircuitBreakerStatus, getCircuitBreakerRegistry } from './circuit-breaker';
import { getModelRegistry } from './model-registry';
import { getRateLimitManager, type RateLimitStats } from './rate-limiter';

// Every provider is checked at this pace; the dashboard and the health API
// check on demand (cached HEALTH_CACHE_TTL), so it only sets how stale the
// pushed `onHealthUpdate` view may get.
const HEALTH_CHECK_INTERVAL = 5 * 60_000;
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

/** One provider's health, shared by its models (`HealthChecker.probeProvider`). */
export type ProviderProbe = Omit<ModelHealth, 'name'>;

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
  private cache = new Cache(HEALTH_CACHE_TTL);
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

    const results = await Promise.all(
      [...providerModels].map(([provider, providerModelList]) => this.checkProvider(provider, providerModelList)),
    );

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

    // One check for the provider: what it says (key present, endpoint up,
    // binary installed) holds for each of its models alike. Listed for up to
    // 3 models, by modelId (the LiteLLM-facing name), as before.
    const probe = await this.probeProvider(provider);
    const modelResults: ModelHealth[] = models.slice(0, 3).map((model) => ({ name: model.modelId, ...probe }));

    const result: ProviderHealth = {
      provider,
      status: probe.status,
      latency: probe.status === 'healthy' ? probe.latency : undefined,
      models: modelResults,
      lastChecked: new Date(),
      ...(probe.error ? { error: probe.error } : {}),
    };

    modelLogger.debug({ provider, status: probe.status, modelsChecked: modelResults.length }, 'Provider health check completed');

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
   * The health of `provider` as a whole — every one of its models shares it —
   * cached for HEALTH_CACHE_TTL (10 s after a failure). Never a completion or
   * an embedding: a probe that bills tokens every few minutes is a cost, and
   * on free tiers a rate-limit hit, for no information real traffic does not
   * already give (`classifyError` + circuit breaker).
   *
   * A provider with its own client asks that client (`checkHealth`: key
   * present, a models list, Ollama's `/api/tags`, CLI binaries). One without
   * is served through the LiteLLM proxy: it is as healthy as the proxy is
   * reachable and its circuit breaker is closed.
   */
  async probeProvider(provider: string): Promise<ProviderProbe> {
    const cacheKey = `health:provider:${provider}`;
    const cached = await this.cache.get<ProviderProbe>(cacheKey);
    if (cached) return cached;

    let probe: ProviderProbe;
    const { getProviderRouter } = await import('@/models/providers');
    const client = getProviderRouter().getProviderByName(provider);
    if (client) {
      const startTime = Date.now();
      try {
        const h = await client.checkHealth();
        const latency = h.latencyMs ?? Date.now() - startTime;
        probe = h.healthy
          ? { status: latency < 5000 ? 'healthy' : 'degraded', latency }
          : { status: 'unhealthy', error: h.error };
      } catch (err) {
        probe = { status: 'unhealthy', error: (err as Error).message };
      }
    } else {
      const breakerOpen = getCircuitBreakerRegistry()
        .getAllStatuses()
        .some((cb) => (cb.provider === provider || cb.provider === 'litellm') && cb.state === 'open');
      if (breakerOpen) {
        probe = { status: 'unhealthy', error: 'circuit breaker open' };
      } else {
        const proxy = await this.checkLiteLLMProxy();
        probe = proxy.status === 'healthy'
          ? { status: 'healthy' }
          : { status: 'unhealthy', error: `LiteLLM proxy: ${proxy.message ?? proxy.status}` };
      }
    }

    await this.cache.set(cacheKey, probe, probe.status === 'unhealthy' ? 10 : undefined);
    return probe;
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

    // The `ollama` provider's own check is this same `/api/tags` call: share
    // its cached result (probeProvider) instead of fetching it twice.
    const { getProviderRouter } = await import('@/models/providers');
    if (getProviderRouter().getProviderByName('ollama')) {
      const probe = await this.probeProvider('ollama');
      if (probe.status !== 'unhealthy') {
        return { service: 'ollama', status: probe.status, latency: probe.latency, lastChecked: new Date() };
      }
      const msg = probe.error ?? 'unhealthy';
      const isNetworkError = msg.includes('Unable to connect') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      return {
        service: 'ollama',
        status: isNetworkError ? 'not_configured' : 'unhealthy',
        message: isNetworkError ? 'Not configured' : msg,
        lastChecked: new Date(),
      };
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
        // Only the provider's own "no key" message means unconfigured. A 401 body
        // such as "Your api key … is invalid" used to match 'api key' and show a
        // wrong key as "Not configured" — the opposite of what the user must fix.
        const isNotConfigured = lower.includes('not configured') || lower.includes('not available');
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
