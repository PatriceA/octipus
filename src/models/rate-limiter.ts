import { modelLogger } from '@/utils/logger';

// ── Types ──

export interface RateLimitConfig {
  /** Max concurrent requests to this provider */
  maxConcurrency: number;
  /** Requests per minute limit (0 = unlimited) */
  rpm: number;
  /** Tokens per minute limit (0 = unlimited) */
  tpm: number;
  /** Minimum delay between requests (ms) */
  minDelay: number;
  /** Enable adaptive concurrency adjustment */
  adaptive: boolean;
}

export type RequestPriority = 'interactive' | 'background';

interface QueuedRequest {
  priority: RequestPriority;
  resolve: () => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

interface ProviderMetrics {
  /** Total requests completed */
  totalRequests: number;
  /** Total errors */
  totalErrors: number;
  /** Total 429 responses */
  totalRateLimited: number;
  /** Latency samples (last 100) */
  latencySamples: number[];
  /** Error timestamps in the current 60s window */
  recentErrors: number[];
  /** Current concurrent requests */
  currentConcurrency: number;
  /** Current queue depth */
  queueDepth: number;
  /** Current effective max concurrency (may differ from config if adaptive) */
  effectiveMaxConcurrency: number;
}

export interface RateLimitStats {
  provider: string;
  currentConcurrency: number;
  effectiveMaxConcurrency: number;
  queueDepth: number;
  rpm: { current: number; limit: number };
  backoffUntil: number | null;
  metrics: {
    totalRequests: number;
    totalErrors: number;
    totalRateLimited: number;
    errorRate: number;
    latencyP50: number | null;
    latencyP95: number | null;
    latencyP99: number | null;
  };
}

// ── Default limits per provider ──

const PROVIDER_DEFAULTS: Record<string, RateLimitConfig> = {
  ollama: { maxConcurrency: 2, rpm: 0, tpm: 0, minDelay: 0, adaptive: true },
  openai: { maxConcurrency: 10, rpm: 500, tpm: 150000, minDelay: 0, adaptive: true },
  anthropic: { maxConcurrency: 5, rpm: 300, tpm: 100000, minDelay: 0, adaptive: true },
  gemini: { maxConcurrency: 10, rpm: 360, tpm: 120000, minDelay: 0, adaptive: true },
  deepseek: { maxConcurrency: 5, rpm: 200, tpm: 100000, minDelay: 0, adaptive: true },
  mistral: { maxConcurrency: 5, rpm: 300, tpm: 100000, minDelay: 0, adaptive: true },
  litellm: { maxConcurrency: 20, rpm: 0, tpm: 0, minDelay: 0, adaptive: true },
  'cli-claude': { maxConcurrency: 1, rpm: 10, tpm: 0, minDelay: 2000, adaptive: false },
  'cli-gemini': { maxConcurrency: 1, rpm: 10, tpm: 0, minDelay: 2000, adaptive: false },
  'cli-codex': { maxConcurrency: 1, rpm: 10, tpm: 0, minDelay: 2000, adaptive: false },
};

const RPM_WINDOW_MS = 60_000;
const LATENCY_SAMPLE_SIZE = 100;
const ERROR_WINDOW_MS = 60_000;
const DEFAULT_QUEUE_TIMEOUT = 30_000;
const MAX_BACKOFF_MS = 60_000;
const ADAPTIVE_INCREASE_INTERVAL_MS = 30_000; // How often to try increasing concurrency

/**
 * Per-provider rate limiter with semaphore-based concurrency control,
 * token-bucket RPM limiting, adaptive concurrency, and priority queuing.
 */
class ProviderRateLimiter {
  readonly provider: string;
  private config: RateLimitConfig;
  private baseMaxConcurrency: number;

  // Semaphore state
  private activeSemaphore = 0;
  private effectiveMax: number;
  private queue: QueuedRequest[] = [];

  // RPM sliding window
  private requestTimestamps: number[] = [];

  // TPM sliding window
  private tokenTimestamps: { ts: number; tokens: number }[] = [];

  // Backoff
  private backoffUntil = 0;
  private consecutiveErrors = 0;

  // Min delay tracking
  private lastRequestTime = 0;

  // Adaptive concurrency
  private lastAdaptiveIncrease = 0;

  // Metrics
  private metrics: ProviderMetrics;

  constructor(provider: string, config?: Partial<RateLimitConfig>) {
    this.provider = provider;
    const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.litellm;
    this.config = { ...defaults, ...config };
    this.baseMaxConcurrency = this.config.maxConcurrency;
    this.effectiveMax = this.config.maxConcurrency;
    this.metrics = {
      totalRequests: 0,
      totalErrors: 0,
      totalRateLimited: 0,
      latencySamples: [],
      recentErrors: [],
      currentConcurrency: 0,
      queueDepth: 0,
      effectiveMaxConcurrency: this.effectiveMax,
    };
  }

  /**
   * Acquire a rate-limit token. Resolves when the request is allowed to proceed.
   * Rejects if the queue timeout is exceeded.
   */
  async acquire(priority: RequestPriority = 'interactive', queueTimeout = DEFAULT_QUEUE_TIMEOUT): Promise<void> {
    // Check backoff
    const now = Date.now();
    if (this.backoffUntil > now) {
      const waitMs = this.backoffUntil - now;
      if (waitMs > queueTimeout) {
        throw new RateLimitError(this.provider, `Provider in backoff for ${Math.ceil(waitMs / 1000)}s`, waitMs);
      }
      await sleep(waitMs);
    }

    // Check RPM
    await this.waitForRpm(queueTimeout);

    // Check min delay
    if (this.config.minDelay > 0) {
      const elapsed = Date.now() - this.lastRequestTime;
      if (elapsed < this.config.minDelay) {
        await sleep(this.config.minDelay - elapsed);
      }
    }

    // Acquire semaphore or queue
    if (this.activeSemaphore < this.effectiveMax) {
      this.activeSemaphore++;
      this.metrics.currentConcurrency = this.activeSemaphore;
      this.lastRequestTime = Date.now();
      this.recordRpmTimestamp();
      return;
    }

    // Queue the request
    return new Promise<void>((resolve, reject) => {
      const entry: QueuedRequest = {
        priority,
        resolve: () => {
          this.activeSemaphore++;
          this.metrics.currentConcurrency = this.activeSemaphore;
          this.lastRequestTime = Date.now();
          this.recordRpmTimestamp();
          resolve();
        },
        reject,
        enqueuedAt: Date.now(),
      };

      // Insert by priority (interactive before background)
      if (priority === 'interactive') {
        // Find first background item and insert before it
        const idx = this.queue.findIndex(q => q.priority === 'background');
        if (idx === -1) {
          this.queue.push(entry);
        } else {
          this.queue.splice(idx, 0, entry);
        }
      } else {
        this.queue.push(entry);
      }
      this.metrics.queueDepth = this.queue.length;

      // Set timeout
      const timer = setTimeout(() => {
        const queueIdx = this.queue.indexOf(entry);
        if (queueIdx !== -1) {
          this.queue.splice(queueIdx, 1);
          this.metrics.queueDepth = this.queue.length;
          reject(new RateLimitError(
            this.provider,
            `Queue timeout after ${queueTimeout}ms (depth: ${this.queue.length + 1})`,
            0,
          ));
        }
      }, queueTimeout);

      // Monkey-patch resolve to clear timer
      const origResolve = entry.resolve;
      entry.resolve = () => {
        clearTimeout(timer);
        origResolve();
      };
    });
  }

  /** Release a token after request completes */
  release(): void {
    this.activeSemaphore = Math.max(0, this.activeSemaphore - 1);
    this.metrics.currentConcurrency = this.activeSemaphore;
    this.drainQueue();
  }

  /** Report successful request — used for adaptive concurrency */
  reportSuccess(latencyMs: number, tokensUsed = 0): void {
    this.metrics.totalRequests++;
    this.consecutiveErrors = 0;

    // Record latency
    this.metrics.latencySamples.push(latencyMs);
    if (this.metrics.latencySamples.length > LATENCY_SAMPLE_SIZE) {
      this.metrics.latencySamples.shift();
    }

    // Track TPM
    if (tokensUsed > 0 && this.config.tpm > 0) {
      this.tokenTimestamps.push({ ts: Date.now(), tokens: tokensUsed });
    }

    // Adaptive: try increasing concurrency if things are going well
    if (this.config.adaptive) {
      this.tryAdaptiveIncrease();
    }
  }

  /** Report a failed request */
  reportError(isRateLimit: boolean): void {
    this.metrics.totalRequests++;
    this.metrics.totalErrors++;
    this.consecutiveErrors++;

    const now = Date.now();
    this.metrics.recentErrors.push(now);

    if (isRateLimit) {
      this.metrics.totalRateLimited++;
      this.triggerBackoff();

      // Adaptive: halve concurrency on rate limit
      if (this.config.adaptive) {
        this.effectiveMax = Math.max(1, Math.floor(this.effectiveMax / 2));
        this.metrics.effectiveMaxConcurrency = this.effectiveMax;
        modelLogger.warn({
          provider: this.provider,
          newMax: this.effectiveMax,
        }, 'Adaptive concurrency decreased after rate limit');
      }
    }
  }

  /** Check if TPM budget allows the request */
  hasTokenBudget(estimatedTokens: number): boolean {
    if (this.config.tpm <= 0) return true;

    const now = Date.now();
    this.tokenTimestamps = this.tokenTimestamps.filter(t => now - t.ts < RPM_WINDOW_MS);
    const usedTokens = this.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
    return (usedTokens + estimatedTokens) <= this.config.tpm;
  }

  /** Get current stats for this provider */
  getStats(): RateLimitStats {
    const now = Date.now();

    // Clean up RPM window
    this.requestTimestamps = this.requestTimestamps.filter(ts => now - ts < RPM_WINDOW_MS);

    // Clean up error window
    this.metrics.recentErrors = this.metrics.recentErrors.filter(ts => now - ts < ERROR_WINDOW_MS);

    const recentErrorCount = this.metrics.recentErrors.length;
    const errorRate = this.metrics.totalRequests > 0
      ? recentErrorCount / Math.max(1, this.metrics.totalRequests)
      : 0;

    return {
      provider: this.provider,
      currentConcurrency: this.activeSemaphore,
      effectiveMaxConcurrency: this.effectiveMax,
      queueDepth: this.queue.length,
      rpm: {
        current: this.requestTimestamps.length,
        limit: this.config.rpm,
      },
      backoffUntil: this.backoffUntil > now ? this.backoffUntil : null,
      metrics: {
        totalRequests: this.metrics.totalRequests,
        totalErrors: this.metrics.totalErrors,
        totalRateLimited: this.metrics.totalRateLimited,
        errorRate,
        latencyP50: this.percentile(50),
        latencyP95: this.percentile(95),
        latencyP99: this.percentile(99),
      },
    };
  }

  /** Update config (e.g., from hot-reload) */
  updateConfig(config: Partial<RateLimitConfig>): void {
    Object.assign(this.config, config);
    if (config.maxConcurrency !== undefined) {
      this.baseMaxConcurrency = config.maxConcurrency;
      // Don't go above the new base * 2
      this.effectiveMax = Math.min(this.effectiveMax, this.baseMaxConcurrency * 2);
      this.metrics.effectiveMaxConcurrency = this.effectiveMax;
    }
  }

  // ── Private helpers ──

  private recordRpmTimestamp(): void {
    this.requestTimestamps.push(Date.now());
  }

  private async waitForRpm(timeout: number): Promise<void> {
    if (this.config.rpm <= 0) return;

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const now = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(ts => now - ts < RPM_WINDOW_MS);

      if (this.requestTimestamps.length < this.config.rpm) {
        return;
      }

      // Wait until the oldest request in the window expires
      const oldestTs = this.requestTimestamps[0];
      const waitMs = Math.min(oldestTs + RPM_WINDOW_MS - now + 10, deadline - now);
      if (waitMs <= 0) break;
      await sleep(waitMs);
    }

    throw new RateLimitError(this.provider, `RPM limit (${this.config.rpm}/min) exceeded, queue timeout`, 0);
  }

  private triggerBackoff(): void {
    // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at MAX_BACKOFF_MS
    const backoffMs = Math.min(1000 * Math.pow(2, this.consecutiveErrors - 1), MAX_BACKOFF_MS);
    this.backoffUntil = Date.now() + backoffMs;

    modelLogger.warn({
      provider: this.provider,
      backoffMs,
      consecutiveErrors: this.consecutiveErrors,
    }, 'Rate limit backoff triggered');
  }

  private tryAdaptiveIncrease(): void {
    const now = Date.now();
    if (now - this.lastAdaptiveIncrease < ADAPTIVE_INCREASE_INTERVAL_MS) return;

    // Only increase if error rate is low and we have enough samples
    const recentErrors = this.metrics.recentErrors.filter(ts => now - ts < ERROR_WINDOW_MS).length;
    if (recentErrors > 0) return;

    const maxAllowed = this.baseMaxConcurrency * 2;
    if (this.effectiveMax < maxAllowed) {
      this.effectiveMax = Math.min(this.effectiveMax + 1, maxAllowed);
      this.metrics.effectiveMaxConcurrency = this.effectiveMax;
      this.lastAdaptiveIncrease = now;

      modelLogger.debug({
        provider: this.provider,
        newMax: this.effectiveMax,
      }, 'Adaptive concurrency increased');

      // Try to drain queue with new capacity
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.activeSemaphore < this.effectiveMax) {
      const next = this.queue.shift();
      if (next) {
        this.metrics.queueDepth = this.queue.length;
        next.resolve();
      }
    }
  }

  private percentile(p: number): number | null {
    const samples = this.metrics.latencySamples;
    if (samples.length === 0) return null;

    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}

// ── RateLimitError ──

export class RateLimitError extends Error {
  readonly provider: string;
  readonly retryAfterMs: number;

  constructor(provider: string, message: string, retryAfterMs: number) {
    super(`[${provider}] Rate limit: ${message}`);
    this.name = 'RateLimitError';
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

// ── Centralized rate limit manager ──

export class RateLimitManager {
  private limiters = new Map<string, ProviderRateLimiter>();
  private globalConcurrency = 0;
  private globalMax: number;
  private queueTimeout: number;

  constructor(opts?: { globalMaxConcurrency?: number; queueTimeout?: number }) {
    this.globalMax = opts?.globalMaxConcurrency ?? 50;
    this.queueTimeout = opts?.queueTimeout ?? DEFAULT_QUEUE_TIMEOUT;
  }

  /** Get or create a limiter for a provider */
  private getLimiter(provider: string): ProviderRateLimiter {
    let limiter = this.limiters.get(provider);
    if (!limiter) {
      limiter = new ProviderRateLimiter(provider);
      this.limiters.set(provider, limiter);
    }
    return limiter;
  }

  /**
   * Acquire a rate-limit token for the given provider.
   * Returns a release function that MUST be called when the request completes.
   */
  async acquire(
    provider: string,
    priority: RequestPriority = 'interactive',
  ): Promise<{ release: () => void; reportSuccess: (latencyMs: number, tokensUsed?: number) => void; reportError: (isRateLimit: boolean) => void }> {
    // Check global concurrency
    if (this.globalConcurrency >= this.globalMax) {
      throw new RateLimitError(
        provider,
        `Global concurrency limit reached (${this.globalMax})`,
        1000,
      );
    }

    const limiter = this.getLimiter(provider);
    await limiter.acquire(priority, this.queueTimeout);
    this.globalConcurrency++;

    let released = false;

    return {
      release: () => {
        if (!released) {
          released = true;
          limiter.release();
          this.globalConcurrency = Math.max(0, this.globalConcurrency - 1);
        }
      },
      reportSuccess: (latencyMs: number, tokensUsed?: number) => {
        limiter.reportSuccess(latencyMs, tokensUsed);
      },
      reportError: (isRateLimit: boolean) => {
        limiter.reportError(isRateLimit);
      },
    };
  }

  /** Check if a provider has TPM budget for a request */
  hasTokenBudget(provider: string, estimatedTokens: number): boolean {
    return this.getLimiter(provider).hasTokenBudget(estimatedTokens);
  }

  /** Get stats for a specific provider */
  getProviderStats(provider: string): RateLimitStats {
    return this.getLimiter(provider).getStats();
  }

  /** Get stats for all tracked providers */
  getAllStats(): RateLimitStats[] {
    return Array.from(this.limiters.values()).map(l => l.getStats());
  }

  /** Update configuration for a provider */
  updateProviderConfig(provider: string, config: Partial<RateLimitConfig>): void {
    this.getLimiter(provider).updateConfig(config);
  }

  /** Update global settings */
  updateGlobalConfig(opts: { globalMaxConcurrency?: number; queueTimeout?: number }): void {
    if (opts.globalMaxConcurrency !== undefined) this.globalMax = opts.globalMaxConcurrency;
    if (opts.queueTimeout !== undefined) this.queueTimeout = opts.queueTimeout;
  }
}

// ── Singleton ──

let managerInstance: RateLimitManager | null = null;

export function getRateLimitManager(): RateLimitManager {
  if (!managerInstance) {
    managerInstance = new RateLimitManager();
  }
  return managerInstance;
}

/** Reset singleton (for testing or hot-reload) */
export function resetRateLimitManager(): void {
  managerInstance = null;
}

// ── Utility ──

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
