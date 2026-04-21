/**
 * Per-server circuit breaker for MCP tool calls.
 *
 * States:
 *   closed    — normal. Failures increment counter.
 *   open      — blocked. Calls reject immediately. Auto-transitions to half-open
 *               after `cooldownMs`.
 *   half_open — one probe allowed. Success → closed. Failure → open with
 *               exponential backoff (cooldownMs × 2, capped).
 *
 * Defaults: trip after 3 consecutive failures. Initial cooldown 60 s.
 * Max cooldown 5 min.
 */

import { coreLogger } from '@/utils/logger';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  initialCooldownMs?: number;
  maxCooldownMs?: number;
}

export interface CircuitEvent {
  serverId: string;
  state: CircuitState;
  failureCount: number;
  cooldownMs?: number;
}

export type CircuitListener = (event: CircuitEvent) => void;

interface ServerCircuit {
  state: CircuitState;
  failureCount: number;
  currentCooldownMs: number;
  openedAt: number;
}

export class McpCircuitBreaker {
  private readonly circuits = new Map<string, ServerCircuit>();
  private readonly listeners = new Set<CircuitListener>();
  private readonly failureThreshold: number;
  private readonly initialCooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(cfg: CircuitBreakerConfig = {}) {
    this.failureThreshold = cfg.failureThreshold ?? 3;
    this.initialCooldownMs = cfg.initialCooldownMs ?? 60_000;
    this.maxCooldownMs = cfg.maxCooldownMs ?? 300_000;
  }

  /** Subscribe to state-change events. Returns unsubscribe. */
  onStateChange(fn: CircuitListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Internal: publish state change. */
  private emit(serverId: string, c: ServerCircuit): void {
    const evt: CircuitEvent = {
      serverId,
      state: c.state,
      failureCount: c.failureCount,
      ...(c.state === 'open' ? { cooldownMs: c.currentCooldownMs } : {}),
    };
    for (const l of this.listeners) {
      try { l(evt); } catch (err) { coreLogger.warn({ err }, 'Circuit listener threw'); }
    }
  }

  private getOrInit(serverId: string): ServerCircuit {
    let c = this.circuits.get(serverId);
    if (!c) {
      c = { state: 'closed', failureCount: 0, currentCooldownMs: this.initialCooldownMs, openedAt: 0 };
      this.circuits.set(serverId, c);
    }
    return c;
  }

  /** Check whether a call may proceed. Advances state on cooldown expiry. */
  canCall(serverId: string): boolean {
    const c = this.getOrInit(serverId);
    if (c.state === 'closed') return true;
    if (c.state === 'half_open') return true;
    // open — check cooldown
    if (Date.now() - c.openedAt >= c.currentCooldownMs) {
      c.state = 'half_open';
      this.emit(serverId, c);
      return true;
    }
    return false;
  }

  /** Record a successful call. Resets the breaker. */
  recordSuccess(serverId: string): void {
    const c = this.getOrInit(serverId);
    const wasNotClosed = c.state !== 'closed';
    c.state = 'closed';
    c.failureCount = 0;
    c.currentCooldownMs = this.initialCooldownMs;
    if (wasNotClosed) this.emit(serverId, c);
  }

  /** Record a failed call. May open the breaker. */
  recordFailure(serverId: string): void {
    const c = this.getOrInit(serverId);
    if (c.state === 'half_open') {
      // Probe failed. Back to open with exponential backoff.
      c.state = 'open';
      c.openedAt = Date.now();
      c.currentCooldownMs = Math.min(c.currentCooldownMs * 2, this.maxCooldownMs);
      coreLogger.warn({ serverId, cooldownMs: c.currentCooldownMs }, 'MCP circuit probe failed, extending cooldown');
      this.emit(serverId, c);
      return;
    }
    c.failureCount++;
    if (c.failureCount >= this.failureThreshold && c.state === 'closed') {
      c.state = 'open';
      c.openedAt = Date.now();
      c.currentCooldownMs = this.initialCooldownMs;
      coreLogger.warn({ serverId, failureCount: c.failureCount, cooldownMs: c.currentCooldownMs }, 'MCP circuit opened');
      this.emit(serverId, c);
    }
  }

  /** Force-reset a server's breaker (admin action). */
  reset(serverId: string): void {
    const c = this.getOrInit(serverId);
    c.state = 'closed';
    c.failureCount = 0;
    c.currentCooldownMs = this.initialCooldownMs;
    c.openedAt = 0;
    this.emit(serverId, c);
  }

  getState(serverId: string): { state: CircuitState; failureCount: number; cooldownRemainingMs: number } {
    const c = this.getOrInit(serverId);
    const cooldownRemainingMs = c.state === 'open'
      ? Math.max(0, c.currentCooldownMs - (Date.now() - c.openedAt))
      : 0;
    return { state: c.state, failureCount: c.failureCount, cooldownRemainingMs };
  }

  getAllStates(): Array<{ serverId: string; state: CircuitState; failureCount: number; cooldownRemainingMs: number }> {
    return [...this.circuits.keys()].map(id => ({ serverId: id, ...this.getState(id) }));
  }
}

// Singleton
let breakerInstance: McpCircuitBreaker | null = null;
export function getMcpCircuitBreaker(): McpCircuitBreaker {
  if (!breakerInstance) breakerInstance = new McpCircuitBreaker();
  return breakerInstance;
}
