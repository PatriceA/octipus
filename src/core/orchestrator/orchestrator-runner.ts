import { resolve } from 'path';
import { getConfig } from '@/config';
import { getAgentManager } from '@/core/agent-manager';
import { humanizeProviderError } from '@/core/errors/humanize';
import { isCancellationError } from '@/core/swarm/errors';
import { swarmNodeRepository } from '@/core/swarm/node-repository';
import { taskFingerprint } from '@/core/swarm/spawner';
import type { AgentWorker } from '@/core/agent-worker';
import { type AgentNode, LEVEL_DEFAULT, type PendingChild } from '@/core/swarm/types';
import { WorkspaceFS } from '@/security/workspace-fs';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { SessionContext } from '@/db/schema/sessions';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { getOrchestratorHooks } from './hooks';
import { buildSecurityReminder } from './input-guard';
import { createMetaTools } from './meta-tools';
import type { ModelSelector } from './model-selector';
import { resolveOrchestratorMode } from './mode-selector';
import { runRouterTurn } from './router-turn';
import { buildOutputDirective } from './output-directive';
import { getLiteOrchestratorPrompt, getRoleConfig } from './roles';
import type { OrchestratorEvent, OrchestratorService } from './service';
import type { MessageClassification } from './types';

/** Dependency bundle the runner needs from OrchestratorService. */
export interface OrchestratorRunnerDeps {
  modelSelector: ModelSelector;
  emit: (event: OrchestratorEvent) => void;
  setLastWorkerResult: (result: string | null) => void;
  getLastWorkerResult: () => string | null;
}

/**
 * Build, spawn, and run the orchestrator agent for a single turn — the swarm
 * root that plans the turn by delegating to specialists via its spawn_child /
 * create_pipeline meta-tools. Extracted verbatim from OrchestratorService so
 * the service stays a thin façade; behaviour is identical.
 */
export async function runOrchestrator(
  service: OrchestratorService,
  deps: OrchestratorRunnerDeps,
  sessionId: string,
  userId: string,
  message: string,
  classification: MessageClassification,
  guardFlags: string[] = [],
  channel?: string,
  /**
   * Memory-redesign Phase D — appended to the orchestrator's system
   * prompt. Pre-rendered by `handleMessage` once per turn so both
   * the orchestrator and the directResponse path see the same
   * long-term memory block.
   */
  extraSystemContext: string = '',
  /** Workspace scope inherited by every spawned child. */
  workspaceId: string | null = null,
  /** Chat/work split (Thread 3): inline vs file deliverable directive. */
  outputDirective: { mode: 'inline' | 'file'; forced: boolean } = { mode: 'inline', forced: false },
): Promise<{ response: string; agentId: string; sources: string[] }> {
  const emit = deps.emit;
  const agentManager = getAgentManager();
  const modelName = await deps.modelSelector.selectForOrchestration(sessionId);

  // Resolve the orchestrator mode for THIS turn. 'auto' (default) re-derives
  // from the current default model's size every turn, so swapping to a
  // smaller model switches the orchestrator to lite/router with no restart.
  // router short-circuits below to a deterministic single-worker turn; lite
  // shrinks the prompt/tools/iterations further down; full is unchanged.
  const orchCfg = getConfig().orchestrator;
  const modelMeta = await getModelRegistry().getModelByModelId(modelName);
  const orchestratorMode = resolveOrchestratorMode(
    { modelId: modelName, metadata: modelMeta?.metadata, provider: modelMeta?.provider },
    {
      mode: orchCfg.mode,
      routerSmallModelMaxParams: orchCfg.routerSmallModelMaxParams,
      liteModelMaxParams: orchCfg.liteModelMaxParams,
    },
  );
  coreLogger.info({ sessionId, modelName, orchestratorMode }, 'Orchestrator mode resolved');

  // Router mode: no orchestrator LLM — classify → one specialist → relay.
  // The small local model only runs as a single role-scoped worker.
  if (orchestratorMode === 'router') {
    return runRouterTurn(sessionId, userId, message, classification, deps, {
      workspaceId,
      extraSystemContext,
      guardFlags,
      outputDirective,
    });
  }

  const orchestratorConfig = getRoleConfig('orchestrator');

  // Build the swarm root node AgentNode up front so meta-tools can bind to
  // it. The actual DB row is written once we know the agentId (post-spawn).
  // The orchestrator's allowed tool ids is the superset of its role's tools
  // plus the meta-tools it owns.
  const orchestratorAbortController = new AbortController();
  const orchestratorAllowedToolIds = new Set<string>();
  // Meta-tool ids that the orchestrator owns by construction.
  for (const name of ['spawn_child', 'collect_children', 'create_pipeline', 'list_pipeline_templates', 'filter_pii', 'request_user_approval', 'send_status_update', 'remember_this', 'remember_about_self', 'reflect']) {
    orchestratorAllowedToolIds.add(name);
  }
  // Role-defined tool ids (if any): orchestrator role uses meta-tools only.
  for (const id of orchestratorConfig.toolIds) orchestratorAllowedToolIds.add(id);
  // Superset: orchestrator is the root of every swarm branch and must be
  // able to grant any specialist role's tools to its children via
  // intersection. Without this, e.g. the `general` role's `profiles` tool
  // would be stripped out because the orchestrator itself never lists it.
  const { ROLE_CONFIGS } = await import('./roles');
  for (const cfg of Object.values(ROLE_CONFIGS)) {
    for (const id of cfg.toolIds) orchestratorAllowedToolIds.add(id);
  }

  // Parent AgentNode for the swarm. `id` is a placeholder — overwritten
  // once we know the real agentId post-spawn. `spawn_child` closes over
  // `parentNode` by reference, so the mutation is observed.
  const parentNode: AgentNode = {
    id: '__pending__',
    rootSessionId: sessionId,
    parentNodeId: null,
    kind: 'orchestrator',
    depth: 0,
    role: 'orchestrator',
    topicPath: 'root',
    model: modelName,
    budget: {
      tokens: { cap: LEVEL_DEFAULT[0].tokens, used: 0 },
      wallClockMs: { cap: LEVEL_DEFAULT[0].wallMs, startedAt: Date.now() },
      fanOut: { cap: LEVEL_DEFAULT[0].fanOut, used: 0 },
      depth: 0,
    },
    allowedToolIds: orchestratorAllowedToolIds,
    signal: orchestratorAbortController.signal,
  };

  // Late-bound worker handles for detach-mode `spawn_child` +
  // `collect_children`. The orchestrator's AgentWorker is created below
  // by `agentManager.spawn(...)`; both refs are populated once it
  // returns. Tool executes run inside `worker.run(...)` AFTER this
  // wiring, so a stray null on these refs would be a bug in the spawn
  // path, not a race.
  const orchestratorDetachHookRef: {
    current: {
      registerPendingChild: (pc: PendingChild) => void;
      pendingDetachedCount: () => number;
    } | null;
  } = { current: null };
  const orchestratorWorkerRef: { current: AgentWorker | null } = { current: null };

  const isLite = orchestratorMode === 'lite';
  const metaTools = createMetaTools(service, {
    parentNode,
    swarmRefs: {
      detachHookRef: orchestratorDetachHookRef,
      workerRef: orchestratorWorkerRef,
    },
    lite: isLite,
  });

  let systemPrompt = isLite ? getLiteOrchestratorPrompt() : orchestratorConfig.systemPromptTemplate;
  if (guardFlags.length > 0) {
    systemPrompt += buildSecurityReminder(guardFlags);
  }
  if (extraSystemContext) {
    systemPrompt += extraSystemContext;
  }

  // Anchor the orchestrator in real wall-clock time. Without this stamp the
  // model has no notion of "now" and treats fresh worker output — today's
  // scores, "yesterday"/"tomorrow" events, anything past its training cutoff —
  // as hallucinated future data, then discards correct results. Surface the
  // real date so it trusts what the arms return instead of second-guessing it.
  // Stable-prefix ordering (Phase 2a): volatile per-turn blocks (date, session
  // summary, recent history) are collected and appended LAST so the static
  // instruction prefix (base + persona/hook + classification + expert index +
  // workspace) stays cache-stable across turns. The date busted the cache every
  // turn when injected here mid-prompt.
  const nowStamp = new Date();
  const volatileParts: string[] = [
    `\n\nCURRENT DATE & TIME: ${nowStamp.toUTCString()} (ISO ${nowStamp.toISOString()}). This is the real wall-clock time, authoritative over your training cutoff. Worker/tool results carrying dates at or before this are plausible by definition — do NOT dismiss them as hallucination merely because they are newer than what you remember. Events "yesterday"/"today"/"tomorrow" are relative to this timestamp.`,
  ];

  // Fire the before-agent-start hook so extensions and built-in
  // modules (persona, project context) can mutate the system
  // prompt before the orchestrator LLM call. Subscribers run
  // sequentially; thrown handlers are logged and swallowed.
  const hookCtx = await getOrchestratorHooks().fire('before-agent-start', {
    role: 'orchestrator',
    userId,
    sessionId,
    workspaceId,
    channel,
    systemPrompt,
  });
  systemPrompt = hookCtx.systemPrompt;

  const session = await sessionRepository.findById(sessionId);
  const sessionCtxData = session?.context as SessionContext | undefined;
  const clearedAt = sessionCtxData?.clearedAt ? new Date(sessionCtxData.clearedAt) : undefined;
  // Pull session summary from the append-only `compaction_entries`
  // log (newest row). Falls back to the legacy `context.compactedSummary`
  // for sessions compacted before the dual-write removal so old data
  // doesn't lose its summary mid-rollout.
  let sessionSummary: string | undefined;
  if (!clearedAt) {
    try {
      const { compactionEntryRepository } = await import('@/db/repositories/compaction-entry-repository');
      const latest = await compactionEntryRepository.findLatest(sessionId);
      sessionSummary = latest?.summary ?? sessionCtxData?.compactedSummary;
    } catch (err) {
      coreLogger.debug({ err, sessionId }, 'compaction-entry lookup failed — falling back to legacy context');
      sessionSummary = sessionCtxData?.compactedSummary;
    }
  }
  const sources: string[] = [];
  if (sessionSummary) {
    volatileParts.push(`\n\nPrevious conversation summary:\n${sessionSummary}`);
    sources.push('session summary');
  }

  // Load recent conversation history so the orchestrator can reference prior messages
  const recentHistory = await messageRepository.findRecentBySession(sessionId, 10, ['user', 'assistant'], clearedAt);
  if (recentHistory.length > 0) {
    sources.push(`recent ${recentHistory.length} msg${recentHistory.length === 1 ? '' : 's'}`);
  }
  if (classification.topic) {
    sources.push(`classifier(${classification.topic})`);
  }
  if (recentHistory.length > 0) {
    const historyLines = recentHistory.map(m =>
      `[${m.role}]: ${m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content}`
    );
    volatileParts.push(`\n\nRecent conversation history (last ${recentHistory.length} messages):\n${historyLines.join('\n\n')}`);
  }

  if (classification.topic) {
    // Lite mode gets a contradiction-free version: the lite prompt says
    // "Delegate ONCE per request", so this appendix must NOT say "one or more
    // calls per turn" (small models are literal — that conflict is what drove
    // the rule-breaking second spawn in run 743d4b66) and must NOT advertise
    // create_pipeline, which the lite spawn schema doesn't expose.
    systemPrompt += isLite
      ? `\n\nThe user's message has been pre-classified as a "${classification.topic}" topic (confidence: ${classification.confidence.toFixed(2)}). Use this as the child role. For any substantive task, call spawn_child EXACTLY ONCE and then relay the child's result. Only answer directly (no spawn) for a greeting, arithmetic, a single-fact answer, repeat-after-me, or a simple definition. When in doubt, delegate.`
      : `\n\nThe user's message has been pre-classified as a "${classification.topic}" topic (confidence: ${classification.confidence.toFixed(2)}). Use this as the child role when calling spawn_child. Delegate to specialists via spawn_child (one or more calls per turn) for any substantive task — writing or refactoring code, research, design, security review, devops work, etc. Use create_pipeline only when the user explicitly asks for a multi-stage workflow with handover (e.g., "research then implement then review"). Narrow exception: if the request is plainly trivial — a greeting, arithmetic, a single-fact answer, repeat-after-me, or a simple definition — answer directly without spawning. When in doubt between delegating and answering directly, delegate. If the user explicitly tells you to delegate or use spawn_child, always do so.`;
  }
  if (classification.type === 'ambiguous') {
    systemPrompt += `\n\nThe user's message could not be confidently classified. If it is plainly small-talk or a one-shot factual question, answer directly. Otherwise prefer spawn_child to a fitting specialist — when in doubt, delegate. If the user explicitly tells you to delegate, always do so.`;
  }

  // Expert index — the live list of experts (system + this user's custom
  // ones) the orchestrator can route to via spawn_child's `expertId`. Read
  // from the DB each turn so newly created experts become routable without a
  // prompt edit or restart. Skipped in lite mode: the lite spawn_child schema
  // is deliberately role+taskBrief only, and small models handle the extra
  // routing surface poorly.
  if (!isLite) {
    try {
      const { buildExpertIndexBlock } = await import('./expert-index');
      const expertBlock = await buildExpertIndexBlock(userId);
      if (expertBlock) systemPrompt += expertBlock;
    } catch (err) {
      coreLogger.warn({ err, sessionId }, 'Expert index injection skipped — orchestrator routes by role only');
    }
  }

  // Chat/work split (Thread 3): tell the orchestrator whether to deliver in
  // chat or as a file. Empty for the default-inline case, so unchanged.
  systemPrompt += buildOutputDirective(outputDirective.mode, outputDirective.forced);

  // Inject workspace awareness
  const sessionCtx = session?.context as import('@/db/schema/sessions').SessionContext | undefined;
  const isDevMode = sessionCtx?.devMode === true && !!sessionCtx.projectPath;

  if (isDevMode) {
    // Dev mode: focused on a specific project
    const projectPath = sessionCtx!.projectPath!;
    const projectName = sessionCtx!.projectName || projectPath.split(/[/\\]/).pop() || 'project';
    let wsContext = `\n\nDEV MODE SESSION — Project: ${projectName}`;
    wsContext += `\nProject path: ${projectPath}`;

    // Load the curated AGENTS.md guide for the orchestrator (lightweight brief)
    try {
      const { loadAgentsMd } = await import('./agents-md');
      const guide = await loadAgentsMd(projectPath);
      if (guide) {
        wsContext += `\nProject overview (from AGENTS.md): ${guide.slice(0, 500)}`;
      }
    } catch (err) { coreLogger.error({ err }, 'silent failure in service'); }

    wsContext += `\n\nAll worker tasks MUST target this project. Always include the full path "${projectPath}" in every worker task description. The user does not need to specify the project — it is implicit.`;
    wsContext += `\n\nFor complex implementation tasks in this project, PREFER using the "Full Development Cycle" pipeline (via create_pipeline) to ensure thorough research, architecture planning, and testing.`;
    systemPrompt += wsContext;
  } else {
    // Normal mode: generic workspace awareness.
    // Advertise the per-user sandbox root (the same one the filesystem tool
    // enforces via WorkspaceFS.forAgent), not the flat config.workspace.rootPath —
    // otherwise the orchestrator hands workers absolute paths that fall outside
    // their own sandbox.
    const wsConfig = getConfig();
    const wsRoot = WorkspaceFS.forAgent({ userId }).root;
    const wsAdditional = wsConfig.workspace.additionalPaths?.map((p: string) => resolve(p)).filter(Boolean) || [];

    // Multi-repo: when the repo registry has been scanned, inject the map of
    // the suite (kinds + dependency edges) — the orchestrator's "mental model"
    // — instead of a bare directory listing. See .octipus/multi-repo-design.md.
    let injectedSuite = false;
    try {
      const { loadRepoGraph } = await import('@/core/repos/registry-service');
      const { repos, edges } = await loadRepoGraph(userId);
      if (repos.length > 0) {
        let suite = `\nWORKSPACE SUITE — ${repos.length} repos under ${wsRoot}:`;
        for (const r of repos.slice(0, 40)) {
          const deps = edges
            .filter((e) => e.from === r.id)
            .map((e) => repos.find((x) => x.id === e.to)?.name)
            .filter(Boolean);
          suite += `\n  - ${r.name} [${r.kind}] ${r.rootPath}`
            + `${r.hasAgentsMd ? ' (AGENTS.md)' : ''}`
            + `${deps.length ? ` → depends on: ${deps.join(', ')}` : ''}`;
        }
        suite += `\n\nUse the repo_registry tool (list_repos / get_repo / repo_dependents) to navigate this suite efficiently — read a repo's map before its files. Route each worker to a repo by its ABSOLUTE PATH and tell it to read that repo's AGENTS.md first. For a cross-repo change, call repo_dependents on a library before editing it and name every affected repo in the worker tasks.`;
        systemPrompt += suite;
        injectedSuite = true;
      }
    } catch (err) {
      coreLogger.warn({ err }, 'repo registry suite injection failed; falling back to directory listing');
    }
    // Registry is authoritative when present — otherwise fall back to a raw
    // directory listing of the workspace root.
    if (!injectedSuite) try {
      const { readdirSync, statSync: statS } = await import('fs');
      const { hasAgentsMd } = await import('./agents-md');
      // List sibling repos and flag which carry a curated AGENTS.md guide, so
      // the orchestrator can point workers at it when entering a repo.
      const dirs = readdirSync(wsRoot)
        .filter(name => !name.startsWith('.') && statS(resolve(wsRoot, name)).isDirectory())
        .map(name => {
          const repoRoot = resolve(wsRoot, name);
          return hasAgentsMd(repoRoot) ? `  - ${name}/ (has AGENTS.md)` : `  - ${name}/`;
        });
      let wsContext = `\nWORKSPACE: Root is ${wsRoot}`;
      if (dirs.length > 0 && dirs.length <= 30) {
        wsContext += `\nProjects:\n${dirs.join('\n')}`;
      }
      if (wsAdditional.length > 0) {
        wsContext += `\nAdditional paths: ${wsAdditional.join(', ')}`;
      }
      wsContext += `\n\nIMPORTANT: When the user references "this project" or a project by name, resolve it to the FULL ABSOLUTE PATH and include that path explicitly in every worker task description. For example, if the user says "audit this project (octipus)", your task descriptions must say "audit the project at ${wsRoot}/octipus". Workers do NOT know which project the user means unless you tell them the exact path.`;
      wsContext += `\n\nWhen a repo is flagged "(has AGENTS.md)", tell the worker to read that repo's AGENTS.md first — it is the curated guide to the repo's structure and commands. For cross-repo work, name every repo involved and its path.`;
      systemPrompt += wsContext;
    } catch (err) {
      // The per-user nested root may not exist yet (new user who hasn't
      // written a file). Fall back to a bare workspace line; not fatal.
      coreLogger.debug({ err, wsRoot }, 'workspace readdir skipped — root may not exist yet');
      systemPrompt += `\nWORKSPACE: ${wsRoot}`;
    }
  }

  // Append the volatile per-turn context (date, summary, history) after the
  // whole static/semi-static instruction block — keeps the prefix cacheable.
  systemPrompt += volatileParts.join('');

  // Hook-triggered tasks get a longer timeout since they run unattended.
  const orchConfig = getConfig().orchestrator;
  const orchestratorTimeout = channel === 'hook'
    ? orchConfig.orchestratorHookTimeoutMs
    : orchConfig.orchestratorTimeoutMs;

  const worker = await agentManager.spawn({
    sessionId,
    userId,
    workspaceId,
    topic: orchestratorConfig.defaultTopic,
    model: modelName,
    role: 'orchestrator',
    systemPrompt,
    tools: metaTools,
    maxIterations: isLite ? orchCfg.liteMaxIterations : 25,
    timeout: orchestratorTimeout,
    // Seed the user's raw request so the spawner can forward it verbatim
    // to every child. Without this, children only see the orchestrator's
    // paraphrased taskBrief and drift into hallucinations.
    //
    // projectPath: pass through so the orchestrator's own shell/read tools
    // run in the dev-session project, not the default workspace. The
    // worker-spawner sets the same field on child agents
    // (worker-spawner.ts:333); without it here, the orchestrator's own
    // ls/read commands resolve to `<workspaceRoot>/workspace` — the
    // user-reported TUI bug where `--project` was effectively ignored.
    contextMetadata: {
      originalRequest: message,
      ...(isDevMode ? { projectPath: sessionCtx!.projectPath! } : {}),
    },
  });

  const agentId = worker.getContext().id;

  // Wire detach refs: bind the worker's pending-child methods so
  // `spawn_child` (detach mode) and `collect_children` can reach them.
  // Only full AgentWorkers expose these methods — CLI workers won't,
  // and the refs simply stay null (the spawn-tool downgrades to await
  // when hooks are missing).
  const maybeWorker = worker as unknown as {
    registerPendingChild?: (pc: PendingChild) => void;
    pendingDetachedCount?: () => number;
  };
  if (
    typeof maybeWorker.registerPendingChild === 'function' &&
    typeof maybeWorker.pendingDetachedCount === 'function'
  ) {
    orchestratorDetachHookRef.current = {
      registerPendingChild: maybeWorker.registerPendingChild.bind(worker),
      pendingDetachedCount: maybeWorker.pendingDetachedCount.bind(worker),
    };
    orchestratorWorkerRef.current = worker as unknown as AgentWorker;
    // Expose the worker on the node so `spawnChild` can sync the node's
    // token budget (`budget.tokens.used`) from the worker's live spend
    // before deriving each child's budget — otherwise `used` stays 0 and the
    // near-exhaustion spawn guard is inert. Children get this via
    // `childNode.workerRef` in the spawner; the orchestrator node needs it
    // wired here.
    (parentNode as unknown as { workerRef?: typeof orchestratorWorkerRef }).workerRef =
      orchestratorWorkerRef;
  }

  // Swarm: promote parent node id + persist root swarm_node row.
  parentNode.id = agentId;
  try {
    const rootBriefHash = taskFingerprint({
      originalUserRequest: message,
      topicPath: 'root',
      parentSummary: '',
      taskBrief: message,
      constraints: [],
      inputArtifacts: [],
      expectedOutput: { shape: 'summary', maxTokens: 2000 },
      forbidden: [],
    });
    await swarmNodeRepository.create({
      id: agentId,
      rootSessionId: sessionId,
      parentNodeId: null,
      depth: 0,
      kind: 'orchestrator',
      role: 'orchestrator',
      expertId: null,
      topicPath: 'root',
      subtopic: null,
      model: modelName,
      status: 'running',
      tokenCap: parentNode.budget.tokens.cap,
      wallClockCapMs: parentNode.budget.wallClockMs.cap,
      fanOutCap: parentNode.budget.fanOut.cap,
      briefHash: rootBriefHash,
      taskBriefPreview: message.slice(0, 4000),
    });
  } catch (err) {
    coreLogger.debug({ err, agentId }, 'root swarm_node persist skipped');
  }

  // Phase 1 side-effect bookkeeping: emit root spawn so UI sidebar lists it.
  try {
    const { getGatewayHub } = await import('@/core/gateway/hub');
    getGatewayHub().publishEvent({
      type: 'swarm.node_spawned',
      source: `swarm:${agentId}`,
      userId,
      sessionId,
      payload: {
        rootSessionId: sessionId,
        nodeId: agentId,
        parentNodeId: null,
        kind: 'orchestrator',
        depth: 0,
        topicPath: 'root',
        role: 'orchestrator',
        model: modelName,
        budgets: parentNode.budget,
        taskBriefPreview: message.slice(0, 200),
      },
    });
  } catch (err) {
    coreLogger.debug({ err }, 'swarm root event emit skipped');
  }

  emit({
    type: 'worker_spawned',
    sessionId,
    userId,
    data: { agentId, role: 'orchestrator', model: modelName },
    timestamp: new Date(),
  });

  const orchStartTime = Date.now();
  try {
    deps.setLastWorkerResult(null);
    const response = await worker.run(message);

    // Safety net: some LLMs (weaker/chatty ones) end their run by calling
    // `send_status_update` instead of returning plain text, leaving
    // `response` empty. Fall back to the last status message so the user
    // sees SOMETHING rather than a blank reply. The orchestrator prompt
    // tells the LLM not to do this, but the safety net is belt-and-braces.
    let finalResponse = deps.getLastWorkerResult() || response;
    if (!finalResponse || !finalResponse.trim()) {
      const ctxMeta = worker.getContext().metadata as Record<string, unknown>;
      const lastStatus = ctxMeta?.lastStatusMessage as string | undefined;
      if (lastStatus?.trim()) {
        coreLogger.warn(
          { agentId, role: 'orchestrator' },
          'Orchestrator returned empty — falling back to last send_status_update message',
        );
        finalResponse = lastStatus;
      }
    }
    deps.setLastWorkerResult(null);

    emit({
      type: 'worker_completed',
      sessionId,
      userId,
      data: {
        workerId: agentId,
        role: 'orchestrator',
        result: '',
        model: modelName,
        durationMs: Date.now() - orchStartTime,
        totalTokens: worker.getTotalTokens(),
        iterations: worker.getIteration(),
      },
      timestamp: new Date(),
    });

    // Swarm: mark root as completed + emit terminal event.
    try {
      await swarmNodeRepository.updateStatus(agentId, {
        status: 'completed',
        tokensUsed: worker.getTotalTokens(),
      });
      const { getGatewayHub } = await import('@/core/gateway/hub');
      getGatewayHub().publishEvent({
        type: 'swarm.node_completed',
        source: `swarm:${agentId}`,
        userId,
        sessionId,
        payload: {
          rootSessionId: sessionId,
          nodeId: agentId,
          parentNodeId: null,
          kind: 'orchestrator',
          depth: 0,
          topicPath: 'root',
          role: 'orchestrator',
          status: 'completed',
          usedTokens: worker.getTotalTokens(),
          durationMs: Date.now() - orchStartTime,
        },
      });
    } catch (err) {
      coreLogger.debug({ err, agentId }, 'swarm root completion bookkeeping skipped');
    }

    return { response: finalResponse, agentId, sources };
  } catch (error) {
    deps.setLastWorkerResult(null);

    const errMsg = (error as Error).message || '';
    const wasStopped = errMsg.includes('aborted') || errMsg.includes('stopped') || worker.getStatus() === 'stopped';
    // Admin cancel / cascaded abort is an intentional outcome — don't log it
    // as `error`. The status downstream is already 'stopped'/'cancelled'.
    if (wasStopped || isCancellationError(error)) {
      coreLogger.info({ agentId, reason: errMsg }, 'Orchestrator agent cancelled');
    } else {
      coreLogger.error({ error, agentId }, 'Orchestrator agent failed');
    }

    emit({
      type: 'worker_completed',
      sessionId,
      userId,
      data: {
        workerId: agentId,
        role: 'orchestrator',
        result: '',
        model: modelName,
        status: wasStopped ? 'stopped' : 'failed',
        durationMs: Date.now() - orchStartTime,
        totalTokens: worker.getTotalTokens(),
        iterations: worker.getIteration(),
        error: wasStopped ? undefined : (error as Error).message,
      },
      timestamp: new Date(),
    });
    // Swarm: mark root failed/cancelled + emit terminal event.
    try {
      const rootStatus: 'cancelled' | 'tool_error' = wasStopped ? 'cancelled' : 'tool_error';
      await swarmNodeRepository.updateStatus(agentId, {
        status: rootStatus,
        tokensUsed: worker.getTotalTokens(),
        error: wasStopped ? undefined : errMsg,
      });
      const { getGatewayHub } = await import('@/core/gateway/hub');
      getGatewayHub().publishEvent({
        type: 'swarm.node_completed',
        source: `swarm:${agentId}`,
        userId,
        sessionId,
        payload: {
          rootSessionId: sessionId,
          nodeId: agentId,
          parentNodeId: null,
          kind: 'orchestrator',
          depth: 0,
          topicPath: 'root',
          role: 'orchestrator',
          status: rootStatus,
          usedTokens: worker.getTotalTokens(),
          durationMs: Date.now() - orchStartTime,
          error: wasStopped ? undefined : (errMsg || undefined),
        },
      });
    } catch (err) {
      coreLogger.debug({ err, agentId }, 'swarm root failure bookkeeping skipped');
    }

    const response = wasStopped
      ? 'Task was stopped. Would you like to adjust the request or start something new?'
      : `I encountered an error while processing your request: ${humanizeProviderError(errMsg)}`;
    return { response, agentId, sources };
  }
}
