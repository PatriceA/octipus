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
import { poolSpend, shouldWarnBudget, syncParentTokenUsage } from './spawn-budget';
import { BUDGET_WARN_FRACTION, type AgentNode, type NodeBudget } from './types';

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

/**
 * syncParentTokenUsage's spend-proxy precedence: a worker's own billable
 * figure (fresh input + output) must win over its cache-inflated total, and
 * over the legacy `ownTokenUsage` callback — which every production caller
 * (root-runner.ts, worker-spawner.ts, spawner.ts) wires as a thin wrapper
 * around `getTotalTokens()`. Without this precedence a billable-only change
 * to the `workerRef` fallback would never run in production, because
 * `ownTokenUsage` is set on every real node alongside `workerRef`.
 */
describe('syncParentTokenUsage — billable-tokens precedence', () => {
  const makeNode = (over: {
    used?: number;
    childTokensUsed?: number;
    getBillableTokens?: () => number;
    getTotalTokens?: () => number;
    ownTokenUsage?: () => number;
  } = {}): AgentNode => {
    const node = {
      id: 'p',
      role: 'general',
      depth: 0 as const,
      topicPath: '',
      budget: {
        tokens: { cap: 200_000, used: over.used ?? 0 },
        wallClockMs: { cap: 600_000, startedAt: Date.now() },
        fanOut: { cap: 6, used: 0 },
        depth: 0 as const,
        childTokensUsed: over.childTokensUsed ?? 0,
      },
      ownTokenUsage: over.ownTokenUsage,
    } as unknown as AgentNode;
    if (over.getBillableTokens || over.getTotalTokens) {
      (node as unknown as {
        workerRef: { current: { getBillableTokens?: () => number; getTotalTokens?: () => number } };
      }).workerRef = {
        current: { getBillableTokens: over.getBillableTokens, getTotalTokens: over.getTotalTokens },
      };
    }
    return node;
  };

  test('prefers workerRef.getBillableTokens() over getTotalTokens() and over ownTokenUsage()', () => {
    const node = makeNode({
      getBillableTokens: () => 2_500,
      getTotalTokens: () => 202_500,
      ownTokenUsage: () => 999_999,
    });
    syncParentTokenUsage(node);
    expect(node.budget.tokens.used).toBe(2_500);
  });

  test('falls back to workerRef.getTotalTokens() when getBillableTokens is absent', () => {
    const node = makeNode({ getTotalTokens: () => 42_000, ownTokenUsage: () => 999_999 });
    syncParentTokenUsage(node);
    expect(node.budget.tokens.used).toBe(42_000);
  });

  test('falls back to ownTokenUsage() when there is no workerRef (pipeline stageNode path)', () => {
    // worker-spawner.ts wires stageNode.ownTokenUsage but sets no workerRef.
    const node = makeNode({ ownTokenUsage: () => 7_777 });
    syncParentTokenUsage(node);
    expect(node.budget.tokens.used).toBe(7_777);
  });
});

/**
 * I1 — the pool must not mix units. `spawn-budget.ts` reads the parent's
 * `getBillableTokens()` while `spawner.ts` recorded each child's
 * `getTotalTokens()`, and `syncParentTokenUsage` then summed the two. With
 * cache reads folded into the grand total, a well-cached child charged its
 * parent for a context it re-read at a tenth of the price. `poolSpend` is the
 * one place that says what a pool token means; both sides go through it.
 */
describe('poolSpend — the swarm pool unit', () => {
  const worker = (billable: number, total: number) => ({
    getBillableTokens: () => billable,
    getTotalTokens: () => total,
  });

  test('charges the billable figure, not the cache-inflated total', () => {
    expect(poolSpend(worker(2_500, 202_500))).toBe(2_500);
  });

  test('falls back to the grand total for a worker with no billable accounting', () => {
    expect(poolSpend({ getTotalTokens: () => 42_000 })).toBe(42_000);
    expect(poolSpend(null)).toBe(0);
    expect(poolSpend(undefined)).toBe(0);
  });

  test('parent + children add up in one unit', () => {
    // Parent and two children, each replaying a ~100k cached context for a
    // couple of thousand fresh tokens. Summed as grand totals the pool reads
    // ~600k — three times a 200k cap — while real spend is 7.5k.
    const parent = worker(2_500, 202_500);
    const children = [worker(2_500, 202_500), worker(2_500, 202_500)];

    const node = {
      id: 'p', role: 'general', depth: 0 as const, topicPath: '',
      budget: {
        tokens: { cap: 200_000, used: 0 },
        wallClockMs: { cap: 600_000, startedAt: Date.now() },
        fanOut: { cap: 6, used: 0 },
        depth: 0 as const,
        childTokensUsed: children.reduce((sum, c) => sum + poolSpend(c), 0),
      },
    } as unknown as AgentNode;
    (node as unknown as { workerRef: { current: unknown } }).workerRef = { current: parent };

    syncParentTokenUsage(node);
    expect(node.budget.tokens.used).toBe(7_500);
    expect(shouldWarnBudget(node.budget)).toBe(false);
  });
});
