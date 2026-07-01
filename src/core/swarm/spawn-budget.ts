import {
  BUDGET_RESERVE_FRACTION,
  getLevelDefault,
  type AgentNode,
  type NodeBudget,
} from './types';

/**
 * Budget derivation + token-pool accounting for swarm spawns. These are
 * load-bearing safety limits — the numbers and reserve math here gate whether
 * a child spawns at all. Kept as pure functions (moved verbatim from
 * `spawner.ts`) so they stay unit-testable and free of `SwarmSpawner` state.
 */

/**
 * Minimum child token pool: if parent's remaining tokens drop below this
 * we refuse to spawn rather than start a child that'll immediately hit its
 * own budget cap. Wall-clock has no equivalent floor — child gets its full
 * LEVEL_DEFAULT wallMs because the parent's timer pauses during the await.
 */
export const MIN_CHILD_TOKENS = 4_000;

/** Raised by `deriveChildBudget` when the parent's token pool is exhausted. */
export class InsufficientBudgetError extends Error {
  constructor(
    public readonly available: number,
    public readonly minimum: number,
  ) {
    super(
      `Insufficient token budget for child spawn: ${available} available, ${minimum} minimum required. ` +
        `Parent is near token exhaustion — finalize with existing results instead of spawning.`,
    );
    this.name = 'InsufficientBudgetError';
  }
}

/**
 * Reconcile a parent node's `budget.tokens.used` with true pool consumption:
 * the node's own worker spend (`workerRef.current.getTotalTokens()`) plus the
 * cumulative spend of its children (`budget.childTokensUsed`, accumulated in
 * `spawnChild` as each child returns).
 *
 * Without this the `used` counter is never incremented, so the reserve math and
 * `InsufficientBudgetError` guard in `deriveChildBudget` always see `used = 0`
 * and can never fire — the parent looks like it has its full pool free even when
 * nearly exhausted. Monotonic (never shrinks) and degrades gracefully: with no
 * `workerRef` the own-spend term is 0 and only accumulated child spend counts.
 */
export function syncParentTokenUsage(parent: AgentNode): void {
  const worker = (
    parent as unknown as { workerRef?: { current: { getTotalTokens?: () => number } | null } }
  ).workerRef?.current;
  const ownSpend = worker?.getTotalTokens?.() ?? 0;
  // True pool consumption = the node's own worker spend + everything its
  // children have returned so far. Both terms are monotonic; guard against
  // shrinking `used` (a stale/lower reading must never lower the counter).
  const target = ownSpend + (parent.budget.childTokensUsed ?? 0);
  if (target > parent.budget.tokens.used) {
    parent.budget.tokens.used = target;
  }
}

export function deriveChildBudget(parent: NodeBudget, childDepth: 0 | 1 | 2): NodeBudget {
  const defaults = getLevelDefault(childDepth);

  // Parent's cap was snapshotted at node creation, but the operator may have
  // raised `swarm.levelDefaults.*.tokens` since then. Use the current config
  // default if it's higher — this lets settings changes take effect on the
  // next spawn instead of requiring a session restart. We never *shrink*
  // the parent's effective cap because `used` may already exceed a lower
  // new value; decreases still need a restart.
  const parentCurrentDefault = getLevelDefault(parent.depth).tokens;
  const effectiveParentCap = Math.max(parent.tokens.cap, parentCurrentDefault);
  if (effectiveParentCap > parent.tokens.cap) {
    parent.tokens.cap = effectiveParentCap;
  }

  const parentRemainingTokens = Math.max(0, effectiveParentCap - parent.tokens.used);
  const tokenReserve = Math.ceil(effectiveParentCap * BUDGET_RESERVE_FRACTION);
  const tokenCap = Math.min(defaults.tokens, parentRemainingTokens - tokenReserve);

  if (tokenCap < MIN_CHILD_TOKENS) {
    throw new InsufficientBudgetError(tokenCap, MIN_CHILD_TOKENS);
  }

  // Wall-clock: NO cascade. Child gets its full LEVEL_DEFAULT wall cap.
  // Parent's waiting time for this child will be excluded from the parent's
  // own elapsed() via AgentWorker.pausedMs. Per user spec: "subagent should
  // have the same timeout as an agent — waiting for subagent should not
  // count against parent's timeout".
  const wallCap = defaults.wallMs;

  return {
    tokens: { cap: tokenCap, used: 0 },
    wallClockMs: { cap: wallCap, startedAt: Date.now() },
    fanOut: { cap: defaults.fanOut, used: 0 },
    depth: childDepth,
  };
}
