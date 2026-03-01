import { RedisCache } from '@/db/redis';
import { modelLogger } from '@/utils/logger';
import type { QuotaStatus } from './providers/interface';

const QUOTA_KEY_PREFIX = 'quota:';
const DAILY_USAGE_PREFIX = 'quota:daily:';
const EXHAUSTION_TTL = 3600; // 1 hour before re-checking exhaustion
const DAILY_TTL = 86400; // 24 hours

interface QuotaState {
  exhausted: boolean;
  exhaustedAt?: string;
  resetsAt?: string;
  lastError?: string;
}

interface DailyUsage {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  date: string;
}

/**
 * Redis-backed quota tracker for subscription-based CLI providers.
 * Tracks daily/monthly usage and detects quota exhaustion.
 */
export class QuotaTracker {
  private cache = new RedisCache(0); // No default TTL, we manage it per key

  /** Get current quota status for a provider */
  async getStatus(provider: string): Promise<QuotaStatus> {
    const state = await this.cache.get<QuotaState>(`${QUOTA_KEY_PREFIX}${provider}`);

    if (!state) {
      return {
        provider,
        hasQuota: true,
        exhausted: false,
      };
    }

    return {
      provider,
      hasQuota: !state.exhausted,
      exhausted: state.exhausted,
      resetsAt: state.resetsAt ? new Date(state.resetsAt) : undefined,
      lastError: state.lastError,
    };
  }

  /** Mark a provider as quota-exhausted */
  async markExhausted(provider: string, resetsAt?: Date): Promise<void> {
    const state: QuotaState = {
      exhausted: true,
      exhaustedAt: new Date().toISOString(),
      resetsAt: resetsAt?.toISOString(),
    };

    // Auto-clear exhaustion after EXHAUSTION_TTL so we retry
    await this.cache.set(`${QUOTA_KEY_PREFIX}${provider}`, state, EXHAUSTION_TTL);

    modelLogger.warn({ provider, resetsAt }, 'Provider quota marked as exhausted');
  }

  /** Clear exhaustion status (e.g., after quota reset) */
  async clearExhaustion(provider: string): Promise<void> {
    await this.cache.delete(`${QUOTA_KEY_PREFIX}${provider}`);
    modelLogger.info({ provider }, 'Provider quota exhaustion cleared');
  }

  /** Track usage for a provider */
  async trackUsage(provider: string, usage: { inputTokens: number; outputTokens: number }): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    const key = `${DAILY_USAGE_PREFIX}${provider}:${today}`;

    const existing = await this.cache.get<DailyUsage>(key);

    const updated: DailyUsage = {
      inputTokens: (existing?.inputTokens || 0) + usage.inputTokens,
      outputTokens: (existing?.outputTokens || 0) + usage.outputTokens,
      requestCount: (existing?.requestCount || 0) + 1,
      date: today,
    };

    await this.cache.set(key, updated, DAILY_TTL);
  }

  /** Get daily usage for a provider */
  async getDailyUsage(provider: string, date?: string): Promise<DailyUsage> {
    const day = date || new Date().toISOString().split('T')[0];
    const key = `${DAILY_USAGE_PREFIX}${provider}:${day}`;

    return await this.cache.get<DailyUsage>(key) || {
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      date: day,
    };
  }

  /** Get usage for multiple days */
  async getUsageHistory(provider: string, days: number = 7): Promise<DailyUsage[]> {
    const results: DailyUsage[] = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const day = date.toISOString().split('T')[0];
      const usage = await this.getDailyUsage(provider, day);
      results.push(usage);
    }

    return results;
  }

  /** Get status for all known CLI providers */
  async getAllStatuses(): Promise<QuotaStatus[]> {
    const providers = ['claude-code', 'gemini-cli', 'codex-cli'];
    return Promise.all(providers.map(p => this.getStatus(p)));
  }
}

// Singleton
let instance: QuotaTracker | null = null;

export function getQuotaTracker(): QuotaTracker {
  if (!instance) {
    instance = new QuotaTracker();
  }
  return instance;
}
