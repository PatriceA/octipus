import { expect, test } from 'vitest';
import { estimateCost } from './pricing';
const model = { provider: 'openai', costPerInputToken: 10, costPerOutputToken: 30, metadata: { pricing: { cacheRead: 1, cacheWrite: 12.5 } } };
test('prices fresh, cached, cache-write, and output tokens independently', () => {
  expect(estimateCost(model, 1000, 100, 400, 200)).toBeCloseTo(0.0099);
});
test('missing model or required cache price remains unknown', () => {
  expect(estimateCost(undefined, 100, 10)).toBeNull();
  expect(estimateCost({ ...model, metadata: {} }, 100, 10, 50)).toBeNull();
});
test('zero defaults do not imply free remote inference', () => {
  expect(estimateCost({ ...model, costPerInputToken: 0 }, 100, 10)).toBeNull();
  expect(estimateCost({ ...model, metadata: { pricing: { free: true } } }, 100, 10)).toBe(0);
});
test('rejects overlapping cache counts and negative usage', () => {
  expect(estimateCost(model, 100, 10, 90, 90)).toBeNull();
  expect(estimateCost(model, -1, 10)).toBeNull();
});
