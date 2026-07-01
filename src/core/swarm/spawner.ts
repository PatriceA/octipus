import { getConfig } from '@/config';
import type { AnyAgentWorker } from '@/core/agent-manager';
import { getAgentManager } from '@/core/agent-manager';
import type { ToolHandler } from '@/core/agent-worker';
import type { GatewayHub } from '@/core/gateway/hub';
import { getGatewayHub } from '@/core/gateway/hub';
import { buildSecurityReminder, guardInput } from '@/core/orchestrator/input-guard';
import { getRoleConfig, getToolsForRole } from '@/core/orchestrator/roles';
import type { AgentRole } from '@/core/orchestrator/types';
import type { AgentContext } from '@/core/types';
import { agentRepository } from '@/db/repositories/agent-repository';
import { getModelRegistry } from '@/models/model-registry';
import { getTopicConfig } from '@/models/topic-config';
import { coreLogger } from '@/utils/logger';
import { taskFingerprint as _taskFingerprint, getCallGraph } from './call-graph';
import {
  BudgetExceededError,
  CascadedCancellationError,
  ChildTimeoutError,
  classifyChildError,
  DuplicateSpawnError,
  isCancellationError,
} from './errors';
import { getSwarmLedger } from './ledger';
import { swarmNodeRepository } from './node-repository';
import { buildReceipt } from './receipt';
import { lookupCacheHit } from './spawn-cache';
import {
  deriveChildBudget,
  InsufficientBudgetError,
  syncParentTokenUsage,
} from './spawn-budget';
import {
  checkConcurrency,
  checkDepth,
  checkFanOut,
  checkSameRole,
  denialResult as denialResultFn,
} from './spawn-validator';
import { type Scorer, runScorers } from './scorers';
import {
  type AgentNode,
  type ChildResult,
  type ChildResultStatus,
  getLevelDefault,
  type NodeBudget,
  type PendingChild,
  type SpawnChildParams,
  type TaskBrief,
} from './types';
import type { AgentWorker } from '@/core/agent-worker';
import { formatDateTimeContext } from '@/utils/date-context';

/** Re-exported (moved into `call-graph.ts` in Phase 2). */
export const taskFingerprint = _taskFingerprint;

/**
 * Upper bound on `taskBriefPreview` length, both in the DB column and on
 * the wire (WS swarm.node_spawned event). The swarm-tree "view brief"
 * modal reads this verbatim, so the slice must be wide enough to carry a
 * real brief — earlier the WS event was sliced to 200 chars, which made
 * the UI brief look truncated until a REST reload.
 */
export const TASK_BRIEF_PREVIEW_MAX = 4000;

/** Options accepted by spawnChild internally — extends the tool params. */
export interface SpawnChildInternalOpts {
  /** Used by `escalate_to_different_expert` to pick a different expert. */
  excludeExpertId?: string;
  /** Tag logged on spawn — distinguishes normal spawns from escalation. */
  reason?: 'normal' | 'escalation' | 'retry';
}

/**
 * `SwarmSpawner` — Phase 2 full implementation.
 *
 * Responsibilities:
 *  - Depth enforcement: depth 0→1 (Agent), 1→2 (Subagent), 2→throw.
 *    Subagent receives no `spawn_child` (hard leaf).
 *  - Per-turn fan-out cap enforced against `parent.budget.fanOut`.
 *  - Full budget cascade via `deriveChildBudget` — child's cap is the min of
 *    `LEVEL_DEFAULT[depth]` and `parent.remaining - RESERVE`. Enforced in
 *    `AgentWorker.run()` pre-LLM-call check (see agent-worker.ts::loop).
 *  - Cycle protection via `SwarmCallGraph` — fingerprint set + ancestor-chain.
 *  - Permission intersection: `child.allowedToolIds = parent.allowedToolIds ∩ roleTools`.
 *  - Model tier clamp (Q1) via `costPerInputToken + costPerOutputToken`.
 *  - Concurrency pre-check (Q3) against `config.agent.maxConcurrentAgents`.
 *  - Result cache (Q4) scoped to `rootSessionId`.
 *  - Failure recovery per §Failure Modes:
 *      provider_error → 1 retry on same node
 *      tool_error (crash) → 1 retry on new node
 *      others → surface as ChildResult.status; parent LLM decides
 *  - `parentAgentId` + `AbortSignal` chain → AgentManager.spawn.
 *  - Emit `swarm.node_spawned` / `swarm.node_completed`.
 */
export class SwarmSpawner {
  private _hub: GatewayHub | null;

  constructor(hub?: GatewayHub) {
    this._hub = hub ?? null;
  }

  private get hub(): GatewayHub {
    if (!this._hub) this._hub = getGatewayHub();
    return this._hub;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Spawn a child agent and await its result. Returns a structured
   * `ChildResult` the parent LLM can synthesize against.
   */
  async spawnChild(
    parent: AgentNode,
    params: SpawnChildParams,
    parentContext: AgentContext,
    internal: SpawnChildInternalOpts = {},
  ): Promise<ChildResult> {
    // ── Depth enforcement (Phase 2) ─────────────────────────────────
    // Agent (depth 1) spawns Subagent (depth 2). Subagent can NOT spawn.
    const depthDenial = checkDepth(parent);
    if (depthDenial) return depthDenial;

    const childDepth: 1 | 2 = (parent.depth + 1) as 1 | 2;
    const childKind: 'agent' | 'subagent' = childDepth === 1 ? 'agent' : 'subagent';
    const childRole = this.resolveChildRole(params);
    const topicPath = this.buildTopicPath(parent.topicPath, params.topic, params.subtopic);

    // ── Same-role guard ─────────────────────────────────────────────
    // At depth 0→1 (Orchestrator → Agent): Orchestrator role is unique, so
    // same-role is effectively impossible — but we keep the guard for
    // escalation safety.
    // At depth 1→2 (Agent → Subagent): ALLOWED. Lets a research agent fan
    // out to per-datapoint research subagents (per-page scrape, per-row
    // audit, etc.). The Agent still has to justify it against the
    // "datapoint vs dependency" rule in the role prompt — the system
    // doesn't block the fan-out, but bad uses burn budget fast.
    const sameRoleDenial = checkSameRole(parent, childRole, childDepth);
    if (sameRoleDenial) return sameRoleDenial;

    // ── Defense-in-depth: guard raw inputs BEFORE composition ───────
    // The composed child message is already guarded downstream, but
    // guarding the inputs here means an injection attempt in
    // `taskBrief` or the inherited `parentSummary` is rejected at the
    // boundary — closer to the source, with a more specific error,
    // and before any expensive composition work.
    const rawTaskBrief = params.taskBrief;
    const rawParentSummary =
      ((parentContext.metadata as Record<string, unknown>)?.parentSummary as string) || '';

    for (const [field, value] of [
      ['taskBrief', rawTaskBrief] as const,
      ['parentSummary', rawParentSummary] as const,
    ]) {
      if (!value) continue;
      const guard = guardInput(value);
      if (guard.action === 'block') {
        return this.denialResult(
          parent,
          `spawn_child refused: ${field} blocked by input guard ` +
            `(${guard.flags.join(', ')})${guard.blockReason ? `: ${guard.blockReason}` : ''}.`,
        );
      }
    }

    // ── Assemble brief ──────────────────────────────────────────────
    const brief: TaskBrief = {
      originalUserRequest:
        ((parentContext.metadata as Record<string, unknown>)?.originalRequest as string) ||
        rawTaskBrief,
      topicPath,
      parentSummary: rawParentSummary,
      taskBrief: rawTaskBrief,
      constraints: params.constraints || [],
      inputArtifacts: [],
      expectedOutput: {
        shape: params.expectedOutput.shape,
        schema: params.expectedOutput.schema,
        maxTokens: params.expectedOutput.maxTokens ?? 2000,
      },
      // Subagent MUST NOT spawn (hard leaf). Tool intersection already drops
      // the tool; the `forbidden` field is belt-and-suspenders for the LLM prompt.
      forbidden: childDepth >= 2 ? ['Do not spawn children'] : [],
    };

    // ── Cycle protection (Phase 2) ──────────────────────────────────
    const graph = getCallGraph(parent.rootSessionId);
    // Lazy-ensure the parent is registered so ancestor-walks work.
    graph.registerRoot({
      id: parent.id,
      topicPath: parent.topicPath,
      role: parent.role,
    });

    let briefHash: string;
    try {
      ({ fingerprint: briefHash } = graph.checkSpawn(parent.id, brief));
    } catch (err) {
      if (err instanceof DuplicateSpawnError) {
        coreLogger.info(
          { parentNodeId: parent.id, topicPath, existing: err.existingNodeId },
          'Swarm duplicate spawn rejected',
        );
        try {
          this.hub.publishEvent({
            type: 'swarm.call_graph_cycle_blocked',
            source: `swarm:${parent.id}`,
            userId: undefined,
            sessionId: parent.rootSessionId,
            payload: {
              rootSessionId: parent.rootSessionId,
              parentNodeId: parent.id,
              topicPath,
              existingNodeId: err.existingNodeId,
            },
          });
        } catch { /* best effort */ }
        return {
          nodeId: err.existingNodeId ?? '',
          kind: childKind,
          status: 'cancelled',
          output: null,
          usedTokens: 0,
          durationMs: 0,
          spawnedChildren: [],
          notes: err.parentNotice,
        };
      }
      throw err;
    }

    // ── Fan-out cap (Phase 2, per-turn = per-node lifetime) ─────────
    const fanOutDenial = checkFanOut(parent, childKind);
    if (fanOutDenial) return fanOutDenial;

    // ── Cache lookup (Q4) ───────────────────────────────────────────
    // Note: a cache hit creates no new node and appends no ledger event — the
    // cached node already carries its own spawn+terminal ledger history from
    // its original run, so there is nothing in-flight to reconcile here.
    const cacheHit = await lookupCacheHit(parent, briefHash, topicPath, childKind, childDepth, childRole);
    if (cacheHit) {
      this.emitNodeCompleted(parent, cacheHit.completedPayload);
      return cacheHit.result;
    }

    // ── Concurrency pre-check (Q3) ──────────────────────────────────
    const agentManager = getAgentManager();
    const maxConcurrent = getConfig().agent.maxConcurrentAgents;
    const concurrencyDenial = checkConcurrency(
      parent,
      childKind,
      agentManager.getRunningCount(),
      maxConcurrent,
    );
    if (concurrencyDenial) return concurrencyDenial;

    // ── Budget cascade ──────────────────────────────────────────────
    // Done BEFORE reserving fan-out so a refused spawn doesn't consume a slot.
    // Sync the parent's live token spend into its node budget first: the node's
    // `tokens.used` is otherwise never updated (it stays 0), so the reserve
    // math and `InsufficientBudgetError` guard in `deriveChildBudget` never
    // reflect real consumption. No-op for legacy call sites without a workerRef.
    syncParentTokenUsage(parent);
    let budget: NodeBudget;
    try {
      budget = deriveChildBudget(parent.budget, childDepth);
    } catch (err) {
      if (err instanceof InsufficientBudgetError) {
        coreLogger.warn(
          { parentNodeId: parent.id, available: err.available, minimum: err.minimum },
          'Swarm spawn refused — parent near token exhaustion',
        );
        return {
          nodeId: '',
          kind: childKind,
          status: 'budget',
          output: null,
          usedTokens: 0,
          durationMs: 0,
          spawnedChildren: [],
          notes: err.message,
        };
      }
      throw err;
    }

    // Reserve fan-out slot only after budget passes.
    parent.budget.fanOut.used++;

    // ── Permission intersection ─────────────────────────────────────
    const roleTools = getToolsForRole(childRole);

    if (parentContext.userId && parentContext.userId !== 'system' && parentContext.userId !== 'local') {
      try {
        const { getConnectorRegistry } = await import('@/connectors');
        const connectorHandlers = await getConnectorRegistry().getUserToolHandlers(parentContext.userId);
        roleTools.push(...connectorHandlers);
      } catch (err) {
        coreLogger.error({ err, userId: parentContext.userId }, 'Failed to load connector tools for swarm child');
      }
    }

    const childTools = resolveChildTools(parent.allowedToolIds, roleTools);

    coreLogger.info(
      {
        parentNodeId: parent.id,
        parentRole: parent.role,
        childRole,
        roleToolCount: roleTools.length,
        roleToolIds: [...new Set(roleTools.map((t) => t.toolId ?? t.name))],
        parentAllowedToolIdsCount: parent.allowedToolIds.size,
        parentAllowedToolIds: [...parent.allowedToolIds],
        childToolCount: childTools.length,
      },
      'Swarm tool-intersection diagnostic',
    );

    // Phase 2: register swarm meta-tools on Agent (depth 1) children so they
    // can in turn spawn Subagents. Subagent (depth 2) receives NEITHER —
    // hard leaf per design §Conceptual Model. The child's own AgentNode is
    // built inside `singleSpawnAndRun` using the child agentId (known
    // post-spawn). The swarm tools close over that node by reference so the
    // placeholder id is mutated to the real one before any tool can fire.

    // ── Model + expert resolution (topic binding is authoritative) ──
    const { model: childModel, expertId, systemPrompt } = await this.resolveChildModelAndExpert(
      parent.model,
      childRole,
      brief.taskBrief,
      params.expertId,
      internal.excludeExpertId,
    );

    // ── Compose child's initial user message from brief ─────────────
    // Include the list of tools available to this child so the agent can
    // reason "can I solve this with my tools before spawning a subagent?"
    // User spec: "any agent should check tools and see if the task can be
    // done with the given ones."
    const availableToolNames = childTools.map((t) => t.name);
    const childMessage = composeChildMessage(brief, {
      availableToolNames,
      canSpawnChildren: childDepth === 1,
    });
    const guarded = guardInput(childMessage);
    if (guarded.action === 'block') {
      coreLogger.warn(
        { parentId: parent.id, flags: guarded.flags, reason: guarded.blockReason, topicPath },
        'Swarm child brief blocked by input guard',
      );
      return {
        nodeId: 'blocked',
        kind: childKind,
        status: 'denied',
        output: `Spawn blocked by input guard: ${guarded.blockReason}`,
        usedTokens: 0,
        durationMs: 0,
        spawnedChildren: [],
        notes: `flags: ${guarded.flags.join(',')}`,
      };
    }
    const securityReminder =
      guarded.action === 'warn' ? buildSecurityReminder(guarded.flags) : '';
    const finalChildMessage = guarded.action === 'warn'
      ? `${childMessage}\n\n${securityReminder}`
      : childMessage;

    // ── Attempt child spawn + run, with bounded retry per §Failure Modes ──
    const result = await this.runChildWithRetry({
      parent,
      parentContext,
      childDepth,
      childKind,
      childRole,
      childModel,
      childTools,
      systemPrompt,
      expertId,
      budget,
      topicPath,
      subtopic: params.subtopic,
      brief,
      briefHash,
      childMessage: finalChildMessage,
      reason: internal.reason ?? 'normal',
      spawnMode: params.mode ?? 'await',
      scorers: params.scorers,
    });

    // Feed the child's actual spend back into the parent's pool accounting so
    // later spawns (and the budget-cascade guard via `syncParentTokenUsage`)
    // see true consumption, not just the parent's own tokens. Only genuinely
    // executed children reach here — cache hits and pre-run denials return
    // early above (no new tokens spent). Single-threaded async, so the
    // read-modify-write is safe across concurrent detached children.
    parent.budget.childTokensUsed = (parent.budget.childTokensUsed ?? 0) + (result.usedTokens ?? 0);

    return result;
  }

  // ── Child run + retry orchestration ────────────────────────────────

  private async runChildWithRetry(opts: {
    parent: AgentNode;
    parentContext: AgentContext;
    childDepth: 1 | 2;
    childKind: 'agent' | 'subagent';
    childRole: AgentRole;
    childModel: string;
    childTools: ToolHandler[];
    systemPrompt?: string;
    expertId?: string;
    budget: NodeBudget;
    topicPath: string;
    subtopic: string;
    brief: TaskBrief;
    briefHash: string;
    childMessage: string;
    reason: 'normal' | 'escalation' | 'retry';
    spawnMode: 'await' | 'detach';
    scorers?: Scorer[];
  }): Promise<ChildResult> {
    // Retry policy (design §Failure Modes):
    //   provider_error → retry once on the SAME spawn attempt (same node).
    //     Cheap: we call `worker.run(childMessage)` again.
    //   tool_error (crash/throw not mapped to provider) → retry once on a
    //     NEW node (fresh agentId, same brief).
    //   Everything else → surface.
    let attemptNewNode = 0;
    const MAX_NEW_NODE_RETRIES = 1;
    let lastResult: ChildResult | null = null;

    while (attemptNewNode <= MAX_NEW_NODE_RETRIES) {
      const result = await this.singleSpawnAndRun(opts, attemptNewNode > 0);
      lastResult = result;
      if (result.status !== 'tool_error' || attemptNewNode >= MAX_NEW_NODE_RETRIES) {
        return result;
      }
      // Crash retry on new node.
      coreLogger.warn(
        { parentNodeId: opts.parent.id, status: result.status, attempt: attemptNewNode + 1 },
        'Swarm child tool_error — retrying on new node',
      );
      attemptNewNode++;
    }
    return lastResult!;
  }

  /**
   * One spawn + run cycle. Includes an inner `provider_error` retry (single
   * attempt, same worker) per design §Failure Modes.
   */
  private async singleSpawnAndRun(
    opts: Parameters<SwarmSpawner['runChildWithRetry']>[0],
    isCrashRetry: boolean,
  ): Promise<ChildResult> {
    const agentManager = getAgentManager();
    const startTime = Date.now();
    let worker: AnyAgentWorker;

    // Phase 2: for Agents (depth 1), build the child's AgentNode up front
    // so we can register `spawn_child` + `escalate_to_different_expert`
    // alongside the role tools on the *first* spawn call. `id` is a
    // placeholder overwritten after spawn returns; the swarm tools close
    // over `childNode` by reference so the mutation is observed.
    const tools: ToolHandler[] = [...opts.childTools];
    let childNode: AgentNode | null = null;
    if (opts.childDepth === 1) {
      childNode = {
        id: '__pending__',
        rootSessionId: opts.parent.rootSessionId,
        parentNodeId: opts.parent.id,
        kind: 'agent',
        depth: 1,
        role: opts.childRole,
        expertId: opts.expertId,
        topicPath: opts.topicPath,
        subtopic: opts.subtopic,
        model: opts.childModel,
        budget: opts.budget,
        allowedToolIds: new Set(opts.childTools.map((t) => t.toolId ?? t.name)),
        signal: opts.parent.signal, // chained through AgentManager → worker
      };
      // Mutable: childNode.allowedToolIds will include the meta-tool names.
      childNode.allowedToolIds.add('spawn_child');
      childNode.allowedToolIds.add('escalate_to_different_expert');

      // Late-bound worker reference — the AgentWorker is created by
      // `agentManager.spawn(...)` below, but spawn_child / collect_children
      // need a handle to the worker's pending-child map before their
      // `execute` runs. We hand a `{ current: null }` ref to both tool
      // factories and fill it in after spawn returns. All tool executes
      // happen inside `worker.run(...)` which is called after the ref is
      // populated, so the race is theoretical.
      // Late-bind worker handles. The child's AgentWorker doesn't exist
      // yet (agentManager.spawn below creates it) but `spawn_child` and
      // `collect_children` need to read the worker's pending-child map.
      // We stash two refs on childNode itself; both are populated post-spawn.
      const detachHookRef: {
        current: {
          registerPendingChild: (pc: PendingChild) => void;
          pendingDetachedCount: () => number;
        } | null;
      } = { current: null };
      const workerRef: { current: AgentWorker | null } = { current: null };
      (childNode as unknown as { detachHookRef: typeof detachHookRef }).detachHookRef = detachHookRef;
      (childNode as unknown as { workerRef: typeof workerRef }).workerRef = workerRef;

      try {
        const { createSpawnChildTool } = await import('./swarm-tool');
        const { createEscalateTool } = await import('./escalate-tool');
        const { createCollectChildrenTool } = await import('./collect-tool');
        tools.push(
          createSpawnChildTool(childNode, this, {
            registerPending: (pc) => detachHookRef.current?.registerPendingChild(pc),
            pendingCount: () => detachHookRef.current?.pendingDetachedCount() ?? 0,
            maxPendingDetached: () => getLevelDefault(1).maxPendingDetached,
          }),
        );
        tools.push(createEscalateTool(childNode, this));
        tools.push(createCollectChildrenTool(childNode, workerRef));
        childNode.allowedToolIds.add('collect_children');
      } catch (err) {
        coreLogger.error({ err }, 'Failed to load swarm meta-tools — Agent will run without them');
      }
    }

    try {
      worker = await agentManager.spawn({
        sessionId: opts.parent.rootSessionId,
        userId: opts.parentContext.userId,
        // Memory-redesign Phase B — inherit the parent's workspace so
        // task_state and memories rows written by the child carry the
        // same scope as the orchestrator that spawned them.
        workspaceId: opts.parentContext.workspaceId ?? null,
        topic: getRoleConfig(opts.childRole).defaultTopic,
        model: opts.childModel,
        role: opts.childRole,
        systemPrompt: opts.systemPrompt,
        tools,
        maxTokenBudget: opts.budget.tokens.cap,
        timeout: opts.budget.wallClockMs.cap,
        parentAgentId: opts.parent.id,
        parentSignal: opts.parent.signal,
        // Forward the original user request so grandchildren (depth 2) still
        // see it verbatim when they compose their own briefs.
        contextMetadata: {
          originalRequest:
            ((opts.parentContext.metadata as Record<string, unknown>)?.originalRequest as string) ??
            opts.brief.originalUserRequest,
        },
      });
    } catch (err) {
      const msg = (err as Error).message || '';
      const isCap = /Maximum concurrent agents/i.test(msg);
      coreLogger.error({ err, parentNodeId: opts.parent.id }, 'AgentManager.spawn failed in SwarmSpawner');
      return {
        nodeId: '',
        kind: opts.childKind,
        status: isCap ? 'concurrency_limit' : 'tool_error',
        output: null,
        usedTokens: 0,
        durationMs: Date.now() - startTime,
        spawnedChildren: [],
        notes: msg,
      };
    }

    const childId = worker.getContext().id;

    // Late-bind the worker ref onto the childNode. Only the full
    // `AgentWorker` class exposes detach-mode methods — CLI workers never
    // own detached swarm children so we skip them silently.
    const maybeWorker = worker as unknown as {
      registerPendingChild?: (pc: PendingChild) => void;
      pendingDetachedCount?: () => number;
    };
    if (
      typeof maybeWorker.registerPendingChild === 'function' &&
      typeof maybeWorker.pendingDetachedCount === 'function' &&
      childNode
    ) {
      const holder = (childNode as unknown as {
        workerRef?: { current: AgentWorker | null };
      })?.workerRef;
      if (holder) holder.current = worker as unknown as AgentWorker;
      // Also populate the detach-hook ref used by spawn_child.
      const hookHolder = (childNode as unknown as {
        detachHookRef?: {
          current: {
            registerPendingChild: (pc: PendingChild) => void;
            pendingDetachedCount: () => number;
          } | null;
        };
      }).detachHookRef;
      if (hookHolder) {
        hookHolder.current = {
          registerPendingChild: maybeWorker.registerPendingChild.bind(worker),
          pendingDetachedCount: maybeWorker.pendingDetachedCount.bind(worker),
        };
      }
    }

    // Promote the pending childNode.id so spawn_child/escalate resolve to
    // the real child for its descendants.
    if (childNode) childNode.id = childId;

    // ── Register in graph + persist swarm_node row + agent link ────
    const graph = getCallGraph(opts.parent.rootSessionId);
    graph.register({
      id: childId,
      parentNodeId: opts.parent.id,
      topicPath: opts.topicPath,
      role: opts.childRole,
      briefHash: opts.briefHash,
      expertId: opts.expertId,
      escalationUsed: false,
    });

    try {
      await swarmNodeRepository.create({
        id: childId,
        rootSessionId: opts.parent.rootSessionId,
        parentNodeId: opts.parent.id,
        depth: opts.childDepth,
        kind: opts.childKind,
        role: opts.childRole,
        expertId: opts.expertId ?? null,
        topicPath: opts.topicPath,
        subtopic: opts.subtopic,
        model: opts.childModel,
        status: 'running',
        tokenCap: opts.budget.tokens.cap,
        wallClockCapMs: opts.budget.wallClockMs.cap,
        fanOutCap: opts.budget.fanOut.cap,
        briefHash: opts.briefHash,
        taskBriefPreview: opts.brief.taskBrief.slice(0, TASK_BRIEF_PREVIEW_MAX),
        spawnMode: opts.spawnMode,
      });
    } catch (err) {
      coreLogger.error({ err, childId }, 'Failed to persist swarm_node row');
    }

    // Append-only ledger: record the spawn so a crash mid-run leaves a
    // replayable history. Fire-and-forget — the write internally catches+logs,
    // so awaiting buys no fail-loud guarantee and would only add an INSERT's
    // latency to the spawn path. Replay tolerates a spawn that lands after its
    // own terminal (seq-ordered fold keeps the terminal status).
    void getSwarmLedger().recordSpawn({
      rootSessionId: opts.parent.rootSessionId,
      nodeId: childId,
      parentNodeId: opts.parent.id,
      topicPath: opts.topicPath,
      role: opts.childRole,
      depth: opts.childDepth,
    });

    void backfillAgentLink(childId, opts.parent.id);

    this.emitNodeSpawned(opts.parent, {
      nodeId: childId,
      parentNodeId: opts.parent.id,
      kind: opts.childKind,
      depth: opts.childDepth,
      topicPath: opts.topicPath,
      role: opts.childRole,
      expertId: opts.expertId,
      model: opts.childModel,
      budget: opts.budget,
      taskBriefPreview: opts.brief.taskBrief.slice(0, TASK_BRIEF_PREVIEW_MAX),
      retryAttempt: isCrashRetry ? 1 : 0,
    });

    // ── Run child (with provider_error single retry on same node) ──
    let status: ChildResultStatus = 'ok';
    let output: unknown = '';
    let notes: string | undefined;
    let providerRetryUsed = false;

    while (true) {
      try {
        output = await worker.run(opts.childMessage);
        status = 'ok';
        break;
      } catch (err) {
        const s = classifyChildError(err);
        const msg = (err as Error).message || '';
        if (s === 'provider_error' && !providerRetryUsed) {
          providerRetryUsed = true;
          coreLogger.warn(
            { parentNodeId: opts.parent.id, childId, error: msg },
            'Swarm child provider_error — retrying on same node',
          );
          continue;
        }
        status = s;
        notes = msg;
        if (s === 'cancelled' || isCancellationError(err)) {
          // Admin cancel / cascaded abort — expected outcome, not a failure.
          coreLogger.info(
            { parentNodeId: opts.parent.id, childId, status, reason: msg },
            'Swarm child cancelled',
          );
        } else {
          coreLogger.warn(
            { parentNodeId: opts.parent.id, childId, status, error: msg },
            'Swarm child failed',
          );
        }
        break;
      }
    }

    const durationMs = Date.now() - startTime;
    const usedTokens = worker.getTotalTokens();

    // ── Deterministic receipt ───────────────────────────────────────
    // Built from the worker's tool-execution counters, NOT from `output`
    // (the child's prose). Lets the parent audit what the child actually
    // did. CLI workers expose no counters → `null` → receipt marks the
    // side-effect evidence unavailable rather than implying zero.
    const counters = worker.getSideEffectCounters();
    const receipt = buildReceipt({
      nodeId: childId,
      kind: opts.childKind,
      status,
      counters,
      usedTokens,
      tokenCap: opts.budget.tokens.cap,
      durationMs,
    });

    const result: ChildResult = {
      nodeId: childId,
      kind: opts.childKind,
      status,
      output,
      usedTokens,
      durationMs,
      spawnedChildren: [],
      notes,
      receipt,
    };

    // ── Scorer gates ────────────────────────────────────────────────
    // Deterministic verification of the deliverable, run only on an otherwise
    // successful child (a failed run already surfaced its own status). A
    // failed gate flips the result to `contract_failed` and appends the
    // reason — fail loud so the parent can retry/correct instead of
    // synthesizing against output that missed the brief.
    if (status === 'ok' && opts.scorers && opts.scorers.length > 0) {
      const outcome = await runScorers(
        opts.scorers,
        { output: result.output, notes: result.notes },
        { userId: opts.parentContext.userId },
      );
      result.scorerOutcome = outcome;
      if (!outcome.passed) {
        const summary = outcome.failures.map((f) => `${f.scorer}: ${f.reason}`).join('; ');
        status = 'contract_failed';
        result.status = 'contract_failed';
        notes = notes ? `${notes}\nScorer gate failed: ${summary}` : `Scorer gate failed: ${summary}`;
        result.notes = notes;
        coreLogger.info(
          { parentNodeId: opts.parent.id, childId, failures: outcome.failures.length },
          'Swarm child failed scorer gate — marking contract_failed',
        );
      }
    }

    // Persist completion + emit event.
    const dbStatus = mapChildResultToNodeStatus(status);
    try {
      await swarmNodeRepository.updateStatus(childId, {
        status: dbStatus,
        tokensUsed: usedTokens,
        result,
        error: status === 'ok' ? undefined : notes,
      });
    } catch (err) {
      coreLogger.error({ err, childId }, 'Failed to update swarm_node status');
    }

    // Ledger: record the terminal transition, closing this node's history.
    // Fire-and-forget for the same reason as recordSpawn above.
    void getSwarmLedger().recordTerminal({
      rootSessionId: opts.parent.rootSessionId,
      nodeId: childId,
      parentNodeId: opts.parent.id,
      status: dbStatus,
    });

    this.emitNodeCompleted(opts.parent, {
      nodeId: childId,
      parentNodeId: opts.parent.id,
      kind: opts.childKind,
      depth: opts.childDepth,
      topicPath: opts.topicPath,
      role: opts.childRole,
      status: dbStatus,
      usedTokens,
      durationMs,
      output: typeof output === 'string' ? output.slice(0, 400) : undefined,
      error: status === 'ok' ? undefined : (notes || undefined),
    });

    // Cycle-graph cleanup: on failure, drop the fingerprint so a future
    // spawn (possibly with corrected brief) isn't wedged as a dup.
    if (status !== 'ok' && status !== 'cache_hit') {
      graph.unregisterFingerprint(childId);
    }

    return result;
  }

  // ── Root-node construction helper ──────────────────────────────────

  static makeOrchestratorRoot(opts: {
    id: string;
    rootSessionId: string;
    role: AgentRole;
    model: string;
    topicPath?: string;
    allowedToolIds: Iterable<string>;
    signal: AbortSignal;
  }): AgentNode {
    return {
      id: opts.id,
      rootSessionId: opts.rootSessionId,
      parentNodeId: null,
      kind: 'orchestrator',
      depth: 0,
      role: opts.role,
      topicPath: opts.topicPath || 'root',
      model: opts.model,
      budget: (() => {
        const d = getLevelDefault(0);
        return {
          tokens: { cap: d.tokens, used: 0 },
          wallClockMs: { cap: d.wallMs, startedAt: Date.now() },
          fanOut: { cap: d.fanOut, used: 0 },
          depth: 0 as const,
        };
      })(),
      allowedToolIds: new Set(opts.allowedToolIds),
      signal: opts.signal,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────

  private resolveChildRole(params: SpawnChildParams): AgentRole {
    // Validator in swarm-tool.ts guarantees role is set — it rejects
    // spawns missing a resolvable role. Silent defaulting to 'general'
    // was the source of wrong-model routing.
    if (!params.role) {
      throw new Error(
        'SpawnChildParams.role is required — validator must have populated it before reaching the spawner',
      );
    }
    return params.role;
  }

  private buildTopicPath(parentPath: string, topic: string, subtopic: string): string {
    const parts = [parentPath, topic, subtopic].filter(Boolean).map((p) => p.trim());
    return parts.join(' / ');
  }

  /**
   * Pick a model + expert for the child, respecting the parent-tier clamp
   * and the `excludeExpertId` filter (for escalation).
   */
  private async resolveChildModelAndExpert(
    parentModel: string,
    childRole: AgentRole,
    childMessage: string,
    preferredExpertId?: string,
    excludeExpertId?: string,
  ): Promise<{ model: string; expertId?: string; systemPrompt?: string }> {
    const registry = getModelRegistry();

    let expertModel: string | undefined;
    let expertId: string | undefined;
    let systemPrompt: string | undefined;
    let expertSkillIds: string[] = [];
    try {
      const { getDb } = await import('@/db/postgres');
      const { experts } = await import('@/db/schema/experts');
      const { eq, and, ne } = await import('drizzle-orm');
      const db = getDb();

      let rows: Array<{
        id: string;
        name: string;
        modelPreference: string | null;
        systemPrompt: string | null;
        skillIds: unknown;
      }> = [];
      if (preferredExpertId) {
        rows = (await db.select().from(experts).where(eq(experts.id, preferredExpertId)).limit(1)) as typeof rows;
      } else {
        const where = excludeExpertId
          ? and(eq(experts.role, childRole), eq(experts.isSystem, true), ne(experts.id, excludeExpertId))
          : and(eq(experts.role, childRole), eq(experts.isSystem, true));
        rows = (await db.select().from(experts).where(where).limit(1)) as typeof rows;
      }

      const expert = rows[0];
      if (expert) {
        expertId = expert.id;
        expertModel = expert.modelPreference || undefined;
        systemPrompt = expert.systemPrompt || undefined;
        expertSkillIds = Array.isArray(expert.skillIds) ? (expert.skillIds as string[]) : [];
      }
    } catch (err) {
      // Expert lookup failure is recoverable (falls back to role defaults)
      // but NOT silent — log so operators see why a child didn't get the
      // expert's prompt/skills.
      coreLogger.warn({ err, childRole }, 'Expert lookup failed in SwarmSpawner — falling back to role defaults');
    }

    // ── Skill injection (fail-loud on missing expected skills) ──────
    const skillFragments: string[] = [];
    try {
      const { getSkillRegistry } = await import('@/skills/registry');
      const skillReg = getSkillRegistry();

      // Expert-declared skills: the expert named N skill IDs — all must exist.
      if (expertSkillIds.length > 0) {
        const found = await skillReg.getByIds(expertSkillIds);
        if (found.length < expertSkillIds.length) {
          const foundIds = new Set(found.map((s) => s.id));
          const missing = expertSkillIds.filter((id) => !foundIds.has(id));
          coreLogger.error(
            { childRole, expertId, expectedSkillIds: expertSkillIds, missing },
            'Expert lists skillIds that are missing from skill registry — child will run with partial domain knowledge',
          );
        }
        const fragment = await skillReg.buildPromptFragment(expertSkillIds);
        if (fragment) skillFragments.push(`# Domain Knowledge (expert)\n${fragment}`);
      }

      // Topic-assigned skills: skills assigned to the child's role/topic
      // via skill_topic_assignments. No assertion — the user may or may not
      // have assigned any; it's not a bug if none are configured.
      const { discoverSkillIds } = await import('@/skills/discovery');
      const discoveredIds = await discoverSkillIds({
        topic: childRole,
        message: childMessage,
      });
      const topicFragment = discoveredIds.length > 0
        ? await skillReg.buildPromptFragment(discoveredIds)
        : '';
      if (topicFragment) skillFragments.push(`# Domain Knowledge (topic)\n${topicFragment}`);
      coreLogger.debug(
        { childRole, expertId, discoveredSkillCount: discoveredIds.length },
        'Swarm child topic-skill discovery complete',
      );
    } catch (err) {
      coreLogger.error(
        { err, childRole, expertId },
        'Skill injection failed — child will run WITHOUT domain knowledge',
      );
    }

    if (skillFragments.length > 0) {
      systemPrompt = `${systemPrompt ?? ''}\n\n${skillFragments.join('\n\n')}`.trim();
    }

    // Model selection — in order of preference:
    //   1. expert.modelPreference (specialist's explicit choice)
    //   2. topic executorModel (W9 planner→executor split) — the spawned child
    //      IS the executor, so it binds to the topic's configured executor model
    //      when one is set on the Topics page.
    //   3. topic→model mapping (registered role→model binding)
    //   4. fail loud — do NOT inherit parent model. The parent's model is
    //      whatever the orchestrator happened to pick; it has no claim to
    //      being right for the child's topic. Inheriting hides routing bugs.
    let candidate = expertModel;
    if (!candidate) {
      // Empty executorModel ⇒ this whole block is skipped and resolution is
      // byte-for-byte today's behaviour (planner == executor).
      const executorName = getTopicConfig(childRole).executorModel;
      if (executorName) {
        const execModel =
          (await registry.getModel(executorName)) || (await registry.getModelByModelId(executorName));
        if (!execModel) {
          throw new Error(
            `Topic '${childRole}' has executorModel '${executorName}' but no such model is registered. ` +
              `Fix it on the Topics page or clear the executor binding.`,
          );
        }
        candidate = execModel.modelId;
      }
    }
    if (!candidate) {
      const topicModel = await registry.getModelForTopic(childRole);
      candidate = topicModel?.modelId;
    }
    if (!candidate) {
      throw new Error(
        `No model bound to topic '${childRole}'. ` +
          `Map a model to this topic in the Models page (Topics section), ` +
          `or give the '${childRole}' expert an explicit modelPreference.`,
      );
    }

    // NO tier clamp. Topic bindings (and the user's explicit expert
    // modelPreference) are authoritative. Previously we'd downgrade a child
    // whose bound model cost more than the parent's — that silently
    // overrode the user's "this topic uses this model" configuration and
    // sent every child to the orchestrator's model. If cost is a concern,
    // configure it via the Models page.
    return { model: candidate, expertId, systemPrompt };
  }

  private emitNodeSpawned(parent: AgentNode, payload: Record<string, unknown>): void {
    this.hub.publishEvent({
      type: 'swarm.node_spawned',
      source: `swarm:${parent.id}`,
      userId: undefined,
      sessionId: parent.rootSessionId,
      payload: { rootSessionId: parent.rootSessionId, ...payload },
    });
  }

  private emitNodeCompleted(parent: AgentNode, payload: Record<string, unknown>): void {
    this.hub.publishEvent({
      type: 'swarm.node_completed',
      source: `swarm:${parent.id}`,
      userId: undefined,
      sessionId: parent.rootSessionId,
      payload: { rootSessionId: parent.rootSessionId, ...payload },
    });
  }

  private denialResult(parent: AgentNode, reason: string): ChildResult {
    return denialResultFn(parent, reason);
  }
}

// ── Pure helpers (exported for unit tests) ────────────────────────────

// Budget derivation + token-pool accounting moved to `spawn-budget.ts`.
// Re-exported here so `./spawner` importers (tests, swarm/index) are unchanged.
export {
  deriveChildBudget,
  InsufficientBudgetError,
  MIN_CHILD_TOKENS,
  syncParentTokenUsage,
} from './spawn-budget';

/**
 * `child.allowedToolIds = parent.allowedToolIds ∩ requiredToolIds`.
 * Filters the role's tool handlers down to what the parent actually has.
 */
export function resolveChildTools(
  parentAllowed: Set<string>,
  roleTools: ToolHandler[],
): ToolHandler[] {
  return roleTools.filter((t) => {
    const id = t.toolId ?? t.name;
    return parentAllowed.has(id);
  });
}

/** Map a `ChildResult.status` to the DB status enum. */
function mapChildResultToNodeStatus(status: ChildResultStatus): import('./types').SwarmNodeStatus {
  switch (status) {
    case 'ok':
      return 'completed';
    case 'budget':
      return 'budget';
    case 'timeout':
      return 'timeout';
    case 'tool_error':
      return 'tool_error';
    // First-class status — kept distinct from tool_error in the column so a
    // missed contract is queryable/visible as its own failure class.
    case 'contract_failed':
      return 'contract_failed';
    case 'provider_error':
      return 'provider_error';
    case 'cancelled':
      return 'cancelled';
    case 'denied':
      return 'denied';
    case 'concurrency_limit':
      return 'concurrency_limit';
    case 'cache_hit':
      return 'cache_hit';
    default:
      return 'completed';
  }
}

/** Build the child's initial user message from the structured brief. */
export function composeChildMessage(
  brief: TaskBrief,
  opts: { availableToolNames: string[]; canSpawnChildren: boolean },
): string {
  const parts: string[] = [];

  // Ground every child in "today" — without this, time-relative requests
  // ("who played yesterday", "latest news") make the model fall back to its
  // training cutoff and reason about a stale date (e.g. assuming an event
  // hasn't happened yet). The orchestrator grounds its own system prompt
  // (worker-spawner.ts / direct-response.ts), but swarm children spawned here
  // were not — this closes that gap using the shared single-clock format.
  parts.push(
    `CURRENT DATE/TIME: ${formatDateTimeContext(new Date())}. Treat any ` +
      `time-relative phrasing ("today", "yesterday", "this week", "latest", ` +
      `"current") as relative to this — do not assume events are in the future ` +
      `based on your training data.`,
  );

  // Always surface the user's actual request — prevents the child from
  // drifting into what it *thinks* the user wanted based on orchestrator
  // paraphrasing alone.
  if (brief.originalUserRequest) {
    parts.push(`ORIGINAL USER REQUEST (verbatim):\n${brief.originalUserRequest}`);
  }

  parts.push(`Topic path: ${brief.topicPath}`);

  if (brief.parentSummary) {
    parts.push(`Context from parent:\n${brief.parentSummary}`);
  }

  parts.push(`YOUR TASK:\n${brief.taskBrief}`);

  if (brief.constraints.length > 0) {
    parts.push(`Constraints:\n- ${brief.constraints.join('\n- ')}`);
  }

  if (brief.forbidden.length > 0) {
    parts.push(`Forbidden:\n- ${brief.forbidden.join('\n- ')}`);
  }

  // Tool-awareness block: the LLM already receives tools via the
  // function-calling spec, but explicitly listing them in the prompt makes
  // the "can I do this myself with these tools?" check much more reliable.
  const toolList = opts.availableToolNames.length > 0
    ? opts.availableToolNames.join(', ')
    : '(none)';
  parts.push(`Tools available to you: ${toolList}`);

  // Delegation guidance — only relevant for Agents (depth 1); Subagents are
  // structural leaves (the `spawn_child` tool isn't even registered for them).
  if (opts.canSpawnChildren) {
    parts.push(
      'DELEGATION POLICY: Before calling `spawn_child`, check whether the task ' +
        'can be done with the tools above. Spawn subagents when you have 2+ ' +
        'INDEPENDENT units of non-trivial work to run in parallel (per-page ' +
        'research, per-file audit, per-endpoint probe), or when a sub-topic ' +
        "needs a DIFFERENT specialist's toolset. It IS OK to spawn a subagent " +
        'of the same role as you for parallel fan-out (e.g. you are a research ' +
        'agent and you spawn three research subagents, one per source). What ' +
        'is NOT OK is delegating a single task to one same-role subagent — you ' +
        'ARE that specialist; synthesize directly.',
    );
    parts.push(
      'DETACH MODE (`spawn_child` mode="detach"): the default is "await" and is ' +
        'always safe. Use "detach" ONLY when the child output is a DATAPOINT to ' +
        'collect at the end, not a DEPENDENCY for your next step.\n' +
        '- Datapoint (detach OK): scrape a page, probe an endpoint, fetch one ' +
        'row — parallelize so you keep exploring.\n' +
        '- Dependency (MUST await): decide which approach to use, compute an ' +
        'input for your next call.\n' +
        'Rules: (1) default to "await"; (2) at most 3 detached subagents pending ' +
        'at any time; (3) call `collect_children` BEFORE your final answer, or the ' +
        'framework will force-wait with a hard timeout and you may run out of ' +
        'budget for synthesis; (4) don\'t detach trivial work (<30s); (5) if you ' +
        'finalize without collecting, your pending children are cancelled.',
    );
  } else {
    parts.push(
      'You are a leaf subagent: no further delegation. Solve the task with ' +
        'your own tools and return the deliverable.',
    );
  }

  parts.push(
    `Expected output: ${brief.expectedOutput.shape} ` +
      `(max ${brief.expectedOutput.maxTokens} tokens). ` +
      `Return only the deliverable — no preamble.`,
  );

  return parts.join('\n\n');
}

async function backfillAgentLink(childId: string, parentAgentId: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
  try {
    const existing = await agentRepository.findById(childId);
    if (!existing) return;
    const { getDb } = await import('@/db/postgres');
    const { agents } = await import('@/db/schema/agents');
    const { eq } = await import('drizzle-orm');
    await getDb()
      .update(agents)
      .set({ parentAgentId, swarmNodeId: childId })
      .where(eq(agents.id, childId));
  } catch (err) {
    coreLogger.debug({ err, childId }, 'backfillAgentLink skipped');
  }
}

// Re-export for unused-suppression (these errors may surface to callers; kept here to
// document the public surface of the spawner module).
export {
  BudgetExceededError,
  CascadedCancellationError,
  ChildTimeoutError,
  DuplicateSpawnError,
};

let instance: SwarmSpawner | null = null;
export function getSwarmSpawner(): SwarmSpawner {
  if (!instance) instance = new SwarmSpawner();
  return instance;
}
