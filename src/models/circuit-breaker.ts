import { modelLogger } from '@/utils/logger';

// ── Types ──

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures to open the circuit */
  failureThreshold: number;
  /** Error rate (0-1) in the window that triggers opening */
  errorRateThreshold: number;
  /** Sliding window size in ms for error rate calculation */
  windowMs: number;
  /** How long the circuit stays open before transitioning to half-open (ms) */
  resetTimeoutMs: number;
  /** Number of requests to allow through in half-open state */
  halfOpenRequests: number;
}

export interface CircuitBreakerStatus {
  provider: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
  nextRetryAt: number | null;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  errorRateThreshold: 0.5,
  windowMs: 60_000,
  resetTimeoutMs: 30_000,
  halfOpenRequests: 1,
};

/**
 * Circuit breaker for a single provider.
 *
 * States:
 * - **closed**: Normal operation. Failures are tracked.
 * - **open**: Provider is failing. Requests are rejected immediately.
 * - **half-open**: Testing recovery. A limited number of requests are allowed through.
 */
class ProviderCircuitBreaker {
  readonly provider: string;
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'closed';

  // Tracking
  private consecutiveFailures = 0;
  private halfOpenAllowed = 0;
  private openedAt = 0;
  private lastFailureAt = 0;
  private lastSuccessAt = 0;

  // Sliding window for error rate
  private results: { ts: number; success: boolean }[] = [];

  constructor(provider: string, config?: Partial<CircuitBreakerConfig>) {
    this.provider = provider;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Check if a request is allowed through */
  isAllowed(): boolean {
    this.evaluateState();

    switch (this.state) {
      case 'closed':
        return true;

      case 'open':
        return false;

      case 'half-open':
        if (this.halfOpenAllowed > 0) {
          this.halfOpenAllowed--;
          return true;
        }
        return false;
    }
  }

  /** Record a successful request */
  recordSuccess(): void {
    const now = Date.now();
    this.results.push({ ts: now, success: true });
    this.lastSuccessAt = now;
    this.consecutiveFailures = 0;
    this.cleanupWindow();

    if (this.state === 'half-open') {
      // Recovery confirmed — close the circuit
      this.transitionTo('closed');
    }
  }

  /** Record a failed request */
  recordFailure(): void {
    const now = Date.now();
    this.results.push({ ts: now, success: false });
    this.lastFailureAt = now;
    this.consecutiveFailures++;
    this.cleanupWindow();

    if (this.state === 'half-open') {
      // Recovery failed — re-open
      this.transitionTo('open');
      return;
    }

    if (this.state === 'closed') {
      // Check if we should open
      if (this.consecutiveFailures >= this.config.failureThreshold) {
        this.transitionTo('open');
        return;
      }

      // Check error rate
      if (this.results.length >= 10) {
        const failures = this.results.filter(r => !r.success).length;
        const rate = failures / this.results.length;
        if (rate >= this.config.errorRateThreshold) {
          this.transitionTo('open');
        }
      }
    }
  }

  /** Get current status */
  getStatus(): CircuitBreakerStatus {
    this.evaluateState();

    return {
      provider: this.provider,
      state: this.state,
      failures: this.consecutiveFailures,
      successes: this.results.filter(r => r.success).length,
      lastFailureAt: this.lastFailureAt || null,
      lastSuccessAt: this.lastSuccessAt || null,
      openedAt: this.openedAt || null,
      nextRetryAt: this.state === 'open'
        ? this.openedAt + this.config.resetTimeoutMs
        : null,
    };
  }

  /** Force-reset the circuit to closed */
  reset(): void {
    this.transitionTo('closed');
    this.consecutiveFailures = 0;
    this.results = [];
    modelLogger.info({ provider: this.provider }, 'Circuit breaker manually reset');
  }

  // ── Private ──

  private evaluateState(): void {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.transitionTo('half-open');
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === 'open') {
      this.openedAt = Date.now();
      modelLogger.warn({
        provider: this.provider,
        from: oldState,
        consecutiveFailures: this.consecutiveFailures,
        resetTimeoutMs: this.config.resetTimeoutMs,
      }, 'Circuit breaker OPENED — provider failing');
    } else if (newState === 'half-open') {
      this.halfOpenAllowed = this.config.halfOpenRequests;
      modelLogger.info({
        provider: this.provider,
        allowedRequests: this.halfOpenAllowed,
      }, 'Circuit breaker HALF-OPEN — testing recovery');
    } else if (newState === 'closed') {
      modelLogger.info({
        provider: this.provider,
        from: oldState,
      }, 'Circuit breaker CLOSED — provider recovered');
    }
  }

  private cleanupWindow(): void {
    const cutoff = Date.now() - this.config.windowMs;
    this.results = this.results.filter(r => r.ts > cutoff);
  }
}

// ── Error class ──

export class CircuitOpenError extends Error {
  readonly provider: string;
  readonly nextRetryAt: number;

  constructor(provider: string, nextRetryAt: number) {
    const retryIn = Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000));
    super(`[${provider}] Circuit breaker is open — provider unavailable, retry in ${retryIn}s`);
    this.name = 'CircuitOpenError';
    this.provider = provider;
    this.nextRetryAt = nextRetryAt;
  }
}

// ── Centralized circuit breaker registry ──

export class CircuitBreakerRegistry {
  private breakers = new Map<string, ProviderCircuitBreaker>();

  /** Get or create a circuit breaker for a provider */
  private getBreaker(provider: string): ProviderCircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new ProviderCircuitBreaker(provider);
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  /**
   * Check if a request to the provider is allowed.
   * Throws CircuitOpenError if the circuit is open.
   */
  checkAllowed(provider: string): void {
    const breaker = this.getBreaker(provider);
    if (!breaker.isAllowed()) {
      const status = breaker.getStatus();
      throw new CircuitOpenError(provider, status.nextRetryAt || Date.now() + 30_000);
    }
  }

  /** Record a successful request */
  recordSuccess(provider: string): void {
    this.getBreaker(provider).recordSuccess();
  }

  /** Record a failed request */
  recordFailure(provider: string): void {
    this.getBreaker(provider).recordFailure();
  }

  /** Get status for a specific provider */
  getStatus(provider: string): CircuitBreakerStatus {
    return this.getBreaker(provider).getStatus();
  }

  /** Get status for all tracked providers */
  getAllStatuses(): CircuitBreakerStatus[] {
    return Array.from(this.breakers.values()).map(b => b.getStatus());
  }

  /** Force-reset a provider's circuit breaker */
  reset(provider: string): void {
    const breaker = this.breakers.get(provider);
    if (breaker) breaker.reset();
  }

  /** Reset all circuit breakers */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

// ── Singleton ──

let registryInstance: CircuitBreakerRegistry | null = null;

export function getCircuitBreakerRegistry(): CircuitBreakerRegistry {
  if (!registryInstance) {
    registryInstance = new CircuitBreakerRegistry();
  }
  return registryInstance;
}

export function resetCircuitBreakerRegistry(): void {
  registryInstance = null;
}
