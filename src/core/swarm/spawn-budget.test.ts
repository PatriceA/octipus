/**
 * The budget-warning threshold.
 *
 * `swarm.budget_warning` was declared in the gateway protocol and subscribed by
 * both the websocket route and the persona narration bridge — which carries a
 * `budget_warning` template — while nothing had ever published it, so that
 * narration had never once fired. The generated event matrix found it; this
 * pins the threshold that now decides when it does.
 */
import { describe, expect, test } from 'vitest';
import { shouldWarnBudget } from './spawn-budget';
import { BUDGET_WARN_FRACTION, type NodeBudget } from './types';

const budget = (cap: number, used: number): NodeBudget => ({
  tokens: { cap, used },
  wallClockMs: { cap: 60_000, startedAt: 0 },
  fanOut: { cap: 3, used: 0 },
  depth: 1,
});

describe('shouldWarnBudget', () => {
  test('stays quiet on a healthy pool', () => {
    expect(shouldWarnBudget(budget(100_000, 0))).toBe(false);
    expect(shouldWarnBudget(budget(100_000, 50_000))).toBe(false);
  });

  test('fires once the spendable portion is mostly gone', () => {
    const cap = 100_000;
    const threshold = cap * BUDGET_WARN_FRACTION;
    expect(shouldWarnBudget(budget(cap, Math.ceil(threshold) - 1))).toBe(false);
    expect(shouldWarnBudget(budget(cap, Math.ceil(threshold)))).toBe(true);
    expect(shouldWarnBudget(budget(cap, cap))).toBe(true);
  });

  test('warns BEFORE exhaustion, which is what makes it a warning', () => {
    // A threshold at or past the cap would make this a report of something the
    // user can no longer act on.
    expect(BUDGET_WARN_FRACTION).toBeLessThan(1);
    expect(BUDGET_WARN_FRACTION).toBeGreaterThan(0.5);
  });

  test('an unset pool is not a warning', () => {
    // A legacy call site or a node built before the cascade carries cap 0.
    // Warning on it would fire on every single spawn.
    expect(shouldWarnBudget(budget(0, 0))).toBe(false);
    expect(shouldWarnBudget(budget(-1, 100))).toBe(false);
  });
});
