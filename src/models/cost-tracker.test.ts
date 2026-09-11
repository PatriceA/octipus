import { afterAll, beforeAll, expect, test } from 'vitest';
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
  const { CostTracker } = await import('./cost-tracker');
  tracker = new CostTracker();
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
