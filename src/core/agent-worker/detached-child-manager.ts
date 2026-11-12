import { getPermissionManager } from '@/security/permissions';
import { agentLogger, coreLogger } from '@/utils/logger';
import { getLevelDefault } from '../swarm/types';
import type { ChildResult, ChildUserRequest, PendingChild } from '../swarm/types';

/**
 * Where a child's requests to the user open and close: the permission manager.
 * Native tool approvals, CLI tool approvals and CLI questions all pass through
 * `requestApproval` under the child's agent id, and every way a request ends
 * (answer, expiry, the child stopping) is announced as resolved — one hook for
 * both worker kinds instead of plumbing through each.
 */
export interface ChildRequestSource {
  onRequest(handler: (request: ChildRequestOpened) => void): () => void;
  onResolved(handler: (event: { requestId: string; agentId: string }) => void): () => void;
}

interface ChildRequestOpened { requestId: string; agentId: string; toolId: string; toolName: string; args: Record<string, unknown> }

export interface DetachedChildManagerOptions {
  /**
   * Tell a parent that is not collecting that a child is waiting on the user.
   * Returns a withdraw callback, called if the request resolves first, so a
   * notice not yet delivered does not report a wait that is over.
   */
  notify?: (content: string) => (() => void) | void;
  /** Defaults to the permission manager; tests pass a fake. */
  requests?: () => ChildRequestSource;
}

const GUIDANCE_INTERRUPT = 'collect_children interrupted by new guidance; child is still running. Review guidance and decide whether to steer_child or handle it after collection.';
const USER_REQUEST_PAUSE = 'collect_children paused: a child is waiting on the user; this one is still running.';

/** One line for the parent: the question, or the tool and its main argument. */
function describeUserRequest(request: ChildRequestOpened): ChildUserRequest {
  const isQuestion = request.toolId === 'cli-native:AskUserQuestion';
  const firstQuestion = (request.args.questions as Array<{ question?: unknown }> | undefined)?.[0]?.question;
  const mainArg = ['command', 'file_path', 'path', 'url', 'query'].map(key => request.args[key]).find(v => typeof v === 'string')
    ?? Object.values(request.args).find(v => typeof v === 'string');
  const text = isQuestion
    ? (typeof firstQuestion === 'string' ? firstQuestion : 'a question')
    : `${request.toolName}${mainArg ? `: ${String(mainArg)}` : ''}`;
  const line = text.replace(/\s+/g, ' ').trim();
  return { id: request.requestId, kind: isQuestion ? 'question' : 'approval', summary: line.length > 160 ? `${line.slice(0, 159)}…` : line };
}

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
  private latest: Map<string, PendingChild> = new Map();
  private collected: Map<string, ChildResult> = new Map();
  /** Children the last collectAll settled and removed — restorable if its answer never arrived. */
  private lastCollected: PendingChild[] = [];

  private waiters = new Set<(reason?: Error) => void>();
  /** The subset of `waiters` from `collect_children` itself, which a child's request to the user ends early. */
  private requestWaiters = new Set<(reason?: Error) => void>();
  private generationWaiters = new Map<string, Set<(reason?: Error) => void>>();
  /** Withdraw callbacks of notices sent for still-open requests, by request id. */
  private noticeWithdrawals = new Map<string, () => void>();
  private unsubscribeRequests: (() => void) | null = null;

  /** Wake the parent only; child promises and results remain intact. */
  interruptWaits(): void {
    for (const wake of this.waiters) wake();
  }

  constructor(
    private readonly agentId: string,
    private readonly getTimeout: () => number,
    private readonly addPausedMs: (durationMs: number) => void,
    private readonly hasGuidance: () => boolean = () => false,
    private readonly options: DetachedChildManagerOptions = {},
  ) {}

  /**
   * Listen for the children's requests only while some are pending: the
   * permission manager is process-wide and outlives this worker.
   */
  private syncRequestSubscription(): void {
    if (this.pending.size > 0 && !this.unsubscribeRequests) {
      try {
        const source = (this.options.requests ?? getPermissionManager)();
        const offRequest = source.onRequest(request => this.childRequestOpened(request));
        const offResolved = source.onResolved(event => this.childRequestResolved(event.requestId));
        this.unsubscribeRequests = () => { offRequest(); offResolved(); };
      } catch { /* permission manager unavailable (tests / early boot) */ }
    } else if (this.pending.size === 0 && this.unsubscribeRequests) {
      this.unsubscribeRequests();
      this.unsubscribeRequests = null;
      this.noticeWithdrawals.clear();
    }
  }

  /**
   * A child opened an approval or CLI question. The user is asked in the
   * session either way; this only keeps the parent from waiting blind. A
   * `collect_children` wait returns at once with the child marked waiting. A
   * parent doing other work gets one notice through its steering path. A
   * finalize-time auto-collect is left alone: a CLI parent cancels whatever is
   * still pending after it, which would kill the child the user is answering.
   */
  private childRequestOpened(request: ChildRequestOpened): void {
    const pc = [...this.pending.values()].find(p => p.agentId !== undefined && p.agentId === request.agentId);
    if (!pc) return;
    const userRequest = describeUserRequest(request);
    pc.userRequests = [...(pc.userRequests ?? []), userRequest];
    if (this.requestWaiters.size > 0) {
      for (const wake of [...this.requestWaiters]) wake(new Error(USER_REQUEST_PAUSE));
      return;
    }
    if (this.waiters.size > 0 || !this.options.notify) return;
    const withdraw = this.options.notify(
      `Subagent ${pc.childId} is waiting on the user (${userRequest.kind} ${userRequest.id}: ${userRequest.summary}). ` +
        'The user is being asked in this session; the child was not cancelled and continues once they answer. ' +
        'You cannot answer it for them. Carry on, and call collect_children later.',
    );
    if (withdraw) this.noticeWithdrawals.set(userRequest.id, withdraw);
  }

  private childRequestResolved(requestId: string): void {
    const withdraw = this.noticeWithdrawals.get(requestId);
    this.noticeWithdrawals.delete(requestId);
    withdraw?.();
    for (const pc of this.pending.values()) {
      if (!pc.userRequests?.some(r => r.id === requestId)) continue;
      const open = pc.userRequests.filter(r => r.id !== requestId);
      if (open.length) pc.userRequests = open;
      else delete pc.userRequests;
    }
  }

  registerPendingChild(pc: PendingChild): void {
    // Same id again (a resumed pipeline): the earlier run's result is stale (#19).
    this.collected.delete(pc.childId);
    this.pending.set(pc.childId, pc);
    this.latest.set(pc.childId, pc);
    this.syncRequestSubscription();
    for (const wake of this.generationWaiters.get(pc.childId) ?? []) wake();
    // Settle eagerly into collected so auto-collect and ad-hoc
    // collect_children calls can both find results without racing on the
    // shared promise. We keep the entry in pending until the LLM
    // (or framework) explicitly collects — that's what drives the cap.
    pc.promise.then(
      (result) => { if (this.pending.get(pc.childId) === pc) this.collected.set(pc.childId, result); },
      (err) => {
        if (this.pending.get(pc.childId) !== pc) return;
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

  /**
   * Mark a pending child as collected. Returns its result (awaiting if needed).
   * `wakeOnUserRequest`: a child opening a request to the user ends the wait
   * (the `collect_children` tool sets it; auto-collect does not).
   */
  async collect(childId: string, timeoutMs: number, opts: { wakeOnUserRequest?: boolean } = {}): Promise<ChildResult | null> {
    const waitStarted = Date.now();
    const pc = this.pending.get(childId);
    if (!pc) return null;
    const settled = this.collected.get(childId);
    if (settled) {
      this.pending.delete(childId);
      this.syncRequestSubscription();
      return settled;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: ((reason?: Error) => void) | undefined;
    try {
      const interrupted = new Promise<ChildResult>((_, reject) => {
        wake = (reason) => reject(reason ?? new Error(GUIDANCE_INTERRUPT));
        this.waiters.add(wake);
        if (opts.wakeOnUserRequest) this.requestWaiters.add(wake);
        const generationWaiters = this.generationWaiters.get(childId) ?? new Set<(reason?: Error) => void>();
        generationWaiters.add(wake);
        this.generationWaiters.set(childId, generationWaiters);
        if (this.hasGuidance()) wake();
      });
      const result = await Promise.race([
        interrupted,
        pc.promise,
        new Promise<ChildResult>((_, reject) =>
          { timer = setTimeout(() => reject(new Error(`collect_children timeout after ${timeoutMs}ms`)), timeoutMs); },
        ),
      ]);
      if (this.pending.get(childId) !== pc) {
        // Resume replaced the promise while this collector was already waiting.
        return this.collect(childId, Math.max(0, timeoutMs - (Date.now() - waitStarted)), opts);
      }
      this.pending.delete(childId);
      this.syncRequestSubscription();
      return result;
    } catch (err) {
      if (this.pending.get(childId) !== pc) return this.collect(childId, Math.max(0, timeoutMs - (Date.now() - waitStarted)), opts);
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
        ...(pc.userRequests?.length ? { userRequests: [...pc.userRequests] } : {}),
      };
    } finally {
      clearTimeout(timer);
      if (wake) {
        this.waiters.delete(wake);
        this.requestWaiters.delete(wake);
        const generationWaiters = this.generationWaiters.get(childId);
        generationWaiters?.delete(wake);
        if (!generationWaiters?.size) this.generationWaiters.delete(childId);
      }
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
    this.syncRequestSubscription();
  }

  /** Collect every still-pending detached child. Used by collect_children and auto-collect. */
  async collectAll(timeoutMs: number, opts: { wakeOnUserRequest?: boolean } = {}): Promise<ChildResult[]> {
    const entries = [...this.pending.entries()];
    this.lastCollected = [];
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
        const r = await this.collect(childId, timeoutMs, opts);
        return r;
      }),
    );
    this.addPausedMs(Date.now() - waitStart);
    this.lastCollected = entries.flatMap(([childId]) => {
      const pc = this.latest.get(childId);
      return pc && !this.pending.has(childId) ? [pc] : [];
    });
    return results.filter((r): r is ChildResult => r !== null);
  }

  /**
   * Put the last collectAll's settled children back in pending: its response
   * never reached the caller. Their results stay in `collected`, so the next
   * collect (explicit or auto) returns them instantly. Returns how many.
   */
  redeliverLast(): number {
    const restored = this.lastCollected.filter((pc) => this.latest.get(pc.childId) === pc && !this.pending.has(pc.childId));
    for (const pc of restored) this.pending.set(pc.childId, pc);
    this.syncRequestSubscription();
    this.lastCollected = [];
    return restored.length;
  }
}
