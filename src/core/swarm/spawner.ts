import { getConfig } from '@/config';
import { recordSwarmSpawn } from '@/core/telemetry';
import type { AnyAgentWorker } from '@/core/agent-manager';
import { getAgentManager } from '@/core/agent-manager';
import type { ToolHandler } from '@/core/agent-worker';
import type { GatewayHub } from '@/core/gateway/hub';
import { getGatewayHub } from '@/core/gateway/hub';
import { getOrchestratorHooks } from '@/core/orchestrator/hooks';
import { buildSecurityReminder, guardInput } from '@/core/orchestrator/input-guard';
import { formatCriticalRules, getRoleConfig, getToolsForRole } from '@/core/orchestrator/roles';
import { estimateToolSchemaTokens, logPromptComposition } from '@/core/orchestrator/prompt-budget';
import { applyToolCap, isSmallModel } from '@/core/orchestrator/small-model';
import { pipelineMetadata } from '@/core/orchestrator/worker-spawner';
import { countChangedFiles, snapshotWorkspace } from '@/core/orchestrator/workspace-snapshot';
import type { AgentRole } from '@/core/orchestrator/types';
import { WorkspaceFS } from '@/security/workspace-fs';
import type { AgentContext } from '@/core/types';
import { agentRepository } from '@/db/repositories/agent-repository';
import { verificationEvidenceRepository } from '@/db/repositories/verification-evidence-repository';
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
  MIN_CHILD_TOKENS,
  shouldWarnBudget,
  syncParentTokenUsage,
} from './spawn-budget';
import {
  checkConcurrency,
  checkDepth,
  checkFanOut,
  checkSameRole,
  denialResult as denialResultFn,
} from './spawn-validator';
import {
  type Scorer,
  type ScorerContext,
  deriveCodeDiffScorer,
  deriveSchemaScorer,
  deriveToolOutageScorer,
  renderContractFeedback,
  runScorers,
} from './scorers';
import { applyRoleFit, buildDelegationGuidance } from './swarm-tool';
import { recordChildScope, buildSiblingScopeBrief } from './session-scope';
import {
  type AgentNode,
  type ChildResult,
  type ChildResultStatus,
  getLevelDefault,
  type NodeBudget,
  type PendingChild,
  type PlanStep,
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
  /**
   * The RESOLVED orchestrator tier for this turn, threaded down from
   * `createSpawnChildTool`. Only `resolveChildRole` reads it, to decide whether
   * the deterministic role-fit rewrite applies (it is a small-model workaround).
   *
   * Threaded rather than re-derived: `resolveOrchestratorMode` already resolved
   * it once for this turn, using the model's `metadata.paramCount` when the id
   * carries no size tag. Deriving it a second time from the id alone would give
   * a different answer for the same model.
   */
  orchestratorIsLite?: boolean;
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
  /**
   * Nodes that have already warned about their pool. One warning per node, not
   * one per spawn: the narration bridge renders every `swarm.budget_warning`
   * into a line for the user, and a parent that keeps spawning past the
   * threshold would narrate the same sentence on each one.
   *
   * Pruned when a node reaches a terminal status. The spawner is a
   * process-lifetime singleton, so an id added and never removed is a leak that
   * grows with every run the process serves.
   */
  private readonly budgetWarned = new Set<string>();

  constructor(hub?: GatewayHub) {
    this._hub = hub ?? null;
  }

  private get hub(): GatewayHub {
    if (!this._hub) this._hub = getGatewayHub();
    return this._hub;
  }

  /**
   * Say so, once, when a node's token pool crosses the warning threshold.
   *
   * Best-effort by construction: a warning that could fail a spawn would be
   * worse than no warning at all.
   */
  private emitBudgetWarning(node: AgentNode): void {
    if (!shouldWarnBudget(node.budget)) return;
    if (this.budgetWarned.has(node.id)) return;
    const { cap, used } = node.budget.tokens;
    this.budgetWarned.add(node.id);
    try {
      this.hub.publishEvent({
        type: 'swarm.budget_warning',
        source: `swarm:${node.id}`,
        sessionId: node.rootSessionId,
        payload: {
          nodeId: node.id,
          depth: node.depth,
          role: node.role,
          tokensUsed: used,
          tokenCap: cap,
          remaining: Math.max(0, cap - used),
        },
      });
    } catch (err) {
      coreLogger.debug({ err, nodeId: node.id }, 'budget warning not published');
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Spawn a child agent and await its result. Returns a structured
   * `ChildResult` the parent LLM can synthesize against.
   *
   * Thin wrapper around `spawnChildInner` that runs the dispatch waterfall:
   * `spawn:before` (may rewrite nothing, but may DENY or substitute a result)
   * and `spawn:after` on every exit path. The wrapper exists so the many
   * return points inside the spawn body stay untouched — every one of them
   * still reports exactly once.
   */
  async spawnChild(
    parent: AgentNode,
    params: SpawnChildParams,
    parentContext: AgentContext,
    internal: SpawnChildInternalOpts = {},
  ): Promise<ChildResult> {
    const hooks = getOrchestratorHooks();
    const childDepth = parent.depth + 1;
    const startedAt = Date.now();

    let childRole: AgentRole;
    try {
      childRole = this.resolveChildRole(params, internal.orchestratorIsLite);
    } catch (err) {
      // A malformed spawn reports too: `spawn:after` is the seam subscribers
      // count on, and this throw happens before `spawn:before` could fire.
      await hooks.fire('spawn:after', {
        parentNodeId: parent.id,
        childRole: params.role ?? 'general',
        childDepth,
        status: 'failed',
        reason: (err as Error)?.message,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
    // Resolved ONCE. The inner body resolves again from `params`, so the
    // role-fit rewrite (and its log line) must already be baked in here.
    const spawnParams = { ...params, role: childRole };

    const before = await hooks.fireWaterfall('spawn:before', {
      parentNodeId: parent.id,
      parentRole: parent.role,
      childDepth,
      childRole,
      topicPath: this.buildTopicPath(parent.topicPath, params.topic, params.subtopic),
      planned: !!params.plan?.length,
      agent: {
        userId: parentContext.userId,
        sessionId: parentContext.sessionId,
        role: parent.role,
        metadata: parentContext.metadata as Record<string, unknown> | undefined,
      },
    });

    const reportAfter = (status: 'completed' | 'denied' | 'failed', reason?: string) =>
      hooks.fire('spawn:after', {
        parentNodeId: parent.id,
        childRole,
        childDepth,
        status,
        reason,
        durationMs: Date.now() - startedAt,
      });

    if (before.shortCircuit) {
      const sc = before.shortCircuit;
      if ('deny' in sc) {
        await reportAfter('denied', sc.deny);
        return this.denialResult(parent, `spawn_child refused by policy: ${sc.deny}`);
      }
      await reportAfter('completed');
      return sc.result as ChildResult;
    }

    let result: ChildResult;
    try {
      result = await this.spawnChildInner(parent, spawnParams, parentContext, internal);
    } catch (err) {
      await reportAfter('failed', (err as Error)?.message);
      throw err;
    }
    await reportAfter(
      result.status === 'ok' || result.status === 'cache_hit' ? 'completed' : 'failed',
      result.status === 'ok' || result.status === 'cache_hit' ? undefined : result.status,
    );
    return result;
  }

  private async spawnChildInner(
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
    const childRole = this.resolveChildRole(params, internal.orchestratorIsLite);
    const topicPath = this.buildTopicPath(parent.topicPath, params.topic, params.subtopic);

    // WS4 observability — count spawns that clear the depth gate, by child role,
    // depth, and planned-ness. (Later input-guard/same-role denials are rare;
    // this tracks the fan-out shape well enough for capacity/cost dashboards.)
    // `planned` is the label that shows whether the cheap planner→executor
    // split is actually being exercised — planned=false on every spawn means
    // the executorModel lane is configured but dead.
    recordSwarmSpawn(childRole, childDepth, !!params.plan?.length);

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
      // Explicit execution plan (optional). Presence routes the child to the
      // lane's executorModel and switches it to mechanical-execution mode.
      plan: params.plan,
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

    // `checkSpawn` RESERVED briefHash. Every exit before `register()` (deep in
    // singleSpawnAndRun) must release it, or that brief is wrongly deduped for
    // the rest of the root session. `releaseFingerprint` is a no-op once a node
    // owns the fingerprint, so releasing on the final success path too is safe.
    // Two helpers cover the two exit shapes: `denyAndRelease` for early-return
    // denials, `releaseOnThrow` for an awaited call that rejects.
    const denyAndRelease = <T>(denial: T): T => {
      graph.releaseFingerprint(briefHash);
      return denial;
    };
    const releaseOnThrow = async <T>(fn: () => T | Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        graph.releaseFingerprint(briefHash);
        throw err;
      }
    };

    // ── Fan-out cap (Phase 2, per-turn = per-node lifetime) ─────────
    const fanOutDenial = checkFanOut(parent, childKind);
    if (fanOutDenial) return denyAndRelease(fanOutDenial);

    // ── Cache lookup (Q4) ───────────────────────────────────────────
    // Note: a cache hit creates no new node and appends no ledger event — the
    // cached node already carries its own spawn+terminal ledger history from
    // its original run, so there is nothing in-flight to reconcile here.
    const cacheHit = await releaseOnThrow(() => lookupCacheHit(parent, briefHash, topicPath, childKind, childDepth, childRole));
    if (cacheHit) {
      this.emitNodeCompleted(parent, cacheHit.completedPayload);
      return denyAndRelease(cacheHit.result);
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
    if (concurrencyDenial) return denyAndRelease(concurrencyDenial);

    // ── Budget cascade ──────────────────────────────────────────────
    // Done BEFORE reserving fan-out so a refused spawn doesn't consume a slot.
    // Sync the parent's live token spend into its node budget first: the node's
    // `tokens.used` is otherwise never updated (it stays 0), so the reserve
    // math and `InsufficientBudgetError` guard in `deriveChildBudget` never
    // reflect real consumption. No-op for legacy call sites without a workerRef.
    let budget: NodeBudget;
    try {
      // Inside the try so a throw here also hits the release-and-rethrow below.
      syncParentTokenUsage(parent);
      budget = deriveChildBudget(parent.budget, childDepth);
    } catch (err) {
      if (err instanceof InsufficientBudgetError) {
        coreLogger.warn(
          { parentNodeId: parent.id, available: err.available, minimum: err.minimum },
          'Swarm spawn refused — parent near token exhaustion',
        );
        return denyAndRelease({
          nodeId: '',
          kind: childKind,
          status: 'budget',
          output: null,
          usedTokens: 0,
          durationMs: 0,
          spawnedChildren: [],
          notes: err.message,
        });
      }
      graph.releaseFingerprint(briefHash);
      throw err;
    }

    // The pool is now synced to real spend, so this is the one point in the run
    // where "how much is left" is both accurate and about to matter. The event
    // was declared in the gateway protocol and subscribed by both the websocket
    // route and the persona narration bridge — which carries a `budget_warning`
    // template — and nothing had ever published it, so that narration had never
    // once fired. Found by the generated event matrix.
    this.emitBudgetWarning(parent);

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

    let childTools = resolveChildTools(parent.allowedToolIds, roleTools);

    // Phase 2: register swarm meta-tools on Agent (depth 1) children so they
    // can in turn spawn Subagents. Subagent (depth 2) receives NEITHER —
    // hard leaf per design §Conceptual Model. The child's own AgentNode is
    // built inside `singleSpawnAndRun` using the child agentId (known
    // post-spawn). The swarm tools close over that node by reference so the
    // placeholder id is mutated to the real one before any tool can fire.

    // ── Model + expert resolution (topic binding is authoritative) ──
    const { model: childModel, lane: childLane, expertId, systemPrompt, isSmall } = await releaseOnThrow(() =>
      this.resolveChildModelAndExpert(
        parent.model,
        childRole,
        brief.taskBrief,
        params.expertId,
        internal.excludeExpertId,
        childTools.length > 0,
        !!brief.plan?.length,
      ));

    // Small-tier child: cap the tool surface, mirroring the worker path. Role
    // tool lists are priority-ordered so the core groups survive. Applied here —
    // after resolution (the tier needs the bound model) but BEFORE the skill
    // loader is appended, so the loader can never be the thing the cap drops.
    if (isSmall) {
      childTools = applyToolCap(childTools, getConfig().orchestrator.smallModelMaxTools, {
        role: childRole,
        modelId: childModel,
      });
    }

    // Skill loader (`get_skill`/`list_skills`): the child's Domain Knowledge is
    // injected as an INDEX (name + 1-line desc), and the body is pulled on
    // demand. Native workers get these globally, but they never appear in the
    // child's advertised tool list — and a CLI worker ignores in-process tools
    // entirely (registerTools is a no-op), so without advertising the loader a
    // CLI child sees the index but no way to load a skill. Append them here so
    // both worker kinds see the loader in "Tools available to you"; the CLI
    // child reaches the equivalent `octipus_get_skill` over MCP. Idempotent —
    // registerTool is keyed by name.
    const { buildSkillLoaderHandlers } = await import('@/tools/skill-loader');
    childTools.push(...buildSkillLoaderHandlers());

    // Logged here, after the cap and the loader push, so `childToolCount` is
    // the surface the child ACTUALLY gets — a diagnostic that reports a
    // different number than the child sees is worse than none.
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
        smallModelTier: isSmall,
      },
      'Swarm tool-intersection diagnostic',
    );

    // ── Compose child's initial user message from brief ─────────────
    // Include the list of tools available to this child so the agent can
    // reason "can I solve this with my tools before spawning a subagent?"
    // User spec: "any agent should check tools and see if the task can be
    // done with the given ones."
    const availableToolNames = childTools.map((t) => t.name);

    // Plan tool validation (planner→executor split): a plan step may name a tool
    // the child doesn't actually hold — the parent-intersection dropped it, or
    // the planner guessed a name. Cross-check against the child's real toolset.
    // A partially-bad plan still runs (composeChildMessage marks the missing
    // tool so the mechanical executor doesn't blindly call it), but a plan whose
    // EVERY tool-bearing step is unrunnable is denied so the parent re-plans
    // instead of burning a doomed child.
    if (brief.plan?.length) {
      const { missingTools, unrunnable } = planToolGaps(brief.plan, availableToolNames);
      if (unrunnable) {
        // The plan can't run as specified. Deny so the parent re-plans — and go
        // through denyAndRelease so the reserved briefHash fingerprint is freed;
        // otherwise a same-content re-plan hashes identically and is silently
        // blocked as a duplicate, contradicting the "re-plan" advice below.
        return denyAndRelease(
          this.denialResult(
            parent,
            `spawn_child refused: every tool named in the plan is unavailable to the '${childRole}' ` +
              `child (named: ${missingTools.join(', ')}; available: ${availableToolNames.join(', ') || 'none'}). ` +
              `Re-plan using the child's tools.`,
          ),
        );
      }
      if (missingTools.length > 0) {
        // Partially-bad plan still runs; the missing tools are rendered as
        // unavailable in the checklist (composeChildMessage).
        coreLogger.warn(
          { childRole, missingTools, availableToolNames },
          'Plan names tools the child does not have — steps rendered as tool-unavailable',
        );
      }
    }

    // A planned child is a mechanical executor: it does not delegate, so it gets
    // neither the delegation reminder nor the (system-prompt) delegation guidance
    // — and, in singleSpawnAndRun, no spawn/collect meta-tools. Only plan-less
    // depth-1 agents are delegators.
    const canSpawnChildren = childDepth === 1 && !brief.plan?.length;
    const childMessage = composeChildMessage(brief, {
      availableToolNames,
      canSpawnChildren,
      // Tell the agent it has a cheap executor to plan for — only when its lane
      // actually binds one (getTopicConfig on the child's resolved lane).
      executorModel: canSpawnChildren ? getTopicConfig(childLane).executorModel ?? undefined : undefined,
    });
    // Delegation guidance is static, identical for every depth-1 spawn, so it
    // lives in the (cacheable) system prompt instead of every brief (Phase 4).
    const childSystemPrompt = canSpawnChildren
      ? `${systemPrompt ?? ''}\n\n${buildDelegationGuidance()}`.trim()
      : systemPrompt;

    // Context-window gate (RC7): warn if the child's first-turn input already
    // approaches the model's context window — it will truncate or fail before
    // doing any work. Estimate BOTH the system prompt (role prompt + injected
    // skill/domain-knowledge fragments — the larger, more variable part) and the
    // brief; a short brief on a small-context model with big skill blocks is the
    // real risk. Warn-only (per the gate policy); the binding stays authoritative.
    try {
      const boundModel = await getModelRegistry().getModelByModelId(childModel);
      const ctx = boundModel?.contextWindow ?? 0;
      const estTokens = Math.ceil(((childSystemPrompt?.length ?? 0) + childMessage.length) / 4);
      // Break the input down per section. The warning below says "you are over
      // the window"; this says WHICH block to cut, which is the actionable half.
      logPromptComposition(
        {
          role: childRole,
          model: childModel,
          isSmall,
          contextWindow: ctx || undefined,
          toolCount: childTools.length,
          toolSchemaTokens: estimateToolSchemaTokens(childTools),
        },
        { system: [childSystemPrompt ?? ''], brief: [childMessage] },
      );
      if (ctx > 0 && estTokens > ctx * 0.9) {
        coreLogger.warn(
          { childRole, model: childModel, estTokens, contextWindow: ctx },
          'Swarm child first-turn input is at/over the model context window — expect truncation or failure',
        );
      }
    } catch (err) {
      coreLogger.debug({ err, childRole, model: childModel }, 'Context-window gate skipped');
    }

    const guarded = guardInput(childMessage);
    if (guarded.action === 'block') {
      coreLogger.warn(
        { parentId: parent.id, flags: guarded.flags, reason: guarded.blockReason, topicPath },
        'Swarm child brief blocked by input guard',
      );
      return denyAndRelease({
        nodeId: 'blocked',
        kind: childKind,
        status: 'denied',
        output: `Spawn blocked by input guard: ${guarded.blockReason}`,
        usedTokens: 0,
        durationMs: 0,
        spawnedChildren: [],
        notes: `flags: ${guarded.flags.join(',')}`,
      });
    }
    const securityReminder =
      guarded.action === 'warn' ? buildSecurityReminder(guarded.flags) : '';
    // Phase 2.5 — inject sibling scope: files already changed this session (+
    // overlapping siblings' final reports) so this child doesn't clobber prior
    // work unaware.
    const siblingScope = await releaseOnThrow(() => buildSiblingScopeBrief(parent.rootSessionId, { topicPath }));
    const finalChildMessage = [childMessage, guarded.action === 'warn' ? securityReminder : '', siblingScope]
      .filter(Boolean)
      .join('\n\n');

    // ── Attempt child spawn + run, with bounded retry per §Failure Modes ──
    const result = await releaseOnThrow(() => this.runChildWithRetry({
      parent,
      parentContext,
      childDepth,
      childKind,
      childRole,
      childModel,
      childLane,
      childTools,
      systemPrompt: childSystemPrompt,
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
      childIsSmall: isSmall,
    }));

    // Feed the child's actual spend back into the parent's pool accounting so
    // later spawns (and the budget-cascade guard via `syncParentTokenUsage`)
    // see true consumption, not just the parent's own tokens. Only genuinely
    // executed children reach here — cache hits and pre-run denials return
    // early above (no new tokens spent). Single-threaded async, so the
    // read-modify-write is safe across concurrent detached children.
    // `discardedTokens` covers attempts that ran and were thrown away (crash
    // retry, backup model, contract retry). They came out of the same pool as
    // the attempt that survived, so the cascade has to see them.
    parent.budget.childTokensUsed =
      (parent.budget.childTokensUsed ?? 0) +
      (result.usedTokens ?? 0) +
      (result.discardedTokens ?? 0);

    // Phase 2.5 — record this child's touched paths (from its file_change
    // events) + final report so subsequent siblings in the session are warned.
    if (result.nodeId) {
      try {
        const paths: string[] = [];
        for (const { event } of getAgentManager().getEvents(result.nodeId)) {
          const data = event.data as { type?: string; path?: string } | undefined;
          if (event.type === 'action' && data?.type === 'file_change' && data.path) {
            paths.push(data.path);
          }
        }
        const report = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
        if (paths.length > 0 || report) {
          recordChildScope(parent.rootSessionId, {
            nodeId: result.nodeId,
            role: childRole,
            topicPath,
            paths,
            report,
          });
        }
      } catch (err) {
        coreLogger.debug({ err, childId: result.nodeId }, 'sibling-scope recording skipped');
      }
    }

    // A spawn that failed inside singleSpawnAndRun (e.g. manager concurrency cap)
    // returns here without ever registering a node — release its reservation.
    // No-op when register() ran (a node owns the fingerprint), so this is safe
    // on the success path too.
    graph.releaseFingerprint(briefHash);
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
    /** Resolved model lane (expert topic or role default) — the backup binding is keyed on this, not the raw role. */
    childLane: string;
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
    /**
     * Whether THIS child's own model is in the small tier — it is the one that
     * will choose its subagent's role, so it decides whether the deterministic
     * role-fit rewrite applies to the grandchildren it spawns.
     */
    childIsSmall?: boolean;
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
    // Every attempt that failed before the one we ultimately return. Without
    // this the retry's clean `ok` is all the parent ever sees, and a run where
    // the first attempt lost every tool it had is indistinguishable from one
    // that worked first time — measured, see docs/plans/quality-loop-status.md.
    const priorFailures: string[] = [];
    // Tokens spent by attempts that are thrown away. Only the RETURNED result's
    // `usedTokens` reaches the parent's pool accounting, so without this a child
    // that took four attempts is charged for one, and the budget cascade grants
    // later siblings a share of tokens that are already gone.
    let discardedTokens = 0;
    const noteFailure = (r: ChildResult): void => {
      const errs = (r.receipt as { sideEffects?: { toolErrors?: number } } | undefined)?.sideEffects
        ?.toolErrors;
      priorFailures.push(
        `${r.status}${errs ? ` after ${errs} failed tool call(s)` : ''}` +
          `${r.notes ? `: ${r.notes.slice(0, 200)}` : ''}`,
      );
    };

    while (attemptNewNode <= MAX_NEW_NODE_RETRIES) {
      const result = await this.singleSpawnAndRun(opts, attemptNewNode > 0);
      lastResult = result;
      if (result.status !== 'tool_error' || attemptNewNode >= MAX_NEW_NODE_RETRIES) {
        break;
      }
      noteFailure(result);
      discardedTokens += result.usedTokens ?? 0;
      // Crash retry on new node.
      coreLogger.warn(
        { parentNodeId: opts.parent.id, status: result.status, attempt: attemptNewNode + 1 },
        'Swarm child tool_error — retrying on new node',
      );
      attemptNewNode++;
    }

    // Topic backup model — the Topics page "Backup" binding. When the child
    // still failed on a model/provider error after the retries above, make ONE
    // more attempt on a fresh node bound to the topic's configured backup.
    // Skipped when no backup is bound or it would rerun the same model.
    if (lastResult && (lastResult.status === 'provider_error' || lastResult.status === 'tool_error')) {
      try {
        const backup = await getModelRegistry().getBackupModelForTopic(opts.childLane);
        if (backup && backup.modelId !== opts.childModel) {
          coreLogger.warn(
            { parentNodeId: opts.parent.id, failedModel: opts.childModel, backupModel: backup.modelId, topic: opts.childLane },
            'Swarm child failed on primary model — retrying once on topic backup model',
          );
          // Both the note and the token charge land only once the replacement
          // actually returns. Doing either before the await counts the same
          // attempt twice when the spawn throws, because the catch below hands
          // that same result back as `lastResult`.
          const superseded = lastResult;
          lastResult = await this.singleSpawnAndRun(
            { ...opts, childModel: backup.modelId, reason: 'retry' },
            true,
          );
          noteFailure(superseded);
          discardedTokens += superseded.usedTokens ?? 0;
        }
      } catch (backupErr) {
        coreLogger.warn(
          { err: backupErr, parentNodeId: opts.parent.id, topic: opts.childRole },
          'Topic backup-model retry failed — surfacing original child result',
        );
      }
    }
    // ── Contract retry ──────────────────────────────────────────────
    // A failed SCORER GATE is the one failure class that is worth re-running
    // with feedback: the child finished, produced something, and missed a
    // check that names exactly what was wrong. Every other retry above is a
    // crash or a provider fault, where there is nothing to tell the next
    // attempt.
    //
    // Deliberately NOT keyed on `status === 'contract_failed'`. A drift abort
    // maps to that same status (`errors.ts:133`) precisely so the crash-retry
    // path would not respawn a wandering child, and blanket-retrying the
    // status would reintroduce that bug from the other side. The gate is the
    // presence of scorer failures, which a drift abort never carries.
    const contractRetry = await this.retryOnContractFailure(
      opts,
      lastResult,
      noteFailure,
      // Everything the crash retry and the backup-model attempt already burned.
      // Seeding from the surviving attempt alone would let a contract retry
      // start against a pool three attempts have emptied.
      discardedTokens,
    );
    lastResult = contractRetry.result;
    discardedTokens += contractRetry.discardedTokens;

    // Carry the discarded attempts into the result the parent actually reads.
    // The answer may well be fine, so this does not change the status — but a
    // parent synthesizing against it, and a human reading the node row, must be
    // able to see that an earlier attempt failed rather than infer a clean run.
    if (lastResult && priorFailures.length > 0) {
      // "Recovered" only if it actually did. When the last attempt missed the
      // gate too, this note is read by the parent LLM verbatim beside a
      // `contract_failed` status — and telling it the child recovered when it
      // did not is precisely the self-report the gates exist to stop trusting.
      const recovered = lastResult.status === 'ok';
      const trail = recovered
        ? `Recovered after ${priorFailures.length} failed attempt(s): ${priorFailures.join(' | ')}`
        : `Still failing after ${priorFailures.length + 1} attempt(s): ${priorFailures.join(' | ')}`;
      lastResult.notes = lastResult.notes ? `${lastResult.notes}\n${trail}` : trail;
      coreLogger.warn(
        { parentNodeId: opts.parent.id, attempts: priorFailures.length, status: lastResult.status },
        'Swarm child needed more than one attempt — annotating result',
      );
    }
    if (lastResult && discardedTokens > 0) lastResult.discardedTokens = discardedTokens;
    return lastResult!;
  }

  /**
   * Re-dispatch a child whose scorer gate failed, with the failures quoted back
   * to it, until it passes or the bound is spent.
   *
   * The bound is `config.swarm.contractRetries` (default 1). This is the swarm's
   * counterpart to the pipeline's `qa_fail` backward edge, and it is bounded for
   * the same reason `validateGraph` refuses an unbounded cycle: without a
   * counter a child that cannot satisfy its contract runs until the token pool
   * is gone.
   *
   * Three guards decide whether a retry happens at all, and each one exists
   * because retrying without it is worse than surfacing the failure:
   *
   * 1. **Scorer failures must be present.** `contract_failed` is also the status
   *    of a drift abort, which must not be respawned (see the call site).
   * 2. **The feedback must be renderable.** A retry prompt that names no defect
   *    asks the child to guess; `renderContractFeedback` returns null and we
   *    stop instead.
   * 3. **The wall clock must not already be spent.** Each attempt is handed a
   *    fresh full wall cap because wall clock does not cascade, so without this
   *    a bounded token budget still permits an unbounded wait.
   * 4. **The attempts so far must leave room for another.** Counted from what
   *    the attempts actually reported, NOT from `budget.tokens.used`: a child's
   *    budget is derived fresh per spawn and its `used` stays 0 for the node's
   *    whole life (`deriveChildBudget`; only a PARENT's is reconciled, by
   *    `syncParentTokenUsage`). Reading it here would have been a guard that
   *    could never fire.
   *
   * A retry only ever replaces the result when it reached a verdict on the
   * contract — `ok`, or another `contract_failed`. An attempt that dies for an
   * unrelated reason (concurrency cap, a spawn that could not be recorded, a
   * provider fault) is discarded and the ORIGINAL diagnosis is returned:
   * `contract_failed` with the failed scorers on it tells the parent strictly
   * more than a null output does.
   */
  private async retryOnContractFailure(
    opts: Parameters<SwarmSpawner['runChildWithRetry']>[0],
    initial: ChildResult | null,
    noteFailure: (r: ChildResult) => void,
    alreadySpent = 0,
  ): Promise<{ result: ChildResult | null; discardedTokens: number }> {
    let result = initial;
    let discardedTokens = 0;
    let maxRetries = 1;
    try {
      maxRetries = getConfig().swarm?.contractRetries ?? 1;
    } catch {
      // Config not loaded (unit tests, early boot) — fall back to the schema
      // default rather than disabling the loop silently.
      maxRetries = 1;
    }
    if (maxRetries <= 0) return { result, discardedTokens };

    // What every attempt so far actually consumed. The child's own budget
    // object is not a running total (see the doc comment), so the loop keeps
    // its own.
    let spent = alreadySpent + (result?.usedTokens ?? 0);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (!result || result.status !== 'contract_failed') break;
      const failures = result.scorerOutcome?.failures ?? [];
      // Nothing is worth re-dispatching onto a cancelled run: the session is
      // gone, and a retry would create a fresh node, agent and model call for
      // work nobody is waiting for.
      if (opts.parent.signal?.aborted) {
        coreLogger.info(
          { parentNodeId: opts.parent.id },
          'Swarm child contract retry skipped — run was cancelled',
        );
        break;
      }

      // A failure the child has no power over — no shell tool, a denied
      // permission, a denylisted command, a missing workspace — is not
      // something a second run changes. Re-dispatching on one buys an
      // identical failure at the price of a full child run.
      if (failures.length > 0 && failures.every((f) => f.retryable === false)) {
        coreLogger.info(
          { parentNodeId: opts.parent.id, failures: failures.map((f) => f.scorer) },
          'Swarm child contract failure is not retryable — surfacing it as-is',
        );
        break;
      }
      const feedback = renderContractFeedback(failures, attempt, maxRetries);
      if (!feedback) break;

      const remaining = opts.budget.tokens.cap - spent;
      if (remaining < MIN_CHILD_TOKENS) {
        coreLogger.warn(
          { parentNodeId: opts.parent.id, remaining, spent, attempt },
          'Swarm child contract retry skipped — token pool exhausted',
        );
        break;
      }

      // Wall clock does NOT cascade — each attempt is handed a fresh full cap
      // (`deriveChildBudget`), so nothing else stops a sequence of retries from
      // running several times the child's wall budget. The parent is awaiting
      // this, and a caller that asked for one child should not wait an hour.
      const elapsed = Date.now() - opts.budget.wallClockMs.startedAt;
      if (elapsed >= opts.budget.wallClockMs.cap) {
        coreLogger.warn(
          { parentNodeId: opts.parent.id, elapsed, cap: opts.budget.wallClockMs.cap, attempt },
          'Swarm child contract retry skipped — wall-clock budget spent',
        );
        break;
      }

      coreLogger.info(
        {
          parentNodeId: opts.parent.id,
          attempt,
          maxRetries,
          failures: failures.map((f) => f.scorer),
        },
        'Swarm child failed its contract — re-dispatching with the failures quoted back',
      );

      // A fresh node, like the crash retry: the previous child's transcript is
      // the one that produced the rejected answer, and reusing it invites the
      // model to defend that answer rather than redo the work. The feedback
      // leads so it is read before the task it modifies.
      const retried = await this.singleSpawnAndRun(
        {
          ...opts,
          childMessage: `${feedback}\n\n${opts.childMessage}`,
          reason: 'retry',
        },
        true,
      );
      spent += retried.usedTokens ?? 0;

      if (retried.status !== 'ok' && retried.status !== 'contract_failed') {
        // Infrastructure failure, not a verdict. Keep the diagnosis we already
        // have and stop — another attempt would hit the same wall.
        coreLogger.warn(
          { parentNodeId: opts.parent.id, attempt, retryStatus: retried.status },
          'Swarm child contract retry failed for an unrelated reason — keeping the original contract failure',
        );
        discardedTokens += retried.usedTokens ?? 0;
        break;
      }

      // The superseded attempt is the one being thrown away now.
      noteFailure(result);
      discardedTokens += result.usedTokens ?? 0;
      result = retried;
    }
    return { result, discardedTokens };
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
    // A planned child is a mechanical executor — withhold the spawn/escalate/
    // collect meta-tools entirely so the "do not spawn" prompt line is backed by
    // tool-level enforcement, not just instruction-following (weak executor
    // models under-weight instructions). Tracking/persistence below key off
    // `childId`, not `childNode`, so a null childNode is safe here.
    if (opts.childDepth === 1 && !opts.brief.plan?.length) {
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
          createSpawnChildTool(
            childNode,
            this,
            {
              registerPending: (pc) => detachHookRef.current?.registerPendingChild(pc),
              pendingCount: () => detachHookRef.current?.pendingDetachedCount() ?? 0,
              maxPendingDetached: () => getLevelDefault(1).maxPendingDetached,
            },
            // This agent's own tier — it is the one choosing its subagent's role.
            { weakModel: opts.childIsSmall === true },
          ),
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
        // Forwarded by name, never as the parent's whole metadata object — the
        // same rule `pipelineMetadata` applies one level up, for the same
        // reason: that object also carries `isSystemUser` and `isAdmin`.
        //
        // `pipelineId`/`nodeKey` ride along so a stage that DELEGATES its
        // planning still reaches the pipeline. Without them `plan__add_items`
        // answered "Not running inside a pipeline" from inside a child, so a
        // `producesPlan` stage that spawned a planner produced no plan items and
        // the loop that reads them ran zero times — reading as success.
        contextMetadata: {
          originalRequest:
            ((opts.parentContext.metadata as Record<string, unknown>)?.originalRequest as string) ??
            opts.brief.originalUserRequest,
          ...pipelineMetadata(opts.parentContext.metadata as Record<string, unknown> | undefined),
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

    // ── The child's durable START bracket ────────────────────────────
    // Both writes below are recovery-bearing and neither is best-effort. The
    // node row is what cascade-cancel, the orphan reaper and the budget walk
    // resolve a running child through; the ledger `spawn` event is what replay
    // and the boot reconcile key off. Missing either one leaves a child that is
    // running and that nothing can account for or stop — so if the start cannot
    // be recorded, the child does not run.
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
        // Same predicate the model-routing block above uses (`hasPlan`), so the
        // recorded flag and the routing decision can never disagree.
        planned: !!opts.brief.plan?.length,
      });
      await getSwarmLedger().recordSpawn({
        rootSessionId: opts.parent.rootSessionId,
        nodeId: childId,
        parentNodeId: opts.parent.id,
        topicPath: opts.topicPath,
        role: opts.childRole,
        depth: opts.childDepth,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      coreLogger.error(
        { err, childId, parentNodeId: opts.parent.id },
        'Could not record the child spawn — aborting it rather than running it unrecorded',
      );
      agentManager.stop(childId, { cascade: true });
      // Undo every reservation the aborted child took, so a start we refused to
      // record costs the parent nothing:
      //  - the node row, if the first write landed and the second did not — it
      //    would otherwise sit `running` with no ledger event, visible only to
      //    the age-based reaper, which is the state this whole block prevents;
      //  - the call-graph fingerprint it owns, or the un-run brief stays
      //    deduped for the rest of the session and the retry is swallowed;
      //  - the fan-out slot reserved before the spawn.
      await swarmNodeRepository
        .cancelIfRunning(childId, 'spawn_not_recorded')
        .catch((cancelErr: unknown) =>
          coreLogger.error({ err: cancelErr, childId }, 'Failed to cancel the unrecorded child node row'),
        );
      graph.unregisterFingerprint(childId);
      opts.parent.budget.fanOut.used = Math.max(0, opts.parent.budget.fanOut.used - 1);
      return {
        // Empty, like every other pre-run failure: a child that never ran must
        // not reach the `if (result.nodeId)` sibling-scope block with an empty
        // report attributed to it.
        nodeId: '',
        kind: opts.childKind,
        // NOT `tool_error`: that status runs the crash + backup-model ladder,
        // which would spawn two more workers against the same broken write.
        status: 'denied',
        output: null,
        usedTokens: 0,
        durationMs: Date.now() - startTime,
        spawnedChildren: [],
        notes: `Spawn could not be recorded: ${msg}`,
      };
    }

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

    // Filesystem evidence, for the same reason the pipeline gate takes it: a
    // `minFilesChanged` scorer reads `SideEffectCounters.filesChanged`, which
    // counts only FILE_CHANGE_TOOLS and is blind to anything written through
    // `shell__run`. Only walked when a scorer actually asks about files —
    // otherwise this is pure cost on every spawn.
    const wantsFileEvidence =
      opts.brief.expectedOutput?.shape === 'code-diff' ||
      (opts.scorers ?? []).some((s) => s.kind === 'side_effect' && s.minFilesChanged !== undefined);
    // `forAgent`, matching the `file_exists` scorer's own resolution, so both
    // file-aware scorers judge the same directory.
    const scorerWorkspaceRoot = wantsFileEvidence
      ? WorkspaceFS.forAgent({ userId: opts.parentContext.userId }).root
      : null;
    const fsBefore = scorerWorkspaceRoot ? await snapshotWorkspace(scorerWorkspaceRoot) : null;

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
    // Enforce a declared expectedOutput.schema as an implicit output gate
    // (Phase B1), in addition to any scorers the parent attached explicitly.
    // Only for shape=json — a schema on a markdown/summary deliverable is not a
    // JSON contract and must not flip a correct non-JSON result to failed.
    // A declared `code-diff` deliverable additionally gates on the RECEIPT: the
    // parent said the deliverable is a change to the tree, so an `ok` child whose
    // execution record shows zero files changed missed the contract regardless of
    // how the prose reads. Evidence over narration.
    const eo = opts.brief.expectedOutput;
    const schemaScorer = eo?.shape === 'json' ? deriveSchemaScorer(eo.schema) : null;
    const codeDiffScorer = deriveCodeDiffScorer(eo?.shape);
    const effectiveScorers: Scorer[] = [
      ...(schemaScorer ? [schemaScorer] : []),
      ...(codeDiffScorer ? [codeDiffScorer] : []),
      // Always on: a child whose every tool call failed answered from memory,
      // and `ok` would hide a total tool outage behind confident prose.
      deriveToolOutageScorer(),
      ...(opts.scorers ?? []),
    ];
    if (status === 'ok' && effectiveScorers.length > 0) {
      const filesTouched = scorerWorkspaceRoot
        // `countPackages` because this diff IS the file evidence: a child asked
        // for a `code-diff`, or scored on `minFilesChanged`, may well have a
        // built wheel or sdist as its deliverable, and skipping it measures
        // zero files and fails the child for producing nothing.
        ? countChangedFiles(fsBefore, await snapshotWorkspace(scorerWorkspaceRoot), { countPackages: true })
        : null;
      const outcome = await runScorers(
        effectiveScorers,
        { output: result.output, notes: result.notes, receipt: result.receipt },
        buildScorerContext({
          userId: opts.parentContext.userId,
          filesTouched,
          childTools: opts.childTools,
          childRole: opts.childRole,
          signal: opts.parent.signal,
        }),
      );
      result.scorerOutcome = outcome;
      if (outcome.notEvaluated) {
        // Nothing judged the work, so nothing may be claimed about it in either
        // direction. Recorded on the notes so a reader does not mistake the
        // absent verdict for a clean one.
        notes = notes
          ? `${notes}\nScorer gate not evaluated: ${outcome.notEvaluated}`
          : `Scorer gate not evaluated: ${outcome.notEvaluated}`;
        result.notes = notes;
        coreLogger.info(
          { parentNodeId: opts.parent.id, childId, reason: outcome.notEvaluated },
          'Swarm scorer gate not evaluated — leaving the child status untouched',
        );
      } else if (!outcome.passed) {
        const summary = outcome.failures.map((f) => `${f.scorer}: ${f.reason}`).join('; ');
        status = 'contract_failed';
        result.status = 'contract_failed';
        // Keep the receipt's own status in step — it is snapshotted before the
        // gates run, and a receipt that still says `ok` next to a
        // `contract_failed` envelope is exactly the kind of contradiction the
        // receipt exists to prevent.
        if (result.receipt) result.receipt = { ...result.receipt, status: 'contract_failed' };
        notes = notes ? `${notes}\nScorer gate failed: ${summary}` : `Scorer gate failed: ${summary}`;
        result.notes = notes;
        coreLogger.info(
          { parentNodeId: opts.parent.id, childId, failures: outcome.failures.length },
          'Swarm child failed scorer gate — marking contract_failed',
        );
      }

      // Record the verdict in the evidence ledger. Until now only
      // `pipeline-manager.ts` wrote to `verification_evidence`, so every swarm
      // gate — including the always-on tool-outage one — passed or failed
      // without leaving a queryable trace, and `deliveredPct` in
      // `scripts/quality-score.ts` could only ever see pipeline runs. One table
      // now means one thing: every gated deliverable, whoever gated it.
      //
      // Best-effort, exactly like the pipeline's own write: a ledger failure
      // must never turn a good child into a failed one.
      // A gate that never ran is not a passing verification. Writing
      // `passed: outcome.passed` — true on the not-evaluated path — would put a
      // green row in the ledger `scripts/quality-score.ts` reads for
      // `deliveredPct`: a measurement of nothing, counted as a success.
      try {
        if (outcome.notEvaluated) {
          coreLogger.info(
            { parentNodeId: opts.parent.id, childId, reason: outcome.notEvaluated },
            'Skipping verification evidence — the gate was never evaluated',
          );
        } else {
        await verificationEvidenceRepository.record({
          sessionId: opts.parent.rootSessionId,
          nodeId: childId,
          stage: opts.childRole,
          kind: 'side_effect',
          passed: outcome.passed,
          detail: {
            scorers: effectiveScorers.length,
            failures: outcome.failures.map((f) => ({ scorer: f.scorer, reason: f.reason })),
          },
        });
        }
      } catch (err) {
        coreLogger.warn(
          { err: (err as Error).message, childId },
          'Failed to record swarm scorer verification evidence',
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

    // The node is done, so it can never warn again — drop its bookkeeping.
    this.budgetWarned.delete(childId);

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

  private resolveChildRole(params: SpawnChildParams, orchestratorIsLite = false): AgentRole {
    // Validator in swarm-tool.ts guarantees role is set — it rejects
    // spawns missing a resolvable role. Silent defaulting to 'general'
    // was the source of wrong-model routing.
    if (!params.role) {
      throw new Error(
        'SpawnChildParams.role is required — validator must have populated it before reaching the spawner',
      );
    }
    // Phase 2.6 — deterministic role-fit: an advisory role picked for a task
    // the classifier reads as coding is a misroute (an "architect" doing code
    // changes). Rewrite to `coding` and log.
    //
    // LITE orchestrators only, which is what it was written for: prompt hints
    // don't hold for them. A capable (full) model read the whole request before
    // choosing, so overriding it with a keyword table's read of the task brief
    // alone replaces judgement with a guess.
    //
    // Lite, specifically, and not "small": the two used to be different tiers
    // and the rewrite was gated on the wrong one — a router-tier root never
    // reached this method at all. Router mode is gone (Phase 9); every small
    // model now resolves to lite, so this reads as the tier it always meant.
    const fit = applyRoleFit(params.role, params.taskBrief, orchestratorIsLite);
    if (fit.rewrittenFrom) {
      coreLogger.info(
        { from: fit.rewrittenFrom, to: fit.role, taskBrief: params.taskBrief.slice(0, 120) },
        'Role-fit rewrite: advisory role chosen for a coding task',
      );
    }
    return fit.role;
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
    /** Whether this child is equipped with tools — gates the tool-support reroute. */
    childUsesTools = false,
    /**
     * Whether the parent supplied an explicit execution plan. Only a planned
     * child binds to the lane's `executorModel` (the cheap mechanical
     * executor); a plan-less child uses its own judgment on the primary model.
     */
    hasPlan = false,
  ): Promise<{ model: string; lane: string; expertId?: string; systemPrompt?: string; isSmall: boolean }> {
    const registry = getModelRegistry();

    let expertModel: string | undefined;
    let expertId: string | undefined;
    /** The expert's assigned model lane (experts.topic) — overrides childRole for model resolution. */
    let expertLane: string | undefined;
    let systemPrompt: string | undefined;
    let expertSkillIds: string[] = [];
    let expertCriticalRules: string[] = [];
    try {
      const { getDb } = await import('@/db/postgres');
      const { experts } = await import('@/db/schema/experts');
      const { eq, and, ne } = await import('drizzle-orm');
      const db = getDb();

      let rows: Array<{
        id: string;
        name: string;
        topic: string | null;
        modelPreference: string | null;
        systemPrompt: string | null;
        skillIds: unknown;
        criticalRules: unknown;
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
        expertLane = expert.topic || undefined;
        systemPrompt = expert.systemPrompt || undefined;
        expertSkillIds = Array.isArray(expert.skillIds) ? (expert.skillIds as string[]) : [];
        expertCriticalRules = Array.isArray(expert.criticalRules) ? (expert.criticalRules as string[]) : [];
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
        // Index-only injection (matches the orchestrator's spawnWorker path):
        // one line per skill, not the full body. A multi-skill expert otherwise
        // dumps tens of k tokens into every child prompt — bloat a fan-out child
        // can't use, and which actively skews small models (see the 743d4b66
        // post-mortem). The child loads full content on demand via the global
        // `get_skill` tool registered on every worker.
        const fragment = await skillReg.buildPromptSummary(expertSkillIds);
        if (fragment) skillFragments.push(`# Domain Knowledge (expert index)\n${fragment}`);
      }

      // Topic-assigned skills: skills assigned to the child's role/topic
      // via skill_topic_assignments. No assertion — the user may or may not
      // have assigned any; it's not a bug if none are configured.
      const { discoverSkillIds } = await import('@/skills/discovery');
      const discoveredRaw = await discoverSkillIds({
        topic: childRole,
        message: childMessage,
      });
      // Dedup against the expert's own skills — otherwise the same skill's
      // domain-knowledge block is injected twice (once as "expert", once as
      // "topic"), doubling its weight in a small model's attention. For a 9B
      // model this is how "technical-writing" ended up dominating a football
      // question badly enough to produce ai-docs/ spam.
      const expertSkillSet = new Set(expertSkillIds);
      const discoveredIds = discoveredRaw.filter((id) => !expertSkillSet.has(id));
      const topicFragment = discoveredIds.length > 0
        ? await skillReg.buildPromptSummary(discoveredIds)
        : '';
      if (topicFragment) skillFragments.push(`# Domain Knowledge (topic index)\n${topicFragment}`);
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

    // NOTE: the system prompt is assembled AFTER model resolution (below), because
    // the role-template choice depends on the resolved model's tier — a small model
    // gets the lite template. Everything gathered above (expert prompt, critical
    // rules, skill fragments) is held until then.

    // Model selection — in order of preference:
    //   1. lane executorModel (W9 planner→executor split) — ONLY when the
    //      parent supplied a `plan` (hasPlan). A plan is the parent saying "I've
    //      done the thinking; run these steps mechanically", so it binds to the
    //      lane's cheap executor. This outranks modelPreference *on a planned
    //      spawn only*: the preference picks a model to think with, and the
    //      plan is what removes the thinking. A plan-less child skips this
    //      branch entirely → expert preference, then primary.
    //   2. expert.modelPreference (specialist's explicit choice) — authoritative
    //      for every plan-less (recon/judgment) delegation.
    //   3. lane→model mapping (topic primary binding)
    //   4. fail loud — do NOT inherit parent model. The parent's model is
    //      whatever the orchestrator happened to pick; it has no claim to
    //      being right for the child's topic. Inheriting hides routing bugs.
    //
    // The lane is the expert's assigned topic (experts.topic) when an expert
    // matched, else the child role — which canonicalizes via RETIRED_TOPIC_ALIASES
    // to the 'agents' lane (or 'writing' for the long-form text roles:
    // research/communication/pm/writing).
    const lane = expertLane || childRole;
    let candidate = expertModel;
    // One lookup for the whole routing block — getTopicConfig is an in-memory
    // cache, but the branches below reference the executor binding repeatedly
    // and must all agree on the same value.
    const laneExecutor = getTopicConfig(lane).executorModel;
    if (candidate && hasPlan && laneExecutor) {
      // A plan says the parent has already done the judgment and wants the
      // steps run mechanically. `modelPreference` answers a different question
      // — which model this specialist should THINK with — and that question is
      // moot once a checklist replaces the thinking. So on a planned spawn the
      // lane's executor wins; the expert still contributes its prompt, skills
      // and tools, only the model changes.
      //
      // This used to go the other way, which made the saving unreachable in
      // practice: on this install 9 of 16 experts carry a modelPreference and
      // ALL of them sit on the `agents` lane, the alias target for every
      // hands-on role (general, coding, review, devops, qa, …). A measured
      // planned run spent 101,546 tokens, 100% of them on the full-price
      // planner, with the configured executor untouched.
      //
      // The escape hatch is per-lane and deliberate: a lane whose work needs a
      // capable model regardless simply leaves `executorModel` empty, which
      // skips this branch entirely (planner == executor).
      coreLogger.info(
        { lane, childRole, expertModel: candidate, executorModel: laneExecutor },
        'Planned child: lane executorModel overrides expert modelPreference (mechanical execution)',
      );
      candidate = undefined;
    }
    if (!candidate && hasPlan) {
      // No plan ⇒ this whole block is skipped and the child resolves to the
      // lane's primary (recon/judgment). Empty executorModel ⇒ also skipped
      // (planner == executor). A misconfigured executorModel only fails loud
      // when a plan actually needs the executor.
      const executorName = laneExecutor;
      if (executorName) {
        const execModel =
          (await registry.getModel(executorName)) || (await registry.getModelByModelId(executorName));
        if (!execModel) {
          throw new Error(
            `Topic '${lane}' has executorModel '${executorName}' but no such model is registered. ` +
              `Fix it on the Topics page or clear the executor binding.`,
          );
        }
        candidate = execModel.modelId;
        coreLogger.info(
          { lane, childRole, executorModel: candidate },
          'Planned child routed to the lane executorModel (cheap executor path)',
        );
      }
    } else if (!candidate && !hasPlan && laneExecutor) {
      // Breadcrumb: this lane HAS an executorModel but the child arrived without
      // a plan, so we deliberately skip it and use the primary (recon path). Log
      // it at info so a configured-but-never-exercised executor — or a typo that
      // only a planned spawn would surface — is visible to operators without
      // debug logging. Paired with the `planned` label on
      // octipus_swarm_spawns_total, this makes "executor never used" measurable.
      coreLogger.info(
        { lane, childRole, executorModel: laneExecutor },
        'Plan-less child: skipping configured executorModel, resolving topic primary (recon path)',
      );
    }
    if (!candidate) {
      const topicModel = await registry.getModelForTopic(lane);
      candidate = topicModel?.modelId;
    }
    if (!candidate) {
      throw new Error(
        `No model bound to topic '${lane}'. ` +
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

    // Capability gate (RC7): the worker path checks a bound model can actually
    // do the work; the swarm path never did. Warn on a weak model, and reroute
    // ONLY when the child is equipped with tools but its model can't call them —
    // a genuine mismatch, not a preference override. A tool-less child (pure
    // synthesis) keeps its bound model even if that model reports no tool
    // support. Never blocks the spawn.
    //
    // The small-model tier is derived in the same block: it needs the same
    // lookup, and it must reflect the model we ACTUALLY bound — i.e. after any
    // reroute above, not the original candidate.
    let isSmall = false;
    try {
      const routerMax = getConfig().orchestrator.routerSmallModelMaxParams;
      let bound = await registry.getModelByModelId(candidate);
      if (bound) {
        const { staticCapabilityWarnings } = await import('@/models/capability-gate');
        const warnings = staticCapabilityWarnings(bound, routerMax);
        if (warnings.length > 0) {
          coreLogger.warn({ childRole, model: candidate, warnings }, 'Swarm child bound to a weak model');
        }
        if (childUsesTools && !bound.supportsTools && bound.provider !== 'cli') {
          const { findToolCapableFallback } = await import('@/core/orchestrator/model-selector');
          const alt = await findToolCapableFallback(candidate);
          if (alt) {
            coreLogger.warn(
              { childRole, from: candidate, to: alt.model, reason: alt.reason },
              'Swarm child has tools but its model lacks tool support — rerouting to a tool-capable local model',
            );
            candidate = alt.model;
            // Re-fetch: the tier below must describe the rerouted model.
            bound = await registry.getModelByModelId(candidate);
          } else {
            coreLogger.warn(
              { childRole, model: candidate },
              'Swarm child has tools but its model lacks tool support, and no tool-capable fallback exists — proceeding anyway',
            );
          }
        }
      }
      // The worker path has adapted to weak models since Phase C (lite role
      // prompts, tool cap); the swarm path never did — so a swarm child on a 9B
      // model got the FULL role prompt, which is the population the 743d4b66
      // post-mortem is about. Mirrors `worker-spawner.ts:146`.
      isSmall = isSmallModel({ modelId: candidate, metadata: bound?.metadata }, routerMax);
    } catch (err) {
      // Best-effort gate — a lookup failure must not block a spawn. Unknown
      // tier ⇒ full surface: we only ever *reduce* capability when we're
      // confident the model is small (same policy as isSmallModel).
      coreLogger.debug({ err, childRole, model: candidate }, 'Swarm capability gate skipped');
    }

    // ── System prompt assembly (needs the tier, hence its position) ──
    // Role-prompt fallback: seeded experts have `systemPrompt = null`, so without
    // this the child's ENTIRE system prompt was just the injected skill blocks —
    // no role identity, no security preamble, no honesty/stopping rules. That is
    // the direct cause of a research child that forgot it was doing research. Use
    // the same base the worker-spawner path uses: expert prompt if present, else
    // the role's template (which carries SECURITY_PREAMBLE + the good research
    // prompt.md with its HONESTY section), lite variant for a small model.
    if (!systemPrompt) {
      const roleConfig = getRoleConfig(childRole);
      systemPrompt = (isSmall && roleConfig.liteSystemPromptTemplate) || roleConfig.systemPromptTemplate;
    }

    // Expert critical rules — injected on the worker path but previously dropped
    // on the swarm path (the Researcher expert's "always cite / distinguish fact
    // from speculation" rules never reached the child).
    systemPrompt += formatCriticalRules(expertCriticalRules);

    if (skillFragments.length > 0) {
      systemPrompt = `${systemPrompt}\n\n${skillFragments.join('\n\n')}`.trim();
    }

    return { model: candidate, lane, expertId, systemPrompt, isSmall };
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
/**
 * Cross-check a plan's named tools against the child's actual toolset.
 *   - `missingTools`: distinct named tools the child does not hold.
 *   - `unrunnable`: the plan names ≥1 tool AND every tool-bearing step names a
 *     missing one — nothing the plan wants to do is possible, so the parent
 *     should re-plan rather than spawn a doomed child.
 * A plan-step with no `tool` never counts as missing (the executor picks).
 */
export function planToolGaps(
  plan: PlanStep[],
  availableToolNames: string[],
): { missingTools: string[]; unrunnable: boolean } {
  const availSet = new Set(availableToolNames);
  const stepsWithTool = plan.filter((s) => s.tool);
  const missing = stepsWithTool.filter((s) => !availSet.has(s.tool as string));
  const missingTools = [...new Set(missing.map((s) => s.tool as string))];
  const unrunnable = stepsWithTool.length > 0 && missing.length === stepsWithTool.length;
  return { missingTools, unrunnable };
}

/**
 * The `ScorerContext` a spawned child's gates run under.
 *
 * Extracted and exported because every field here is one a hand-written test
 * gets right and production got wrong. `role` was absent on the real path while
 * every scorer test supplied it, and `canPromptHuman` reads an ABSENT role as
 * "can ask a human" — which routed the default ASK level on `shell.execute` to
 * `ask_human` and made every `command_exit_zero` gate refuse, non-retryably, on
 * a stock install. The same shape as the unreachable gates the rebuild plan
 * lists: the guard was correct, the shipping path never met it.
 */
export function buildScorerContext(args: {
  userId?: string;
  filesTouched: number | null;
  childTools: ToolHandler[];
  childRole: AgentRole;
  signal?: AbortSignal;
}): ScorerContext {
  return {
    userId: args.userId,
    filesTouched: args.filesTouched,
    // Read from the RESOLVED toolset, not the role name: that is what the child
    // actually got after the parent-intersection and the small-model cap.
    canRunCommands: args.childTools.some((t) => t.toolId === 'shell' || t.name.startsWith('shell__')),
    role: args.childRole,
    // So a command check dies with a cancelled run rather than outliving it
    // with the awaited spawn still pending.
    signal: args.signal,
  };
}

export function composeChildMessage(
  brief: TaskBrief,
  opts: { availableToolNames: string[]; canSpawnChildren: boolean; executorModel?: string },
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

  // Explicit execution plan (planner→executor split): the parent already did
  // the thinking and handed down ordered steps. Render them as a mechanical
  // checklist so a cheap executor model runs them instead of re-deriving its
  // own strategy. Steps are 1-indexed so "STOP at step N" is unambiguous.
  if (brief.plan?.length) {
    const availSet = new Set(opts.availableToolNames);
    const steps = brief.plan
      .map((s, i) => {
        // A tool the child doesn't actually hold is marked so the mechanical
        // executor does the step with the tools it has instead of calling a
        // missing tool and tripping the STOP-on-failure rule. (Spawn-time
        // validation already denied a plan whose every tool is unavailable.)
        const tool = s.tool
          ? availSet.has(s.tool)
            ? ` [tool: ${s.tool}]`
            : ` [tool: ${s.tool} — NOT available to you; use the tools you have for this step]`
          : '';
        const expect = s.expect ? ` → expect: ${s.expect}` : '';
        return `${i + 1}. ${s.action}${tool}${expect}`;
      })
      .join('\n');
    parts.push(
      'EXECUTION PLAN — run these steps IN ORDER. Do not deviate, reorder, or ' +
        'add steps. Use the named tool at each step where one is given.\n' +
        `${steps}\n` +
        'If a step fails, STOP and report which step number failed and why — do ' +
        'not improvise a workaround.',
    );
  }

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

  // Delegation guidance for depth-1 Agents is STATIC and now lives in the
  // child's (cacheable) system prompt (see buildDelegationGuidance / the spawn
  // path), not re-sent in full per brief. A compact reminder stays in the
  // trailing (high-salience) user message so weak models — which under-weight
  // system instructions — still act on the fan-out/collect rules at decision
  // time. Leaf subagents get the no-delegation line instead.
  if (brief.plan?.length) {
    // A planned child is a mechanical executor — following the plan IS the job,
    // so don't invite it to delegate (spawning would be "deviating"). Overrides
    // the delegation reminder even at depth 1.
    parts.push(
      'Follow the EXECUTION PLAN above exactly and return the deliverable. Do ' +
        'not spawn children or add steps of your own.',
    );
  } else if (opts.canSpawnChildren) {
    parts.push(
      'REMINDER: you can `spawn_child` to run 2+ INDEPENDENT units of work in ' +
        'parallel (the full delegation policy + mechanics are in your ' +
        'instructions above). First check if your own tools suffice — if so, ' +
        'do it yourself. If you spawn, call `collect_children` BEFORE your ' +
        'final answer.',
    );
    // Executor-awareness: this topic has a cheap executor model bound. For
    // mechanical, fully-specified sub-work, the agent should do the thinking
    // itself and hand a step-by-step `plan` to spawn_child — that routes the
    // child to the cheap executor instead of a full-price specialist. Only
    // injected when the lane actually has an executor (else it's noise).
    if (opts.executorModel) {
      parts.push(
        'EXECUTOR AVAILABLE: this topic has a cheap executor model for mechanical ' +
          'work. When a sub-task is well-defined and does NOT need judgment (e.g. ' +
          'run these searches, fetch these pages, apply these edits), do the ' +
          'thinking yourself and pass a `plan` to `spawn_child` — an ordered list ' +
          'of {"action","tool"(optional),"expect"(optional)} steps. A child spawned ' +
          'WITH a plan runs mechanically on the cheap executor; a child spawned ' +
          'WITHOUT a plan uses a full specialist that re-derives its own strategy. ' +
          'Reserve plan-less delegation for sub-tasks that genuinely need judgment.',
      );
    }
  } else {
    parts.push(
      'You are a leaf subagent: no further delegation. Solve the task with ' +
        'your own tools and return the deliverable.',
    );
  }

  const eo = brief.expectedOutput;
  if (eo.shape === 'json' && eo.schema) {
    // shape=json + schema (Phase B1): the child's ENTIRE reply must be one JSON
    // object matching it — a shape gate validates this on return and fails loud
    // (contract_failed) otherwise. Only for shape=json: a schema attached to a
    // markdown/summary deliverable does NOT override the declared shape.
    parts.push(
      `Expected output: return ONLY a single JSON object that conforms to this JSON Schema ` +
        `(every "required" key MUST be present):\n` +
        `${JSON.stringify(eo.schema)}\n` +
        `(max ${eo.maxTokens} tokens). Your entire reply must be that JSON object.`,
    );
  } else {
    parts.push(
      `Expected output: ${eo.shape} ` +
        `(max ${eo.maxTokens} tokens). ` +
        `Return only the deliverable — no preamble.`,
    );
  }

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
