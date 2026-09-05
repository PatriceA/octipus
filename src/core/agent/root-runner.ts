import { resolve } from 'path';
import { getConfig } from '@/config';
import { getAgentManager } from '@/core/agent-manager';
import { humanizeProviderError } from '@/core/errors/humanize';
import { isCancellationError } from '@/core/swarm/errors';
import { swarmNodeRepository } from '@/core/swarm/node-repository';
import { taskFingerprint } from '@/core/swarm/spawner';
import type { AgentWorker } from '@/core/agent-worker';
import type { ToolHandler } from '@/core/agent-base';
import { type AgentNode, LEVEL_DEFAULT, type PendingChild } from '@/core/swarm/types';
import { WorkspaceFS } from '@/security/workspace-fs';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { SessionContext } from '@/db/schema/sessions';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { truncateLinesToTokens } from '@/utils/token-count';
import { getAgentHooks } from './hooks';
import { estimateToolSchemaTokens, logPromptComposition, recordContextFill } from './prompt-budget';
import { buildSecurityReminder } from './input-guard';
import { createMetaTools } from './meta-tools';
import { shouldUseLazyDiscovery } from './lazy-tools';
import { isPlanMode, PLAN_MODE_DIRECTIVE, stripMutatingTools } from './plan-mode';
import { isLongTailHandler } from './tool-split';
import { buildCapabilitiesHandler } from '@/tools/self-report';
import type { ModelSelector } from './model-selector';
import { resolvePromptTier } from './prompt-tier';
import { buildOutputDirective } from './output-directive';
import { getRoleConfig, getToolsForRole } from './roles';
import delegationPrompt from './delegation-prompt.md';
import { applyToolCap, isSmallModel } from './small-model';
import { channelCanPrompt } from '@/security/approval-policy';
import { ROOT_ROLE } from './types';
import type { TurnEvent, AgentService } from './service';
import type { MessageClassification } from './types';

// Token budget for the workspace-suite repo list (Phase 5 item 2 follow-up).
// The top-40 count cap alone can't bound it — rootPath + dependency lists are
// unbounded — so budget the lines and keep the top (highest-value) repos.
const REPO_SUITE_TOKEN_BUDGET = 1500;

/** Dependency bundle the runner needs from AgentService. */
export interface RootRunnerDeps {
  modelSelector: ModelSelector;
  emit: (event: TurnEvent) => void;
  setLastWorkerResult: (result: string | null) => void;
  getLastWorkerResult: () => string | null;
}

/**
 * Build, spawn, and run the ROOT agent for a single turn: one AgentWorker with
 * the general toolset plus the spawn_child / create_pipeline meta-tools, which
 * answers the request itself and delegates only when a specialist is needed.
 *
 * Phase 9 of the rebuild plan deleted the routing hop this used to be. The root
 * used to run as role `root agent` holding meta-tools and `profiles` and
 * nothing else, so it could not do any work — 51% of its runs delegated to
 * nobody and answered from parametric memory, after a keyword classifier had
 * already decided the hop should run at all. Both the classifier's control-flow
 * branch and the tool-less role are gone; what remains is the single loop.
 */
/**
 * The delegation policy appended to every root agent turn.
 *
 * This is POLICY, not a classification result. It used to ride inside the
 * `if (classification.topic)` block, so a message the keyword table did not
 * recognise reached the root agent with no delegation guidance at all — and
 * the requests least likely to match a keyword are exactly the ones most likely
 * to need delegating. It is now unconditional, and the topic is a separate,
 * weaker thing (see `buildTopicHint`).
 *
 * Lite mode gets a contradiction-free version: the lite prompt already says
 * "Delegate ONCE per request", so this text must NOT say "one or more calls per
 * turn" (small models are literal — that conflict is what drove the
 * rule-breaking second spawn in run 743d4b66) and must NOT advertise
 * `create_pipeline`, which the lite spawn schema does not expose.
 */
export function buildDelegationPolicy(isLite: boolean): string {
  return isLite
    ? `\n\nYou hold real tools — use them. Answer the request yourself whenever your own tools reach it. Call spawn_child EXACTLY ONCE, and only when the task needs a specialist you are not: writing or refactoring code, security review, devops, or deep multi-source research. Then relay the child's result. Never tell the user a capability is missing: either call a tool or spawn the specialist that holds it.`
    : `\n\nYou are the agent the user is talking to, and you hold the general toolset — files, the web, the knowledge base, notes, tasks, profiles, messaging, scheduling, artifacts. Doing the work yourself is the normal path: read the file, run the search, store the note, and answer. Call spawn_child when the task needs a toolset or judgement you do not have — writing or refactoring code, design work, security review, devops, QA, deep multi-source research — or when independent parts of the request can genuinely run in parallel. Use create_pipeline only when the user explicitly asks for a multi-stage workflow with handover (e.g. "research then implement then review"). Delegating a one-tool question you could answer yourself costs the user a whole extra agent for nothing. Never tell the user a capability is missing: call the tool, or spawn the specialist that holds it — saying the knowledge base, the web or a repository is unreachable because you did not try is a wrong answer about the product. If the user explicitly tells you to delegate or use spawn_child, always do so.`;
}

/**
 * The keyword classifier's topic, which now reaches the model in LITE MODE ONLY,
 * and only as a hint.
 *
 * It is a regex table's guess at what a request is about. A capable model reads
 * the same message and reads it better, so "use this as the child role when
 * calling spawn_child" replaced that model's judgement with the table's — and
 * the table's own source carries years of comments about the asks it steals
 * from the right role. Lite keeps the hint because a small model is literal
 * enough to follow one and weak enough to route badly without it.
 */
export function buildTopicHint(
  isLite: boolean,
  classification: Pick<MessageClassification, 'topic' | 'confidence'>,
): string {
  if (!isLite || !classification.topic) return '';
  // A paragraph break, not a leading space. The hint used to be concatenated
  // straight onto the delegation policy, where a space was right; it now rides
  // in the volatile tier after the recent-history block, so a space glues a
  // routing directive onto the last transcript line and it reads as more
  // transcript.
  return `\n\nThe message looks like a "${classification.topic}" task (confidence: ${classification.confidence.toFixed(2)}); use that as the child role unless the request plainly says otherwise.`;
}

/**
 * Join the two prompt tiers. The order is the contract: everything cacheable
 * first, then the volatile block whose leading date stamp is the marker
 * `splitVolatileSystem` cuts on. A part appended after the volatile tier lands
 * inside the uncached section; a per-turn part pushed into the static tier
 * costs the whole prefix a cache write every turn.
 */
export function assembleSystemPrompt(staticParts: string[], volatileParts: string[]): string {
  return [...staticParts, ...volatileParts].filter(Boolean).join('');
}

export async function runRootAgent(
  service: AgentService,
  deps: RootRunnerDeps,
  sessionId: string,
  userId: string,
  message: string,
  classification: MessageClassification,
  guardFlags: string[] = [],
  channel?: string,
  /**
   * Memory-redesign Phase D — appended to the root agent's system
   * prompt. Pre-rendered by `handleMessage` once per turn so both
   * the root agent and the directResponse path see the same
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
  const modelName = await deps.modelSelector.selectForRootAgent(sessionId);

  // Resolve the root agent mode for THIS turn. 'auto' (default) re-derives
  // from the current default model's size every turn, so swapping to a
  // smaller model switches the root agent to lite/router with no restart.
  // router short-circuits below to a deterministic single-worker turn; lite
  // shrinks the prompt/tools/iterations further down; full is unchanged.
  const agentCfg = getConfig().agent;
  const modelMeta = await getModelRegistry().getModelByModelId(modelName);
  const promptTier = resolvePromptTier(
    { modelId: modelName, metadata: modelMeta?.metadata, provider: modelMeta?.provider },
    {
      mode: agentCfg.promptTier,
      smallModelMaxParams: agentCfg.smallModelMaxParams,
      liteModelMaxParams: agentCfg.liteModelMaxParams,
    },
  );
  coreLogger.info({ sessionId, modelName, promptTier, role: ROOT_ROLE }, 'Root agent mode resolved');

  // Read once, here, because the tool set is decided further down and plan mode
  // has to reach it. The later `session` read is the same row.
  const session = await sessionRepository.findById(sessionId);
  const planSessionCtx = session?.context as import('@/db/schema/sessions').SessionContext | undefined;

  const rootRoleConfig = getRoleConfig(ROOT_ROLE);

  // Build the swarm root node AgentNode up front so meta-tools can bind to
  // it. The actual DB row is written once we know the agentId (post-spawn).
  // The root agent's allowed tool ids is the superset of its role's tools
  // plus the meta-tools it owns.
  const rootAbortController = new AbortController();
  const rootAllowedToolIds = new Set<string>();
  // Meta-tool ids that the root agent owns by construction.
  for (const name of ['spawn_child', 'collect_children', 'create_pipeline', 'list_pipeline_templates', 'filter_pii', 'request_user_approval', 'exit_plan_mode', 'send_status_update', 'remember_this', 'remember_about_self', 'reflect']) {
    rootAllowedToolIds.add(name);
  }
  // The root's own role tools — the general toolset it works with directly.
  for (const id of rootRoleConfig.toolIds) rootAllowedToolIds.add(id);
  // Superset: root agent is the root of every swarm branch and must be
  // able to grant any specialist role's tools to its children via
  // intersection. Without this, e.g. the `general` role's `profiles` tool
  // would be stripped out because the root agent itself never lists it.
  const { ROLE_CONFIGS } = await import('./roles');
  for (const cfg of Object.values(ROLE_CONFIGS)) {
    for (const id of cfg.toolIds) rootAllowedToolIds.add(id);
  }

  // Parent AgentNode for the swarm. `id` is a placeholder — overwritten
  // once we know the real agentId post-spawn. `spawn_child` closes over
  // `parentNode` by reference, so the mutation is observed.
  const parentNode: AgentNode = {
    id: '__pending__',
    rootSessionId: sessionId,
    parentNodeId: null,
    kind: 'root',
    depth: 0,
    role: ROOT_ROLE,
    topicPath: 'root',
    model: modelName,
    budget: {
      tokens: { cap: LEVEL_DEFAULT[0].tokens, used: 0 },
      wallClockMs: { cap: LEVEL_DEFAULT[0].wallMs, startedAt: Date.now() },
      fanOut: { cap: LEVEL_DEFAULT[0].fanOut, used: 0 },
      depth: 0,
    },
    allowedToolIds: rootAllowedToolIds,
    signal: rootAbortController.signal,
  };

  // Late-bound worker handles for detach-mode `spawn_child` +
  // `collect_children`. The root agent's AgentWorker is created below
  // by `agentManager.spawn(...)`; both refs are populated once it
  // returns. Tool executes run inside `worker.run(...)` AFTER this
  // wiring, so a stray null on these refs would be a bug in the spawn
  // path, not a race.
  const rootDetachHookRef: {
    current: {
      registerPendingChild: (pc: PendingChild) => void;
      pendingDetachedCount: () => number;
    } | null;
  } = { current: null };
  const rootWorkerRef: { current: AgentWorker | null } = { current: null };

  const isLite = promptTier === 'lite';
  const metaTools = createMetaTools(service, {
    parentNode,
    swarmRefs: {
      detachHookRef: rootDetachHookRef,
      workerRef: rootWorkerRef,
    },
    lite: isLite,
  });

  // The root's own tools. `getToolsForRole` is the same gate every worker goes
  // through (capability check, MCP lazy handlers, read-only filtering).
  // ponytail: it does NOT do the worker-spawner's per-user connector bindings or
  // skill injection — the root had no tools at all before this, so that is a
  // gain, not a regression. Lift `spawnWorker`'s tool assembly here if a user
  // asks the root to reach a bound connector directly.
  let rootTools = getToolsForRole(ROOT_ROLE);
  // A planning turn holds no file-writing tools. Applied to the ROOT's set
  // before `allowedToolIds` is derived from it, so a child it spawns cannot be
  // granted what the parent does not hold — the same reasoning the read-only
  // role filter documents.
  if (isPlanMode(planSessionCtx)) rootTools = stripMutatingTools(rootTools);
  // The small-model answer to "what runs the loop now": the same loop, a reduced
  // tool set, and a hard iteration cap (below). Gated on `isSmallModel` — the
  // SMALL tier — and not on `isLite`, which is the 24B prompt tier: every worker
  // caps on the small tier, and gating the root differently would take eight
  // tool groups off a 14B root while an identically-bound worker on the same
  // model kept all fifteen.
  const rootIsSmall = isSmallModel({ modelId: modelName, metadata: modelMeta?.metadata }, agentCfg.smallModelMaxParams);
  let droppedToolGroups: string[] = [];
  if (rootIsSmall) {
    const before = new Set(rootTools.map((t) => t.toolId ?? t.name));
    rootTools = applyToolCap(rootTools, agentCfg.smallModelMaxTools, { role: ROOT_ROLE, modelId: modelName });
    const after = new Set(rootTools.map((t) => t.toolId ?? t.name));
    droppedToolGroups = [...before].filter((id) => !after.has(id));
  }
  // `capabilities` — how the root answers questions about itself. Advertised on
  // every provider, unlike the lazy-discovery pair below: asked "what can you
  // do?", an agent with no way to enumerate itself answers from whatever is in
  // its advertised schema, which is partial at best and invented at worst. The
  // handler is rebuilt after the tool set is final so its counts describe the
  // turn that is actually about to run.
  const selfReport = (advertised: ToolHandler[]) =>
    buildCapabilitiesHandler({
      advertised,
      registered: rootTools,
      userId,
      model: modelName,
      role: ROOT_ROLE,
    });

  let turnTools = [...rootTools, ...metaTools];
  turnTools = [...turnTools, selfReport(turnTools)];

  // Lazy tool discovery, same gate every worker goes through
  // (`worker-spawner.ts`): on local Ollama the per-request tool schema is
  // re-prefilled on the iGPU every single request, and the root now carries the
  // whole general toolset. Remote providers stay on the full schema — they
  // prefix-cache the tool block cheaply and tool-call more reliably with it —
  // and a small model keeps the capped full schema above, because it chains
  // multi-step discovery badly.
  let toolAdvertisement: import('@/core/agent-base').ToolAdvertisement = { mode: 'full' };
  const rootCoreToolIds = rootRoleConfig.coreToolIds;
  if (
    rootCoreToolIds !== undefined &&
    shouldUseLazyDiscovery({
      hasCoreToolIds: true,
      isSmallModel: rootIsSmall,
      supportsTools: modelMeta?.supportsTools === true,
      enabled: agentCfg.lazyToolDiscovery,
    })
  ) {
    try {
      const { splitRoleTools } = await import('./tool-split');
      const { buildToolDiscoveryHandlers } = await import('@/tools/tool-discovery');
      const { longTail } = splitRoleTools(rootTools, rootCoreToolIds);
      const discoveryHandlers = buildToolDiscoveryHandlers(longTail);
      if (discoveryHandlers.length > 0) {
        // Everything stays REGISTERED (dispatch must keep working); only what is
        // advertised shrinks. The meta-tools are never in the long tail — the
        // root's ability to delegate must not need a discovery round-trip.
        const lazyCore = [...rootTools, ...discoveryHandlers, ...metaTools];
        // `capabilities` is core on the lazy path too — the one question it
        // answers is the one a shrunken advertisement makes hardest to answer.
        turnTools = [...lazyCore, selfReport(lazyCore)];
        toolAdvertisement = {
          mode: 'lazy',
          coreToolIds: [...rootCoreToolIds, ...metaTools.map((t) => t.toolId ?? t.name), 'self_report'],
        };
        rootAllowedToolIds.add('tool_discovery');
        coreLogger.info(
          { role: ROOT_ROLE, model: modelName, longTailCount: longTail.length },
          'Lazy tool discovery enabled for the rootAgent',
        );
      }
    } catch (err) {
      coreLogger.warn({ err, model: modelName }, 'Lazy tool discovery gate skipped for the root (non-fatal) — using full schema');
    }
  }

  let systemPrompt = isLite
    ? (rootRoleConfig.liteSystemPromptTemplate ?? rootRoleConfig.systemPromptTemplate)
    : rootRoleConfig.systemPromptTemplate;

  // Anchor the root agent in real wall-clock time. Without this stamp the
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
  // Long-term memory and attached files are retrieved PER TURN (memories are
  // scoped by the classifier's topic, files by what the user attached), so they
  // belong in the volatile tier. They used to be concatenated into the static
  // prefix, which put per-turn content ahead of the cache breakpoint and busted
  // the whole ~6k prefix on every turn the memory set differed.
  if (extraSystemContext) volatileParts.push(extraSystemContext);
  // Same reasoning for everything else derived from THIS turn: the security
  // reminder fires on a flagged message, the topic hint and the ambiguity
  // notice come from the classifier's read of this message, and the output
  // directive from this request's inline/file mode. Each one in the static tier
  // is a per-turn cache miss on the whole prefix.
  if (guardFlags.length > 0) volatileParts.push(buildSecurityReminder(guardFlags));

  // Fire the before-agent-start hook so extensions and built-in
  // modules (persona, project context) can mutate the system
  // prompt before the root agent LLM call. Subscribers run
  // sequentially; thrown handlers are logged and swallowed.
  const hookCtx = await getAgentHooks().fire('before-agent-start', {
    role: ROOT_ROLE,
    root: true,
    userId,
    sessionId,
    workspaceId,
    channel,
    systemPrompt,
    // What the hook can no longer read off `systemPrompt`, because it moved to
    // the volatile tier to keep the cacheable prefix stable. Read-only.
    turnContext: volatileParts.slice(1).join(''),
  });
  systemPrompt = hookCtx.systemPrompt;

  // From here the prompt is assembled into labelled parts rather than one
  // string, so `logPromptComposition` can say WHICH block costs what. The
  // worker and swarm paths have had that measurement since the prompt-size
  // audit; the root agent's own turn — the one the measured pass put at
  // ~8.4k tokens for a one-line question — never did.
  const staticParts: string[] = [systemPrompt];

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

  // Load recent conversation history so the root agent can reference prior messages
  const recentHistory = await messageRepository.findRecentBySession(sessionId, 10, ['user', 'assistant'], clearedAt);
  if (recentHistory.length > 0) {
    sources.push(`recent ${recentHistory.length} msg${recentHistory.length === 1 ? '' : 's'}`);
  }
  // Only claimed as a source where it is actually consumed. Full mode no
  // longer routes on it (see the delegation policy below), so listing it there
  // would tell the user a decision was made that was not.
  if (isLite && classification.topic) {
    sources.push(`classifier(${classification.topic})`);
  }
  if (recentHistory.length > 0) {
    const historyLines = recentHistory.map(m =>
      `[${m.role}]: ${m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content}`
    );
    volatileParts.push(`\n\nRecent conversation history (last ${recentHistory.length} messages):\n${historyLines.join('\n\n')}`);
  }

  // The cap drops whole tool groups the role prompt still advertises by name
  // ("who is my wife → search_profiles"), so a capped model would call a tool
  // that is not registered and burn iterations it does not have. Say what is
  // missing, and what to do instead.
  if (droppedToolGroups.length > 0) {
    staticParts.push(
      `\n\nNOT AVAILABLE THIS TURN (your model's tool budget): ${droppedToolGroups.join(', ')}. ` +
      'Ignore any instruction above that tells you to use them — calling one will fail. ' +
      'If the request needs one, spawn_child to a specialist that holds it.',
    );
  }

  staticParts.push(buildDelegationPolicy(isLite));
  // The delegation mechanics — how spawn_child/collect_children actually behave,
  // which role fits which task, the read-only clause, the no-respawn rule. Full
  // tier only: lite's whole delegation contract is "once, then relay", and a
  // small model given three pages about swarms spawns instead of working.
  //
  // This is what survived the root agent role's prompt when the role itself
  // went (Phase 9). The half that said "you do NO real work, delegate even what
  // you know" is what the phase deleted; the mechanics below are as true now as
  // they were, and the routing table gained the sentence about what NOT to
  // delegate — the root holds those tools itself.
  if (!isLite) staticParts.push(`\n\n${delegationPrompt}`);
  volatileParts.push(buildTopicHint(isLite, classification));
  if (classification.type === 'ambiguous') {
    volatileParts.push(`\n\nThe user's message could not be confidently classified. If it is plainly small-talk or a one-shot factual question, answer directly. Otherwise prefer spawn_child to a fitting specialist — when in doubt, delegate. If the user explicitly tells you to delegate, always do so.`);
  }

  // Expert index — the live list of experts (system + this user's custom
  // ones) the root agent can route to via spawn_child's `expertId`. Read
  // from the DB each turn so newly created experts become routable without a
  // prompt edit or restart. Skipped in lite mode: the lite spawn_child schema
  // is deliberately role+taskBrief only, and small models handle the extra
  // routing surface poorly.
  if (!isLite) {
    try {
      const { buildExpertIndexBlock } = await import('./expert-index');
      const expertBlock = await buildExpertIndexBlock(userId);
      if (expertBlock) staticParts.push(expertBlock);
    } catch (err) {
      coreLogger.warn({ err, sessionId }, 'Expert index injection skipped — rootAgent routes by role only');
    }
  }

  // Chat/work split (Thread 3): tell the root agent whether to deliver in
  // chat or as a file. Empty for the default-inline case, so unchanged.
  volatileParts.push(buildOutputDirective(outputDirective.mode, outputDirective.forced));

  // Inject workspace awareness
  const sessionCtx = session?.context as import('@/db/schema/sessions').SessionContext | undefined;
  const isDevMode = sessionCtx?.devMode === true && !!sessionCtx.projectPath;

  // Plan mode: state what the tool filter below cannot enforce. Volatile tier,
  // because it is a property of this session right now rather than of the
  // install, and a per-session block in the static tier costs the whole prefix
  // a cache write every turn.
  if (isPlanMode(sessionCtx)) volatileParts.push(PLAN_MODE_DIRECTIVE);

  if (isDevMode) {
    // Dev mode: focused on a specific project
    const projectPath = sessionCtx!.projectPath!;
    const projectName = sessionCtx!.projectName || projectPath.split(/[/\\]/).pop() || 'project';
    let wsContext = `\n\nDEV MODE SESSION — Project: ${projectName}`;
    wsContext += `\nProject path: ${projectPath}`;

    // Load the curated AGENTS.md guide for the root agent (lightweight brief)
    try {
      const { loadAgentsMd } = await import('./agents-md');
      const guide = await loadAgentsMd(projectPath);
      if (guide) {
        wsContext += `\nProject overview (from AGENTS.md): ${guide.slice(0, 500)}`;
      }
    } catch (err) { coreLogger.error({ err }, 'silent failure in service'); }

    wsContext += `\n\nAll worker tasks MUST target this project. Always include the full path "${projectPath}" in every worker task description. The user does not need to specify the project — it is implicit.`;
    wsContext += `\n\nFor complex implementation tasks in this project, PREFER using the "Full Development Cycle" pipeline (via create_pipeline) to ensure thorough research, architecture planning, and testing.`;
    staticParts.push(wsContext);
  } else {
    // Normal mode: generic workspace awareness.
    // Advertise the per-user sandbox root (the same one the filesystem tool
    // enforces via WorkspaceFS.forAgent), not the flat config.workspace.rootPath —
    // otherwise the root agent hands workers absolute paths that fall outside
    // their own sandbox.
    const wsConfig = getConfig();
    const wsRoot = WorkspaceFS.forAgent({ userId }).root;
    const wsAdditional = wsConfig.workspace.additionalPaths?.map((p: string) => resolve(p)).filter(Boolean) || [];

    // Multi-repo: when the repo registry has been scanned, inject the map of
    // the suite (kinds + dependency edges) — the root agent's "mental model"
    // — instead of a bare directory listing. See .octipus/multi-repo-design.md.
    let injectedSuite = false;
    try {
      const { loadRepoGraph } = await import('@/core/repos/registry-service');
      const { repos, edges } = await loadRepoGraph(userId);
      if (repos.length > 0) {
        const repoLines = repos.slice(0, 40).map((r) => {
          const deps = edges
            .filter((e) => e.from === r.id)
            .map((e) => repos.find((x) => x.id === e.to)?.name)
            .filter(Boolean);
          return `  - ${r.name} [${r.kind}] ${r.rootPath}`
            + `${r.hasAgentsMd ? ' (AGENTS.md)' : ''}`
            + `${deps.length ? ` → depends on: ${deps.join(', ')}` : ''}`;
        });
        // Token-bound the per-repo lines (Phase 5 item 2 follow-up), keeping
        // whole lines so no absolute path is severed. The trailing tool-usage
        // instructions are appended AFTER the budget so they always survive.
        const { lines: shown, truncated } = truncateLinesToTokens(repoLines, REPO_SUITE_TOKEN_BUDGET);
        let suite = `\nWORKSPACE SUITE — ${repos.length} repos under ${wsRoot}:\n${shown.join('\n')}`;
        if (truncated) suite += `\n  (…suite truncated — showing top ${shown.length} of ${repos.length} repos)`;
        suite += `\n\nUse the repo_registry tool (list_repos / get_repo / repo_dependents) to navigate this suite efficiently — read a repo's map before its files. Route each worker to a repo by its ABSOLUTE PATH and tell it to read that repo's AGENTS.md first. For a cross-repo change, call repo_dependents on a library before editing it and name every affected repo in the worker tasks.`;
        staticParts.push(suite);
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
      // the root agent can point workers at it when entering a repo.
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
      staticParts.push(wsContext);
    } catch (err) {
      // The per-user nested root may not exist yet (new user who hasn't
      // written a file). Fall back to a bare workspace line; not fatal.
      coreLogger.debug({ err, wsRoot }, 'workspace readdir skipped — root may not exist yet');
      staticParts.push(`\nWORKSPACE: ${wsRoot}`);
    }
  }

  // Append the volatile per-turn context (date, summary, history) after the
  // whole static/semi-static instruction block — keeps the prefix cacheable.
  systemPrompt = assembleSystemPrompt(staticParts, volatileParts);

  const advertisedTools =
    toolAdvertisement.mode === 'lazy'
      ? turnTools.filter((t) => !isLongTailHandler(t, toolAdvertisement.coreToolIds))
      : turnTools;

  recordContextFill(sessionId, logPromptComposition(
    {
      role: ROOT_ROLE,
      model: modelName,
      contextWindow: modelMeta?.contextWindow ?? undefined,
      // What is ADVERTISED, not what is registered. On the lazy path those are
      // very different numbers — every tool stays registered and callable, and
      // only the schema block shrinks — so measuring `turnTools` reported the
      // full set either way and showed a saving of zero for the one change that
      // exists to produce one. An instrument that cannot see the effect it was
      // built to measure is worse than no instrument.
      toolCount: advertisedTools.length,
      toolSchemaTokens: estimateToolSchemaTokens(
        advertisedTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      ),
      ...(toolAdvertisement.mode === 'lazy'
        ? { advertisement: 'lazy' as const, registeredToolCount: turnTools.length }
        : {}),
    },
    { static: staticParts.filter(Boolean), volatile: volatileParts.filter(Boolean) },
  ));

  // Hook-triggered tasks get a longer timeout since they run unattended.
  const agentConfig = getConfig().agent;
  const turnTimeout = channel === 'hook'
    ? agentConfig.hookTurnTimeoutMs
    : agentConfig.turnTimeoutMs;

  const worker = await agentManager.spawn({
    sessionId,
    userId,
    workspaceId,
    topic: rootRoleConfig.defaultTopic,
    model: modelName,
    role: ROOT_ROLE,
    root: true,
    // Who is on the other end — derived from whether this channel can actually
    // CARRY a prompt, not from its name. The old test ("not a hook, not a
    // heartbeat") counted the REST API as attended, and the API has no relay:
    // an ASK raised there was delivered nowhere and sat pending for its whole
    // TTL before failing. See `channelCanPrompt`.
    attended: channelCanPrompt(channel),
    systemPrompt,
    tools: turnTools,
    toolAdvertisement,
    maxIterations: isLite ? agentCfg.liteMaxIterations : 25,
    timeout: turnTimeout,
    // Seed the user's raw request so the spawner can forward it verbatim
    // to every child. Without this, children only see the root agent's
    // paraphrased taskBrief and drift into hallucinations.
    //
    // projectPath: pass through so the root agent's own shell/read tools
    // run in the dev-session project, not the default workspace. The
    // worker-spawner sets the same field on child agents
    // (worker-spawner.ts:333); without it here, the root agent's own
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
    rootDetachHookRef.current = {
      registerPendingChild: maybeWorker.registerPendingChild.bind(worker),
      pendingDetachedCount: maybeWorker.pendingDetachedCount.bind(worker),
    };
    rootWorkerRef.current = worker as unknown as AgentWorker;
    // Expose the worker on the node so `spawnChild` can sync the node's
    // token budget (`budget.tokens.used`) from the worker's live spend
    // before deriving each child's budget — otherwise `used` stays 0 and the
    // near-exhaustion spawn guard is inert. Children get this via
    // `childNode.workerRef` in the spawner; the root agent node needs it
    // wired here.
    (parentNode as unknown as { workerRef?: typeof rootWorkerRef }).workerRef =
      rootWorkerRef;
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
      kind: 'root',
      role: ROOT_ROLE,
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
        kind: 'root',
        depth: 0,
        topicPath: 'root',
        role: ROOT_ROLE,
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
    data: { agentId, role: ROOT_ROLE, root: true, model: modelName },
    timestamp: new Date(),
  });

  const orchStartTime = Date.now();
  try {
    deps.setLastWorkerResult(null);
    const response = await worker.run(message);

    // Safety net: some LLMs (weaker/chatty ones) end their run by calling
    // `send_status_update` instead of returning plain text, leaving
    // `response` empty. Fall back to the last status message so the user
    // sees SOMETHING rather than a blank reply. The root agent prompt
    // tells the LLM not to do this, but the safety net is belt-and-braces.
    let finalResponse = deps.getLastWorkerResult() || response;
    if (!finalResponse || !finalResponse.trim()) {
      const ctxMeta = worker.getContext().metadata as Record<string, unknown>;
      const lastStatus = ctxMeta?.lastStatusMessage as string | undefined;
      if (lastStatus?.trim()) {
        coreLogger.warn(
          { agentId, role: ROOT_ROLE },
          'Root agent returned empty — falling back to last send_status_update message',
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
        role: ROOT_ROLE,
        root: true,
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
          kind: 'root',
          depth: 0,
          topicPath: 'root',
          role: ROOT_ROLE,
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
      coreLogger.info({ agentId, reason: errMsg }, 'Root agent cancelled');
    } else {
      coreLogger.error({ error, agentId }, 'Root agent failed');
    }

    emit({
      type: 'worker_completed',
      sessionId,
      userId,
      data: {
        workerId: agentId,
        role: ROOT_ROLE,
        root: true,
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
          kind: 'root',
          depth: 0,
          topicPath: 'root',
          role: ROOT_ROLE,
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
