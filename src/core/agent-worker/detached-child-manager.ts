import { getAgentManager } from '@/core/agent-manager';
import { getPermissionManager } from '@/security/permissions';
import { CLI_QUESTION_TOOL } from '@/shared/cli-questions';
import { redactedCommand } from '@/utils/command-log';
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
  /** Defaults to the permission manager; tests pass a fake. */
  requests?: () => ChildRequestSource;
  /**
   * Whether `agentId` was spawned, at any depth, under `ancestorId`. A
   * grandchild's request blocks the child that is waiting on it, so the
   * parent is told about it as the child's. Defaults to the agent manager's
   * in-memory spawn tree.
   */
  isDescendant?: (agentId: string, ancestorId: string) => boolean;
}

const GUIDANCE_INTERRUPT = 'collect_children interrupted by new guidance; child is still running. Review guidance and decide whether to steer_child or handle it after collection.';
const USER_REQUEST_PAUSE = 'collect_children paused: a child is waiting on the user; this one is still running.';

/**
 * The argument worth naming, per key. Any other argument is left out: tool
 * arguments can carry payloads and secrets the parent has no need to see.
 */
const SUMMARY_ARGS: Record<string, (value: string) => string> = {
  command: redactedCommand,
  file_path: (v) => v,
  path: (v) => v,
  // Origin and path only: a query string or userinfo can carry a token.
  url: (v) => { try { const u = new URL(v); return `${u.origin}${u.pathname}`; } catch { return ''; } },
  query: (v) => v,
};

/** One line for the parent: the question, or the tool and its main argument. */
function describeUserRequest(request: ChildRequestOpened, viaDescendant: boolean): ChildUserRequest {
  const isQuestion = request.toolId === CLI_QUESTION_TOOL;
  const firstQuestion = (request.args.questions as Array<{ question?: unknown }> | undefined)?.[0]?.question;
  const key = Object.keys(SUMMARY_ARGS).find(k => typeof request.args[k] === 'string');
  const mainArg = key ? SUMMARY_ARGS[key](request.args[key] as string) : '';
  const text = (viaDescendant ? 'from one of its own subagents: ' : '') + (isQuestion
    ? (typeof firstQuestion === 'string' ? firstQuestion : 'a question')
    : `${request.toolName}${mainArg ? `: ${mainArg}` : ''}`);
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
  /**
   * Notices for a parent that was not collecting when a child's request
   * opened, by request id, until the worker takes them. Kept apart from
   * steering on purpose: a notice is not user guidance, so it must not wake a
   * later collect as "new guidance", grant iterations, or interrupt a CLI
   * turn. A request that resolves first takes its undelivered notice with it.
   */
  private notices = new Map<string, string>();
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
   * Undelivered child-waiting notices, removed as they are returned. The
   * worker adds them to the model's context where it delivers other context:
   * before the next model call (native) or on the next Octipus tool
   * response's run context (CLI).
   */
  takeNotices(): string[] {
    const notices = [...this.notices.values()];
    this.notices.clear();
    return notices;
  }

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
      this.notices.clear();
    }
  }

  private isDescendant(agentId: string, ancestorId: string): boolean {
    try {
      return (this.options.isDescendant ?? ((a, b) => getAgentManager().isDescendant(a, b)))(agentId, ancestorId);
    } catch { return false; /* agent manager unavailable (tests / early boot) */ }
  }

  /**
   * A child (or one of its own subagents) opened an approval or CLI question.
   * The user is asked in the session either way; this only keeps the parent
   * from waiting blind. A `collect_children` wait returns at once with the
   * child marked waiting. A parent doing other work gets one notice. A
   * finalize-time auto-collect is left alone: a CLI parent cancels whatever is
   * still pending after it, which would kill the child the user is answering.
   * Pipeline handles carry no agent id and are not matched.
   */
  private childRequestOpened(request: ChildRequestOpened): void {
    const children = [...this.pending.values()].filter(p => p.agentId !== undefined);
    let pc = children.find(p => p.agentId === request.agentId);
    const viaDescendant = !pc;
    pc ??= children.find(p => this.isDescendant(request.agentId, p.agentId!));
    if (!pc) return;
    const userRequest = describeUserRequest(request, viaDescendant);
    pc.userRequests = [...(pc.userRequests ?? []), userRequest];
    if (this.requestWaiters.size > 0) {
      for (const wake of [...this.requestWaiters]) wake(new Error(USER_REQUEST_PAUSE));
      return;
    }
    if (this.waiters.size > 0) return;
    this.notices.set(userRequest.id,
      `Subagent ${pc.childId} is waiting on the user (${userRequest.kind} ${userRequest.id}: ${userRequest.summary}). ` +
        'The user is being asked in this session; the child was not cancelled and continues once they answer. ' +
        'You cannot answer it for them. Carry on with other work; collect_children will wait for the child.');
  }

  private childRequestResolved(requestId: string): void {
    this.notices.delete(requestId);
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
        // Only for the explicit tool: its text tells the parent to collect again
        // later. The finalize auto-collect (after which a CLI parent cancels what
        // is still pending) must not promise the child carries on.
        ...(opts.wakeOnUserRequest && pc.userRequests?.length ? { userRequests: [...pc.userRequests] } : {}),
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
