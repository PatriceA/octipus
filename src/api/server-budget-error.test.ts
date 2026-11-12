import { beforeAll, expect, test } from 'vitest';
import { QuotaExceededError } from '@/security/quota-error';
import { SpendBudgetExceededError } from '@/security/spend-budget-error';

beforeAll(async () => {
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });
});

test.each([
  new QuotaExceededError({ kind: 'tokensPerDay', current: 10_000_001, max: 10_000_000, userId: 'user' }),
  new SpendBudgetExceededError({ budgetId: 'b', userId: 'user', scopeKind: 'user', scopeRef: null, period: 'day', spentUsd: 1, limitUsd: 1 }),
])('server preserves $code guidance without exposing user identifiers', async error => {
  const { createServer } = await import('./server');
  const app = createServer().get('/budget-test', () => { throw error; });
  const response = await app.handle(new Request('http://localhost/budget-test'));
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ error: error.message, code: error.code });
});

test('server still hides unexpected internal errors', async () => {
  const { createServer } = await import('./server');
  const app = createServer().get('/budget-test', () => { throw new Error('private internal diagnostic'); });
  const response = await app.handle(new Request('http://localhost/budget-test'));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Internal server error' });
});
