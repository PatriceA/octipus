import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.MASTER_KEY ??= `test-${randomUUID()}`;
process.env.JWT_SECRET ??= `test-${randomUUID()}`;
process.env.SESSION_SECRET ??= `test-${randomUUID()}`;
let tracker: import('./cost-tracker').CostTracker;
const sessionId = randomUUID();
const userId = randomUUID();
beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-cost-'));
  const { initializeDb, getDb } = await import('@/db/postgres');
  await initializeDb();
  await (await import('@/db/migrate')).runMigrations();
  const { modelConfig } = await import('@/db/schema/models');
  await getDb().insert(modelConfig).values({ name: 'priced', modelId: 'same', provider: 'openai', costPerInputToken: 10, costPerOutputToken: 30, metadata: { pricing: { cacheRead: 1, cacheWrite: 12.5, source: 'test contract' } } });
  await getDb().insert(modelConfig).values({ name: 'model-without-cache-rates', modelId: 'no-cache', provider: 'openai', costPerInputToken: 5, costPerOutputToken: 15, metadata: { pricing: { source: 'test contract' } } });
  const { CostTracker } = await import('./cost-tracker');
  tracker = new CostTracker();
});
beforeEach(async () => {
  const { __resetCachePricingWarnings } = await import('./cost-tracker');
  __resetCachePricingWarnings();
});
afterAll(async () => { await (await import('@/db/postgres')).closeDb(); });
test('persists reported zero, estimates and unknowns distinctly and aggregates a session', async () => {
  const reported = await tracker.logUsageWithCost(userId, 'priced', 1000, 100, { sessionId, reportedCost: 0 });
  expect(reported.totalCost).toBe(0);
  expect(reported.metadata?.costSource).toBe('reported');
  const estimate = await tracker.logUsageWithCost(userId, 'priced', 1000, 100, { sessionId, cachedInputTokens: 400, cacheCreationTokens: 200 });
  expect(estimate.totalCost).toBeCloseTo(0.0099);
  expect(estimate.metadata?.pricingSource).toBe('test contract');
  const unknown = await tracker.logUsageWithCost(userId, 'missing', 1000, 100, { sessionId });
  expect(unknown.metadata?.costSource).toBe('unknown');
  const stats = await tracker.getSessionStats(sessionId);
  expect(stats.requestCount).toBe(3);
  expect(stats.unknownCostRequests).toBe(1);
  expect(stats.estimatedCost).toBeCloseTo(0.0099);
  expect(Number(stats.cacheReadTokens)).toBe(400);
});
test('missing usage stays unknown even for a zero-token response', async () => {
  const row = await tracker.logUsageWithCost(userId, 'priced', 0, 0, { usageAvailable: false });
  expect(row.metadata?.costSource).toBe('unknown');
});
test('ambiguous model IDs do not silently select a rate', async () => {
  const { getDb } = await import('@/db/postgres');
  const { modelConfig } = await import('@/db/schema/models');
  await getDb().insert(modelConfig).values({ name: 'alias', modelId: 'same', provider: 'openai', costPerInputToken: 100, costPerOutputToken: 300 });
  expect(await tracker.calculateCost('same', 100, 10)).toBeNull();
  expect(await tracker.calculateCost('priced', 100, 10)).toBeCloseTo(0.0013);
});

test('warns when cache tokens appear on a model with no cache pricing', async () => {
  const { modelLogger: logger } = await import('@/utils/logger');
  const warn = vi.spyOn(logger, 'warn');
  await tracker.logUsageWithCost(userId, 'model-without-cache-rates', 1000, 100, {
    cachedInputTokens: 400,
    cacheCreationTokens: 0
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'model-without-cache-rates', cachedInputTokens: 400, cacheCreationTokens: 0, missingRates: ['cacheRead'] }),
    expect.stringContaining('cache pricing'),
  );
});

test('does not warn when cost is unknown for an unrelated reason (usageAvailable: false)', async () => {
  const { modelLogger: logger } = await import('@/utils/logger');
  const warn = vi.spyOn(logger, 'warn');
  await tracker.logUsageWithCost(userId, 'priced', 1000, 100, {
    cachedInputTokens: 400,
    cacheCreationTokens: 0,
    usageAvailable: false
  });
  expect(warn).not.toHaveBeenCalled();
});

test('deduplicates warnings by model id', async () => {
  const { modelLogger: logger } = await import('@/utils/logger');
  const warn = vi.spyOn(logger, 'warn');
  // First call should warn
  await tracker.logUsageWithCost(userId, 'model-without-cache-rates', 1000, 100, {
    cachedInputTokens: 400,
    cacheCreationTokens: 0
  });
  expect(warn).toHaveBeenCalledTimes(1);
  // Second call with same model should not warn again
  await tracker.logUsageWithCost(userId, 'model-without-cache-rates', 2000, 200, {
    cachedInputTokens: 600,
    cacheCreationTokens: 0
  });
  expect(warn).toHaveBeenCalledTimes(1);
});
