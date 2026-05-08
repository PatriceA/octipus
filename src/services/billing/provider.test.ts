import { describe, expect, test } from 'bun:test';
import { _setBillingProvider, type BillingProvider, getBillingProvider, type UsageEvent } from './provider';

class CapturingProvider implements BillingProvider {
  readonly name = 'capturing';
  events: UsageEvent[] = [];
  async recordUsage(event: UsageEvent): Promise<void> {
    this.events.push(event);
  }
}

describe('billing provider', () => {
  test('default is no-op when BILLING_PROVIDER is unset', async () => {
    const original = process.env.BILLING_PROVIDER;
    delete process.env.BILLING_PROVIDER;
    _setBillingProvider(null as unknown as BillingProvider); // force re-init
    const p = getBillingProvider();
    expect(p.name).toBe('noop');
    await expect(p.recordUsage({
      userId: 'u', modelName: 'm', inputTokens: 1, outputTokens: 1,
      costUsd: 0.0001, occurredAt: new Date(),
    })).resolves.toBeUndefined();
    if (original) process.env.BILLING_PROVIDER = original;
  });

  test('test override captures events', async () => {
    const cap = new CapturingProvider();
    _setBillingProvider(cap);
    await getBillingProvider().recordUsage({
      userId: 'u-1',
      modelName: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      occurredAt: new Date(),
    });
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0].userId).toBe('u-1');
    expect(cap.events[0].modelName).toBe('gpt-4o');
  });
});
