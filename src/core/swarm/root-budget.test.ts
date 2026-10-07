import { afterEach, expect, it } from 'vitest';
import { getConfig, refreshConfigKey } from '@/config';
import { createRootBudget, deriveChildBudget } from './spawn-budget';

const original = { ...getConfig().swarm.levelDefaults.root };
afterEach(() => {
  for (const [key, value] of Object.entries(original)) refreshConfigKey(`swarm.levelDefaults.root.${key}`, value);
});

it('uses saved root limits and permits delegation beyond the former 200,000 cap', () => {
  refreshConfigKey('swarm.levelDefaults.root.tokens', 20_000_000);
  refreshConfigKey('swarm.levelDefaults.root.wallMs', 72_000_000);
  refreshConfigKey('swarm.levelDefaults.root.fanOut', 8);
  const budget = createRootBudget();
  expect(budget.tokens.cap).toBe(20_000_000);
  expect(budget.wallClockMs.cap).toBe(72_000_000);
  expect(budget.fanOut.cap).toBe(8);
  budget.tokens.used = 250_000;
  expect(deriveChildBudget(budget, 1).tokens.cap).toBeGreaterThan(0);
});

it('takes updated settings for new turns without changing an existing run', () => {
  refreshConfigKey('swarm.levelDefaults.root.tokens', 400_000);
  const existing = createRootBudget();
  refreshConfigKey('swarm.levelDefaults.root.tokens', 20_000_000);
  expect(createRootBudget().tokens.cap).toBe(20_000_000);
  expect(existing.tokens.cap).toBe(400_000);
});
