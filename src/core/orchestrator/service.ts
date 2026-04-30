import { resolve } from 'path';
import { getConfig } from '@/config';
import { getAgentManager } from '@/core/agent-manager';
import { handleCommand } from '@/core/commands';
import { swarmNodeRepository } from '@/core/swarm/node-repository';
import { taskFingerprint } from '@/core/swarm/spawner';
import { type AgentNode, LEVEL_DEFAULT } from '@/core/swarm/types';
import { TrajectoryRecorder } from '@/core/trajectories/recorder';
import type { AgentContext } from '@/core/types';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { SessionContext } from '@/db/schema/sessions';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import type { ApprovalRequest } from './approval-manager';
import { ApprovalManager } from './approval-manager';
import { classifyMessage } from './classifier';
import { directResponse } from './direct-response';
import { buildSecurityReminder, guardInput } from './input-guard';
import { createMetaTools } from './meta-tools';
import { ModelSelector } from './model-selector';
import { guardOutput } from './output-guard';
import { filterPII } from './pii-filter';
import { getRoleConfig } from './roles';
import { maybeCompactSession } from './session-compaction';
import { resolveSession } from './session-resolver';
import { appendSources, type MessageClassification, type ResponseMetadata } from './types';
import { handleExpertMessage, spawnWorker } from './worker-spawner';

interface OrchestratorEventHandler {
  (event: OrchestratorEvent): void;
}

export interface OrchestratorEvent {
  type: 'chat_response' | 'status_update' | 'approval_required' | 'worker_spawned' | 'worker_completed' | 'pipeline_event';
  sessionId: string;
  userId?: string;
  data: unknown;
  timestamp: Date;
}

export class OrchestratorService {
  private eventHandlers: Set<OrchestratorEventHandler> = new Set();
  private approvalManager = new ApprovalManager();
  private modelSelector = new ModelSelector();
  private _lastWorkerResult: string | null = null;

  /**
   * Subscribe to orchestrator events. The gateway hub does this at startup
   * via `event-bridge.ts` and forwards every event to the GatewayEventBus —
   * so orchestrator events DO land in the gateway replay buffer. Direct
   * subscribers should still prefer `getGatewayHub().eventBus.subscribe(...)`
   * unless they need raw shape (no event-type mapping).
   */
  onEvent(handler: OrchestratorEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: OrchestratorEvent): void {
    // Synchronous fan-out to local subscribers. The gateway-event-bridge is
    // one of these subscribers; it republishes through GatewayEventBus so
    // the replay buffer captures every orchestrator event.
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        coreLogger.error({ error }, 'Orchestrator event handler error');
      }
    }
  }

  /** Dependency bundle passed to extracted modules */
  private get deps() {
    return {
      modelSelector: this.modelSelector,
      emit: (event: OrchestratorEvent) => this.emit(event),
      setLastWorkerResult: (result: string | null) => { this._lastWorkerResult = result; },
    };
  }

  // ── Main entry point ─────────────────────────────────────────────

  async handleMessage(
    sessionId: string,
    userId: string,
    message: string,
    channel?: string,
    expertId?: string,
  ): Promise<{ response: string; sessionId?: string; agentId?: string; classification: MessageClassification; metadata?: ResponseMetadata }> {
    // Trajectory recorder — observes this run for later eval/fine-tuning.
    // Constructed early so the sessionId below can overwrite it.
    let trajectory: TrajectoryRecorder | null = null;
    try {
      const registry = getModelRegistry();
      const defaultModel = await registry.getDefaultModel();
      if (!defaultModel) {
        const allModels = await registry.getAllModels();
        if (allModels.length === 0) {
          return {
            response: 'No model configured. Please add one in the Models page.',
            classification: { type: 'casual', confidence: 0 },
          };
        }
      }

      const resolvedSessionId = await resolveSession(sessionId, userId, channel || 'api');

      trajectory = new TrajectoryRecorder({
        rootSessionId: resolvedSessionId,
        userId,
        userMessage: message,
        channel,
        expertId,
      });

      // Auto-title sessions with generic names
      const session = await sessionRepository.findById(resolvedSessionId);
      if (session) {
        const genericTitles = ['new chat', 'untitled', 'webchat conversation', 'telegram conversation', 'api conversation', 'slack conversation', 'teams conversation'];
        const currentTitle = (session.title || '').toLowerCase().trim();
        if (!currentTitle || genericTitles.includes(currentTitle) || currentTitle.endsWith(' conversation')) {
          const autoTitle = message.slice(0, 80).replace(/\n/g, ' ').trim();
          if (autoTitle) {
            sessionRepository.update(resolvedSessionId, { title: autoTitle }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in service'));
          }
        }
      }

      // Token budget check
      const config = getConfig();
      const tokenBudget = (session?.context as Record<string, unknown>)?.tokenBudget as number || config.agent.maxTokenBudget;
      const sessionTokens = session?.tokenCount || 0;
      if (tokenBudget > 0) {
        if (sessionTokens >= tokenBudget) {
          return {
            response: `Session token budget (${tokenBudget.toLocaleString()}) exhausted. Start a new session to continue.`,
            sessionId: resolvedSessionId,
            classification: { type: 'casual', confidence: 1 },
          };
        }
        if (sessionTokens >= tokenBudget * 0.8) {
          this.emit({
            type: 'status_update',
            sessionId: resolvedSessionId,
            userId,
            data: { message: `Token usage at ${Math.round((sessionTokens / tokenBudget) * 100)}% of budget`, stage: 'budget_warning' },
            timestamp: new Date(),
          });
        }
      }

      // Input guard
      const inputGuard = guardInput(message);
      if (inputGuard.action === 'block') {
        coreLogger.warn({ flags: inputGuard.flags, sessionId }, 'Input guard blocked message');
        const blockResponse = `I can't process this request: ${inputGuard.blockReason}`;
        await messageRepository.create({ sessionId: resolvedSessionId, role: 'user', content: message });
        await messageRepository.create({ sessionId: resolvedSessionId, role: 'assistant', content: blockResponse });
        return {
          response: blockResponse,
          sessionId: resolvedSessionId,
          classification: { type: 'casual' as const, confidence: 1, complexity: 'simple' as const },
        };
      }
      if (inputGuard.action === 'warn') {
        coreLogger.info({ flags: inputGuard.flags, sessionId }, 'Input guard flagged message');
      }

      // Command interception (works across all channels)
      try {
        // Provide a notify callback so commands can send intermediate messages
        const commandNotify = async (msg: string) => {
          this.emit({
            type: 'status_update',
            sessionId: resolvedSessionId,
            userId,
            data: { message: msg, stage: 'command' },
            timestamp: new Date(),
          });
          await messageRepository.create({ sessionId: resolvedSessionId, role: 'assistant', content: msg });
        };
        const commandResponse = await handleCommand(message, resolvedSessionId, userId, commandNotify);
        if (commandResponse) {
          return {
            response: commandResponse,
            sessionId: resolvedSessionId,
            classification: { type: 'casual' as const, confidence: 1 },
          };
        }
      } catch (cmdErr) {
        coreLogger.error({ err: cmdErr }, 'Command handler error');
      }

      // Plan execution: detect "go" after a plan was completed in this session
      // Re-read session fresh to avoid race conditions with concurrent "go" messages
      const freshSessionForPlan = await sessionRepository.findById(resolvedSessionId);
      const sessionCtx = (freshSessionForPlan?.context as Record<string, any>) || {};
      const planState = sessionCtx.planningState;
      if (planState?.brief && !planState.active && !planState.executed && /^(go|start|execute|run|do it|let'?s ?go)$/i.test(message.trim())) {
        // Check if an orchestrator is already running for this session
        const agentManager = getAgentManager();
        const sessionAgents = agentManager.getBySession(resolvedSessionId);
        const runningOrchestrator = sessionAgents.find(a => a.getStatus() === 'running' && a.getContext().role === 'orchestrator');
        if (runningOrchestrator) {
          const response = 'A plan is already being executed. Use `/status` to check progress or `/stop` to cancel it.';
          await messageRepository.create({ sessionId: resolvedSessionId, role: 'user', content: message });
          await messageRepository.create({ sessionId: resolvedSessionId, role: 'assistant', content: response });
          return { response, sessionId: resolvedSessionId, classification: { type: 'casual' as const, confidence: 1 } };
        }

        // Clear planningState entirely — the brief is passed to the orchestrator below.
        // Keeping stale plan data in session context causes models to reference it in future messages.
        await sessionRepository.update(resolvedSessionId, {
          context: { ...sessionCtx, planningState: undefined },
        });
        coreLogger.info({ sessionId: resolvedSessionId }, 'Executing plan via orchestrator');

        await messageRepository.create({ sessionId: resolvedSessionId, role: 'user', content: message });
        await sessionRepository.incrementMessageCount(resolvedSessionId);

        // Send immediate feedback before the long-running orchestrator starts
        const startMessage = 'Starting plan execution... Use `/status` to check progress.';
        await messageRepository.create({ sessionId: resolvedSessionId, role: 'assistant', content: startMessage });
        // Emit so WebSocket/Telegram can show it immediately
        this.emit({
          type: 'status_update',
          sessionId: resolvedSessionId,
          userId,
          data: { message: startMessage, stage: 'Starting' },
          timestamp: new Date(),
        });

        const planMessage = `Execute this project plan. Follow the brief and use the appropriate tools and agents:\n\n${planState.brief}`;
        const classification = classifyMessage(planMessage);
        const { response, agentId, sources: _planSources } = await this.runOrchestrator(
          resolvedSessionId, userId, planMessage, classification, inputGuard.flags, channel,
        );
        void _planSources;
        const outputCheck = guardOutput(response, inputGuard.flags);
        const finalResponse = outputCheck.action === 'replace' ? outputCheck.response : response;
        await messageRepository.create({ sessionId: resolvedSessionId, role: 'assistant', content: finalResponse });
        await sessionRepository.incrementMessageCount(resolvedSessionId);
        return { response: finalResponse, sessionId: resolvedSessionId, agentId, classification };
      }

      // Expert bypass
      if (expertId) {
        const expertResult = await handleExpertMessage(expertId, message, resolvedSessionId, userId, this.deps, inputGuard.flags);
        const outputCheck = guardOutput(expertResult.response, inputGuard.flags);
        if (outputCheck.action === 'replace') {
          coreLogger.warn({ flags: outputCheck.flags, sessionId }, 'Output guard replaced expert response');
          return { ...expertResult, response: outputCheck.response };
        }
        return expertResult;
      }

      const classification = classifyMessage(message);
      coreLogger.info(
        { sessionId, classification: classification.type, confidence: classification.confidence, channel },
        'Message classified',
      );

      if (classification.type === 'casual' && classification.confidence >= 0.7) {
        // Emit worker_spawned so channel feedback shows a reaction (even for direct responses)
        this.emit({
          type: 'worker_spawned',
          sessionId: resolvedSessionId,
          userId,
          data: { role: 'general', workerId: `direct-${Date.now()}`, model: 'direct' },
          timestamp: new Date(),
        });

        const { response, metadata } = await directResponse(
          message, resolvedSessionId, userId, this.modelSelector, classification.complexity, inputGuard.flags,
        );

        const outputCheck = guardOutput(response, inputGuard.flags);
        const finalResponse = outputCheck.action === 'replace' ? outputCheck.response : response;
        if (outputCheck.action === 'replace') {
          coreLogger.warn({ flags: outputCheck.flags, sessionId }, 'Output guard replaced casual response');
        }

        // Emit worker_completed so channel feedback shows ✅
        this.emit({
          type: 'worker_completed',
          sessionId: resolvedSessionId,
          userId,
          data: { role: 'general', result: finalResponse },
          timestamp: new Date(),
        });

        maybeCompactSession(resolvedSessionId).catch(err =>
          coreLogger.error({ err, sessionId: resolvedSessionId }, 'Session compaction failed'),
        );

        return { response: finalResponse, sessionId: resolvedSessionId, classification, metadata };
      }

      if (classification.type === 'approval') {
        const resolved = this.approvalManager.tryResolveFromMessage(message);
        if (resolved) {
          return { response: 'Got it, continuing...', sessionId: resolvedSessionId, classification };
        }
      }

      const startTime = Date.now();
      const { response, agentId, sources } = await this.runOrchestrator(
        resolvedSessionId, userId, message, classification, inputGuard.flags, channel,
      );

      const outputCheck = guardOutput(response, inputGuard.flags);
      let finalResponse = outputCheck.action === 'replace' ? outputCheck.response : response;
      if (outputCheck.action === 'replace') {
        coreLogger.warn({ flags: outputCheck.flags, sessionId }, 'Output guard replaced orchestrator response');
      }

      const activeSession = await sessionRepository.findById(resolvedSessionId);
      const showSources = (activeSession?.metadata as Record<string, unknown> | undefined)?.showSources !== false;
      if (showSources) {
        finalResponse = appendSources(finalResponse, sources);
      }

      await messageRepository.create({ sessionId: resolvedSessionId, role: 'assistant', content: finalResponse });
      await sessionRepository.incrementMessageCount(resolvedSessionId);

      maybeCompactSession(resolvedSessionId).catch(err =>
        coreLogger.error({ err, sessionId: resolvedSessionId }, 'Session compaction failed'),
      );

      if (trajectory) {
        trajectory.setClassification(classification, expertId);
        trajectory.finalize({ finalResponse, outcome: 'success' }).catch(err =>
          coreLogger.error({ err }, 'Trajectory finalize failed'),
        );
      }

      return {
        response: finalResponse,
        sessionId: resolvedSessionId,
        agentId,
        classification,
        metadata: { latencyMs: Date.now() - startTime },
      };
    } catch (error) {
      coreLogger.error({ error, sessionId, channel }, 'handleMessage failed');
      if (trajectory) {
        trajectory.finalize({
          finalResponse: '',
          outcome: 'failure',
          failureReason: (error as Error).message,
        }).catch(err => coreLogger.error({ err }, 'Trajectory finalize (failure path) failed'));
      }
      return {
        response: `I encountered an error processing your message: ${(error as Error).message}`,
        classification: { type: 'casual', confidence: 0 },
      };
    }
  }

  // ── Orchestrator agent ───────────────────────────────────────────

  private async runOrchestrator(
    sessionId: string,
    userId: string,
    message: string,
    classification: MessageClassification,
    guardFlags: string[] = [],
    channel?: string,
  ): Promise<{ response: string; agentId: string; sources: string[] }> {
    const agentManager = getAgentManager();
    const modelName = await this.modelSelector.selectForOrchestration();

    const orchestratorConfig = getRoleConfig('orchestrator');

    // Build the swarm root node AgentNode up front so meta-tools can bind to
    // it. The actual DB row is written once we know the agentId (post-spawn).
    // The orchestrator's allowed tool ids is the superset of its role's tools
    // plus the meta-tools it owns.
    const orchestratorAbortController = new AbortController();
    const orchestratorAllowedToolIds = new Set<string>();
    // Meta-tool ids that the orchestrator owns by construction.
    for (const name of ['spawn_child', 'create_pipeline', 'list_pipeline_templates', 'filter_pii', 'request_user_approval', 'send_status_update']) {
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

    const metaTools = createMetaTools(this, { parentNode });

    let systemPrompt = orchestratorConfig.systemPromptTemplate;
    if (guardFlags.length > 0) {
      systemPrompt += buildSecurityReminder(guardFlags);
    }

    const session = await sessionRepository.findById(sessionId);
    const sessionCtxData = session?.context as SessionContext | undefined;
    const clearedAt = sessionCtxData?.clearedAt ? new Date(sessionCtxData.clearedAt) : undefined;
    const sessionSummary = sessionCtxData?.compactedSummary;
    const sources: string[] = [];
    if (sessionSummary && !clearedAt) {
      systemPrompt += `\n\nPrevious conversation summary:\n${sessionSummary}`;
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
      systemPrompt += `\n\nRecent conversation history (last ${recentHistory.length} messages):\n${historyLines.join('\n\n')}`;
    }

    if (classification.topic) {
      systemPrompt += `\n\nThe user's message has been pre-classified as a "${classification.topic}" topic (confidence: ${classification.confidence.toFixed(2)}). Use this as a hint for the child role when calling spawn_child. Prefer spawn_child (single or multiple calls per turn) for nearly all tasks — only use create_pipeline when the user explicitly asks for a multi-stage workflow with handover (e.g., "research then implement then review").`;
    }
    if (classification.type === 'ambiguous') {
      systemPrompt += `\n\nThe user's message could not be confidently classified. Analyze it yourself and decide the best course of action.`;
    }

    // Inject workspace awareness
    const sessionCtx = session?.context as import('@/db/schema/sessions').SessionContext | undefined;
    const isDevMode = sessionCtx?.devMode === true && !!sessionCtx.projectPath;

    if (isDevMode) {
      // Dev mode: focused on a specific project
      const projectPath = sessionCtx!.projectPath!;
      const projectName = sessionCtx!.projectName || projectPath.split(/[/\\]/).pop() || 'project';
      let wsContext = `\n\nDEV MODE SESSION — Project: ${projectName}`;
      wsContext += `\nProject path: ${projectPath}`;

      // Load brief summary for orchestrator (lightweight)
      try {
        const summaryPath = resolve(projectPath, '.octipus/project-summary.md');
        const file = Bun.file(summaryPath);
        if (await file.exists()) {
          const brief = (await file.text()).slice(0, 500);
          wsContext += `\nProject overview: ${brief}`;
        }
      } catch (err) { coreLogger.error({ err }, 'silent failure in service'); }

      wsContext += `\n\nAll worker tasks MUST target this project. Always include the full path "${projectPath}" in every worker task description. The user does not need to specify the project — it is implicit.`;
      wsContext += `\n\nFor complex implementation tasks in this project, PREFER using the "Full Development Cycle" pipeline (via create_pipeline) to ensure thorough research, architecture planning, and testing.`;
      systemPrompt += wsContext;
    } else {
      // Normal mode: generic workspace awareness
      const wsConfig = getConfig();
      const wsRoot = resolve(wsConfig.workspace.rootPath);
      const wsAdditional = wsConfig.workspace.additionalPaths?.map((p: string) => resolve(p)).filter(Boolean) || [];
      try {
        const { readdirSync, statSync: statS } = await import('fs');
        const dirs = readdirSync(wsRoot)
          .filter(name => !name.startsWith('.') && statS(resolve(wsRoot, name)).isDirectory())
          .map(name => `  - ${name}/`);
        let wsContext = `\nWORKSPACE: Root is ${wsRoot}`;
        if (dirs.length > 0 && dirs.length <= 30) {
          wsContext += `\nProjects:\n${dirs.join('\n')}`;
        }
        if (wsAdditional.length > 0) {
          wsContext += `\nAdditional paths: ${wsAdditional.join(', ')}`;
        }
        wsContext += `\n\nIMPORTANT: When the user references "this project" or a project by name, resolve it to the FULL ABSOLUTE PATH and include that path explicitly in every worker task description. For example, if the user says "audit this project (octipus)", your task descriptions must say "audit the project at ${wsRoot}/octipus". Workers do NOT know which project the user means unless you tell them the exact path.`;
        systemPrompt += wsContext;
      } catch {
        systemPrompt += `\nWORKSPACE: ${wsRoot}`;
      }
    }

    // Hook-triggered tasks get a longer timeout since they run unattended.
    const orchConfig = getConfig().orchestrator;
    const orchestratorTimeout = channel === 'hook'
      ? orchConfig.orchestratorHookTimeoutMs
      : orchConfig.orchestratorTimeoutMs;

    const worker = await agentManager.spawn({
      sessionId,
      userId,
      topic: orchestratorConfig.defaultTopic,
      model: modelName,
      role: 'orchestrator',
      systemPrompt,
      tools: metaTools,
      maxIterations: 25,
      timeout: orchestratorTimeout,
      // Seed the user's raw request so the spawner can forward it verbatim
      // to every child. Without this, children only see the orchestrator's
      // paraphrased taskBrief and drift into hallucinations.
      contextMetadata: { originalRequest: message },
    });

    const agentId = worker.getContext().id;

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

    this.emit({
      type: 'worker_spawned',
      sessionId,
      userId,
      data: { agentId, role: 'orchestrator', model: modelName },
      timestamp: new Date(),
    });

    const orchStartTime = Date.now();
    try {
      this._lastWorkerResult = null;
      const response = await worker.run(message);

      // Safety net: some LLMs (weaker/chatty ones) end their run by calling
      // `send_status_update` instead of returning plain text, leaving
      // `response` empty. Fall back to the last status message so the user
      // sees SOMETHING rather than a blank reply. The orchestrator prompt
      // tells the LLM not to do this, but the safety net is belt-and-braces.
      let finalResponse = this._lastWorkerResult || response;
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
      this._lastWorkerResult = null;

      this.emit({
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
      this._lastWorkerResult = null;
      coreLogger.error({ error, agentId }, 'Orchestrator agent failed');

      const errMsg = (error as Error).message || '';
      const wasStopped = errMsg.includes('aborted') || errMsg.includes('stopped') || worker.getStatus() === 'stopped';

      this.emit({
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
          },
        });
      } catch (err) {
        coreLogger.debug({ err, agentId }, 'swarm root failure bookkeeping skipped');
      }

      const response = wasStopped
        ? 'Task was stopped. Would you like to adjust the request or start something new?'
        : `I encountered an error while processing your request: ${errMsg}`;
      return { response, agentId, sources };
    }
  }

  // ── Worker spawning (internal — used by pipeline stages only) ────

  async spawnWorker(
    role: string,
    task: string,
    input: string,
    context: AgentContext,
    overrides?: { systemPrompt?: string; model?: string },
  ): Promise<unknown> {
    return spawnWorker(role, task, input, context, this.deps, overrides);
  }

  // ── Pipeline (called by create_pipeline meta-tool) ───────────────

  async createAndRunPipeline(
    title: string,
    type: string,
    description: string,
    context: AgentContext,
    options?: { maxRetries?: number },
  ): Promise<unknown> {
    const { getPipelineManager } = await import('./pipeline-manager');
    const pipelineManager = getPipelineManager();

    coreLogger.info({ title, type, description, maxRetries: options?.maxRetries }, 'Creating pipeline');

    return pipelineManager.createAndRun(
      context.id,
      context.sessionId,
      context.userId,
      title,
      type,
      description,
      context,
      options,
    );
  }

  // ── Approval delegation ──────────────────────────────────────────

  async requestApproval(
    summary: string,
    question: string,
    context: AgentContext,
    options?: string[],
  ): Promise<unknown> {
    return this.approvalManager.requestApproval(
      summary, question, context,
      (event) => this.emit(event),
      options,
    );
  }

  resolveApproval(requestId: string, approved: boolean, response?: string): boolean {
    return this.approvalManager.resolveApproval(requestId, approved, response);
  }

  getPendingApprovals(sessionId?: string): ApprovalRequest[] {
    return this.approvalManager.getPendingApprovals();
  }

  // ── Steering ────────────────────────────────────────────────────

  /**
   * Inject a steering message into the active agent for a session.
   * Returns true if an active running agent was found and steered.
   */
  steer(sessionId: string, message: import('@/core/types').AgentMessage): boolean {
    const agentManager = getAgentManager();
    const sessionAgents = agentManager.getBySession(sessionId);
    const running = sessionAgents.find(a => a.getStatus() === 'running');
    if (!running) return false;

    // Only AgentWorker supports steering (CLIAgentWorker is autonomous)
    if ('steer' in running && typeof (running as any).steer === 'function') {
      (running as any).steer(message);
      coreLogger.info({ sessionId, agentId: running.getContext().id }, 'Steering message injected');
      return true;
    }
    return false;
  }

  // ── Utility delegation ───────────────────────────────────────────

  async sendStatusUpdate(
    message: string,
    context: AgentContext,
    stage?: string,
    progress?: number,
  ): Promise<unknown> {
    this.emit({
      type: 'status_update',
      sessionId: context.sessionId,
      userId: context.userId,
      data: { message, stage, progress, agentId: context.id },
      timestamp: new Date(),
    });
    return { sent: true, message };
  }

  filterPIIText(text: string): unknown {
    return filterPII(text);
  }
}

// Singleton
let instance: OrchestratorService | null = null;

export function getOrchestratorService(): OrchestratorService {
  if (!instance) {
    instance = new OrchestratorService();
  }
  return instance;
}
