/**
 * Swarm Phase 3 — per-user fan-out rate limiter.
 *
 * Adapter around `RateLimiter.checkSwarmFanOutBudget` that returns a
 * pre-built `ChildResult{status:'concurrency_limit', reason:'user_rate_limit'}`
 * when the user's bucket is exhausted. Designed for a single call site in
 * `SwarmSpawner.spawnChild` — kept standalone so Phase 3 can ship the bucket
 * without touching spawner.ts (owned by a parallel Phase 2 workstream).
 *
 * The check is scoped to `userId` (not session / not root node), so a user
 * that spams multiple chat sessions still gets one unified cap.
 */
import { getConfig } from '@/config';
import { getRateLimiter } from '@/security/rate-limiter';
import { coreLogger } from '@/utils/logger';
import type { ChildResult } from './types';

export interface FanOutCheckResult {
  /** `true` → spawner may proceed. `false` → return `rejection` to the parent LLM. */
  allowed: boolean;
  /** Non-null iff `allowed === false`. Safe to return straight to the parent LLM. */
  rejection?: ChildResult;
  /** Remaining spawns in the current window (diagnostic). */
  remaining?: number;
}

/**
 * Consult the per-user swarm fan-out budget before spawning a child. Caller
 * passes the owning user id (from the parent's session context).
 *
 * On denial the returned `rejection` does **not** consume the node's own
 * `fanOut.used` counter — by contract the caller must only mark fan-out
 * used after this function returned `allowed: true`.
 */
export async function checkUserFanOutBudget(opts: {
  userId: string;
  parentNodeId: string;
  topicPath: string;
}): Promise<FanOutCheckResult> {
  const cfg = getConfig();
  const limit = cfg.swarm?.perUserSpawnsPerMinute ?? 30;
  const limiter = getRateLimiter();

  try {
    const { allowed, remaining, retryAfter } =
      await limiter.checkSwarmFanOutBudget(opts.userId, limit);

    if (allowed) {
      return { allowed: true, remaining };
    }

    coreLogger.warn(
      {
        userId: opts.userId,
        parentNodeId: opts.parentNodeId,
        topicPath: opts.topicPath,
        limit,
        retryAfter,
      },
      'Swarm per-user fan-out budget exhausted — rejecting spawn',
    );

    const rejection: ChildResult = {
      nodeId: '',
      kind: 'agent',
      status: 'concurrency_limit',
      output: null,
      usedTokens: 0,
      durationMs: 0,
      spawnedChildren: [],
      notes: `user_rate_limit: max ${limit} spawns/minute per user (retry in ${retryAfter}s)`,
    };
    return { allowed: false, rejection, remaining: 0 };
  } catch (err) {
    // Rate-limiter failure must fail-open — otherwise a Redis blip could
    // wedge every user's swarm. Log + allow.
    coreLogger.error(
      { err, userId: opts.userId },
      'Swarm fan-out budget check failed — allowing spawn (fail-open)',
    );
    return { allowed: true };
  }
}
