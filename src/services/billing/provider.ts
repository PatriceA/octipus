/**
 * Billing provider abstraction.
 *
 * `CostTracker` writes the canonical record to the `cost_log` table
 * unconditionally. After insertion it fires `recordUsage` on the
 * configured provider so an external billing system (Stripe Meters,
 * a custom backend, an internal report) can attribute the spend.
 *
 * Errors thrown by the provider are caught at the call site —
 * billing must never block a chat request. The default provider is
 * a no-op so installs without billing wiring see no behavior change.
 */
import { coreLogger } from '@/utils/logger';

export interface UsageEvent {
  userId: string;
  orgId?: string | null;
  workspaceId?: string | null;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionId?: string | null;
  agentId?: string | null;
  requestType?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}

export interface BillingProvider {
  /** Stable identifier — surfaced in logs so operators can confirm wiring. */
  readonly name: string;
  recordUsage(event: UsageEvent): Promise<void>;
}

class NoopBillingProvider implements BillingProvider {
  readonly name = 'noop';
  async recordUsage(): Promise<void> { /* no-op */ }
}

/**
 * Stripe Billing Meters stub. Real wiring lives behind
 * `BILLING_PROVIDER=stripe` + `STRIPE_API_KEY` + a meter id; until
 * those are configured this provider behaves like the no-op but
 * logs once per process so misconfiguration is loud.
 */
class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe';
  private warned = false;

  async recordUsage(event: UsageEvent): Promise<void> {
    if (!process.env.STRIPE_API_KEY) {
      if (!this.warned) {
        coreLogger.warn('BILLING_PROVIDER=stripe but STRIPE_API_KEY is unset; skipping');
        this.warned = true;
      }
      return;
    }
    // Real implementation would POST to /v1/billing/meter_events.
    // Left intentionally minimal — wire your account here.
    coreLogger.debug({ event: { userId: event.userId, model: event.modelName, costUsd: event.costUsd } }, 'stripe.recordUsage');
  }
}

let active: BillingProvider | null = null;

export function getBillingProvider(): BillingProvider {
  if (active) return active;
  const provider = process.env.BILLING_PROVIDER ?? 'none';
  switch (provider) {
    case 'stripe':
      active = new StripeBillingProvider();
      break;
    case 'none':
    case '':
    default:
      active = new NoopBillingProvider();
  }
  coreLogger.info({ provider: active.name }, 'Billing provider initialized');
  return active;
}

/** Test-only: swap the active provider. */
export function _setBillingProvider(p: BillingProvider): void { active = p; }
