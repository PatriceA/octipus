import { agentLogger, coreLogger } from '@/utils/logger';
import { getLevelDefault } from '../swarm/types';
import type { ChildResult, PendingChild } from '../swarm/types';

/**
 * Owns the detached-subagent lifecycle for an AgentWorker: the pending map,
 * eager settlement into collected results, ad-hoc + bulk collection, the
 * forget-to-collect auto-collect timeout, and cancel-cascade on parent
 * termination. Extracted verbatim from AgentWorker — behaviour is identical.
 *
 * Dependencies are injected so the manager stays decoupled from the worker:
 *  - `agentId`      — for structured logs.
 *  - `getTimeout()` — the worker's configured wall (`config.timeout`), read
 *                     lazily because `steer()` can mutate maxIterations but the
 *                     timeout is stable; still read via getter to avoid
 *                     snapshotting a not-yet-set value at construction.
 *  - `addPausedMs`  — credits child-wait time back to the worker's active clock.
 */
export class DetachedChildManager {
  private pending: Map<string, PendingChild> = new Map();
  private collected: Map<string, ChildResult> = new Map();

  constructor(
    private readonly agentId: string,
    private readonly getTimeout: () => number,
    private readonly addPausedMs: (durationMs: number) => void,
  ) {}

  registerPendingChild(pc: PendingChild): void {
    this.pending.set(pc.childId, pc);
    // Settle eagerly into collected so auto-collect and ad-hoc
    // collect_children calls can both find results without racing on the
    // shared promise. We keep the entry in pending until the LLM
    // (or framework) explicitly collects — that's what drives the cap.
    pc.promise.then(
      (result) => { this.collected.set(pc.childId, result); },
      (err) => {
        const failMsg = (err as Error)?.message || 'detached spawn threw';
        this.collected.set(pc.childId, {
          nodeId: pc.childId,
          kind: 'subagent',
          status: 'tool_error',
          output: null,
          usedTokens: 0,
          durationMs: Date.now() - pc.startedAt,
          spawnedChildren: [],
          notes: failMsg,
        });
      },
    );
  }

  count(): number {
    return this.pending.size;
  }

  list(): PendingChild[] {
    return [...this.pending.values()];
  }

  /** Mark a pending child as collected. Returns its result (awaiting if needed). */
  async collect(childId: string, timeoutMs: number): Promise<ChildResult | null> {
    const pc = this.pending.get(childId);
    if (!pc) return null;
    const settled = this.collected.get(childId);
    if (settled) {
      this.pending.delete(childId);
      return settled;
    }
    try {
      const result = await Promise.race([
        pc.promise,
        new Promise<ChildResult>((_, reject) =>
          setTimeout(() => reject(new Error(`collect_children timeout after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
      this.pending.delete(childId);
      return result;
    } catch (err) {
      // Leave it in pending for a later retry; surface failure as a result
      // object so the LLM keeps going instead of throwing.
      return {
        nodeId: childId,
        kind: 'subagent',
        status: 'timeout',
        output: null,
        usedTokens: 0,
        durationMs: Date.now() - pc.startedAt,
        spawnedChildren: [],
        notes: (err as Error).message,
      };
    }
  }

  /**
   * Timeout for the final auto-collect (the forget-to-collect safety net).
   *
   * A detached child can legitimately run up to its OWN wall budget
   * (`getLevelDefault(1).wallMs` — 10 min by default; children of both the
   * root agent and a depth-1 agent are bounded by the depth-1 cap or lower).
   * The old formula clamped this to 60s, so a normal multi-minute research
   * child was reported `timeout`/`null` and its completed work was silently
   * dropped. Wait up to the child wall (+small margin) so a child that is about
   * to finish isn't cut off — the child self-terminates at its own wall — but
   * never longer than the parent's own wall.
   */
  computeAutoCollectTimeoutMs(): number {
    const childWall = getLevelDefault(1).wallMs;
    const timeout = this.getTimeout();
    const wall = timeout > 0 ? timeout : childWall;
    return Math.max(10_000, Math.min(childWall + 5_000, wall));
  }

  /** Cancel all pending detached children. Fire-and-forget — call on worker fail/abort. */
  cancelAll(reason: string): void {
    if (this.pending.size === 0) return;
    agentLogger.warn(
      { agentId: this.agentId, pending: this.pending.size, reason },
      'Cancelling pending detached children (parent worker terminating)',
    );
    for (const [, pc] of this.pending) {
      // The detached promise is already in flight inside the spawner; we
      // don't have a direct AbortController handle for each child. The
      // parent's AbortController has already been aborted by the fail/abort
      // path — children that listen to the parent signal (set in spawner.ts
      // parentSignal) will tear down. Emit a breadcrumb so ops can see the
      // cascade in logs.
      coreLogger.info({ childId: pc.childId, startedAt: pc.startedAt }, 'detached child cancel-cascade');
    }
    this.pending.clear();
  }

  /** Collect every still-pending detached child. Used by collect_children and auto-collect. */
  async collectAll(timeoutMs: number): Promise<ChildResult[]> {
    const entries = [...this.pending.entries()];
    if (entries.length === 0) return [];
    // Time spent BLOCKED waiting on detached children must not count against
    // the parent's own wall clock — this mirrors the await path's
    // `onDelegationPause` (tool-executor). Without it, a detaching root agent
    // is penalized for time its children spent working (elapsed() keeps
    // ticking between spawn and collect), which can trip its own timeout and
    // discard the very results it waited for. Children that already settled
    // resolve instantly, so the paused amount ≈ the real blocking wait.
    const waitStart = Date.now();
    const results = await Promise.all(
      entries.map(async ([childId]) => {
        const r = await this.collect(childId, timeoutMs);
        return r;
      }),
    );
    this.addPausedMs(Date.now() - waitStart);
    return results.filter((r): r is ChildResult => r !== null);
  }
}
