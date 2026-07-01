import { getConfig } from '@/config';
import { getAgentManager } from '@/core/agent-manager';
import { handleCommand } from '@/core/commands';
import { renderMemoriesBlock, retrieveForContext, updateMemoriesAfterTurn } from '@/core/memory';
import { type AttachedFileRef, buildAttachedFilesContext } from '@/core/session-files';
import { TrajectoryRecorder } from '@/core/trajectories/recorder';
import type { AgentContext } from '@/core/types';
import { WorkspaceFS } from '@/security/workspace-fs';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import type { ApprovalRequest } from './approval-manager';
import { ApprovalManager } from './approval-manager';
import { classifyMessage } from './classifier';
import { directResponse } from './direct-response';
import { guardInput } from './input-guard';
import { ModelSelector } from './model-selector';
import { runOrchestrator } from './orchestrator-runner';
import { guardOutput } from './output-guard';
import { filterPII } from './pii-filter';
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
      getLastWorkerResult: () => this._lastWorkerResult,
    };
  }

  // ── Main entry point ─────────────────────────────────────────────

  async handleMessage(
    sessionId: string,
    userId: string,
    message: string,
    channel?: string,
    expertId?: string,
    /**
     * Session files the user attached to this turn (edit-and-continue). Their
     * *current* contents are re-read here and injected into the turn's context
     * so the agent operates on the live file, not a stale transcript copy.
     */
    attachedFiles: AttachedFileRef[] = [],
    /**
     * Chat/work split (Thread 3): the user's per-message override of the
     * deliverable mode. When set it wins over the classifier heuristic;
     * undefined ⇒ use the heuristic.
     */
    forcedOutputMode?: 'inline' | 'file',
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
          // No model. Speak in the active persona's voice. Fall back to
          // the dry default if the persona system isn't loaded yet —
          // this codepath fires on first-boot before settings exist.
          let name = 'Octipus';
          try {
            const { resolvePersonaForUser } = await import('@/core/personas/resolver');
            const persona = await resolvePersonaForUser(userId);
            name = persona.name;
          } catch { /* registry not ready yet — base name is fine */ }
          const text =
            `${name} has no engine. The arms are idle.\n\n` +
            'To wire one up, run one of:\n' +
            '  • `bun run setup`   (interactive — picks Ollama / LiteLLM / direct provider)\n' +
            '  • `octi doctor`     (shows what is missing)\n' +
            '  • open the Models page in the web UI\n\n' +
            'Once a model is bound to the `general` topic, every turn after this one works.';
          return {
            response: text,
            classification: { type: 'casual', confidence: 0 },
          };
        }
      }

      const resolvedSessionId = await resolveSession(sessionId, userId, channel || 'api');

      // Resolve the principal's default workspace once and thread it
      // through every spawn / memory call below. Memory-redesign Phase B
      // needs the workspace_id on task_state rows and memories rows; the
      // agent worker carries it via `AgentContext.workspaceId` so the
      // recorder/extractor can read it without re-resolving per turn.
      let workspaceId: string | null = null;
      try {
        const { getOrgWorkspaceManager } = await import('@/security/orgs');
        const ws = await getOrgWorkspaceManager().ensureDefaultWorkspace(userId);
        workspaceId = ws.id;
      } catch (err) {
        coreLogger.debug({ err, userId }, 'workspace resolve failed — proceeding with null');
      }

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

        // Memory-redesign Phase D — also fire on plan execution. The
        // plan often references the user's preferences ("use my usual
        // stack"); withholding memory here would degrade plan quality.
        let planMemoryBlock = '';
        try {
          const memories = await retrieveForContext({
            userId,
            agentScope: classification.topic ?? null,
            limit: 12,
          });
          planMemoryBlock = renderMemoriesBlock(memories);
        } catch (err) {
          coreLogger.warn({ err }, 'memory.retrieveForContext failed on plan path');
        }

        const { response, agentId, sources: _planSources } = await this.runOrchestrator(
          resolvedSessionId, userId, planMessage, classification, inputGuard.flags, channel,
          planMemoryBlock,
          workspaceId,
        );
        void _planSources;
        const outputCheck = guardOutput(response, inputGuard.flags);
        const finalResponse = outputCheck.action === 'replace' ? outputCheck.response : response;
        await messageRepository.create({ sessionId: resolvedSessionId, role: 'assistant', content: finalResponse });
        await sessionRepository.incrementMessageCount(resolvedSessionId);

        // Plan-execute path also extracts memory from the original
        // user "go" message. Even though the message is short, the
        // executor LLM sees the brief — facts in the brief should
        // get a chance to be extracted. Fire-and-forget like the
        // main path.
        updateMemoriesAfterTurn({
          userId,
          workspaceId,
          agentScope: classification.topic ?? null,
          userMessage: planState.brief,
        }).catch((err) => coreLogger.warn({ err }, 'memory.updateAfterTurn failed on plan path'));

        return { response: finalResponse, sessionId: resolvedSessionId, agentId, classification };
      }

      // Edit-and-continue (design Thread 2): re-read any files the user
      // attached to this turn and inject their CURRENT contents so the agent
      // operates on the live file, not a stale copy from the transcript. Built
      // BEFORE the expert bypass so a preset-selected turn gets it too. The
      // block is self-separating, the same way `renderMemoriesBlock` is.
      let attachedFilesBlock = '';
      if (attachedFiles.length > 0) {
        try {
          const fs = WorkspaceFS.forAgent({ userId });
          attachedFilesBlock = await buildAttachedFilesContext(fs, attachedFiles);
        } catch (err) {
          coreLogger.warn({ err, sessionId }, 'attached-file context build failed — proceeding without it');
        }
      }

      // Expert bypass
      if (expertId) {
        // Chat/work split (Thread 3): preset turns honor the toggle too — the
        // forced mode wins, else the classifier heuristic for this message.
        const expertMode = forcedOutputMode ?? classifyMessage(message).outputMode ?? 'inline';
        const expertResult = await handleExpertMessage(
          expertId, message, resolvedSessionId, userId, this.deps, inputGuard.flags, workspaceId, attachedFilesBlock,
          { mode: expertMode, forced: forcedOutputMode !== undefined },
        );
        const outputCheck = guardOutput(expertResult.response, inputGuard.flags);
        if (outputCheck.action === 'replace') {
          coreLogger.warn({ flags: outputCheck.flags, sessionId }, 'Output guard replaced expert response');
          return { ...expertResult, response: outputCheck.response };
        }
        return expertResult;
      }

      const classification = classifyMessage(message);
      // Chat/work split (Thread 3): resolve the effective deliverable mode (the
      // per-message toggle wins over the heuristic) and reflect it on the
      // classification so downstream + the returned value agree.
      const effectiveOutputMode: 'inline' | 'file' = forcedOutputMode ?? classification.outputMode ?? 'inline';
      classification.outputMode = effectiveOutputMode;
      const outputForced = forcedOutputMode !== undefined;
      coreLogger.info(
        { sessionId, classification: classification.type, confidence: classification.confidence, outputMode: effectiveOutputMode, channel },
        'Message classified',
      );

      // Memory-redesign Phase D — best-effort long-term memory
      // injection. Auto-no-ops when the memories table is empty or
      // the embedding provider is down, so zero blast radius if
      // something upstream is misconfigured. Recorded after the turn
      // (fire-and-forget) via `fireMemoryUpdate`; the extractor
      // short-circuits unless a model is bound to topic
      // "memory_extraction", so this costs nothing until the operator
      // opts in.
      //
      // Scope: classifier topic when available, NULL otherwise. The
      // repository filter is OR(NULL, scope) so passing a topic still
      // returns globally-scoped facts. Writing with the topic lets a
      // future specialist running the same topic see role-relevant
      // memories without dragging unrelated rows into every turn.
      const memoryScope = classification.topic ?? null;
      let memoryBlock = '';
      try {
        const memories = await retrieveForContext({
          userId,
          agentScope: memoryScope,
          limit: 12,
        });
        memoryBlock = renderMemoriesBlock(memories);
      } catch (err) {
        coreLogger.warn({ err }, 'memory.retrieveForContext failed — proceeding without memories');
      }

      // Combine long-term memory with the attached-file block built above
      // (before the expert bypass). Both are self-separating, so the casual and
      // orchestrator paths get the live file contents in their system context.
      const turnContext = memoryBlock + attachedFilesBlock;
      const memoryCadence = getConfig().memory?.extractionCadence ?? 'per_turn';
      const fireMemoryUpdate = () => {
        // Cadence gate. `off` short-circuits before any work; the
        // `on_compaction` path is handled inside session-compaction.ts
        // so the per-turn path skips here.
        if (memoryCadence !== 'per_turn') return;
        // Best-effort provenance: pick up the just-persisted user
        // message id. Returns undefined when persistence hasn't landed
        // yet (e.g. the worker persists asynchronously) — that's fine,
        // the column is nullable on purpose.
        void (async () => {
          let sourceMessageId: string | null = null;
          let recentTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
          try {
            const latest = await messageRepository.findRecentBySession(resolvedSessionId, 4, ['user', 'assistant']);
            const lastUser = [...latest].reverse().find((m) => m.role === 'user' && m.content === message);
            sourceMessageId = lastUser?.id ?? null;
            recentTurns = latest
              .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
              .slice(-3)
              .map((m) => ({ role: m.role, content: m.content }));
          } catch (err) {
            coreLogger.debug({ err }, 'memory.updateAfterTurn: provenance lookup failed (non-fatal)');
          }
          try {
            await updateMemoriesAfterTurn({
              userId,
              workspaceId,
              agentScope: memoryScope,
              sourceMessageId,
              userMessage: message,
              recentTurns,
            });
          } catch (err) {
            coreLogger.warn({ err }, 'memory.updateAfterTurn failed (non-fatal)');
          }
        })();
      };

      // Chat/work split: a file-mode request (e.g. "write me a poem", which
      // classifies casual) must reach the orchestrator so a file is actually
      // produced — don't let the inline fast-path swallow it.
      if (classification.type === 'casual' && classification.confidence >= 0.7 && effectiveOutputMode !== 'file') {
        // Emit worker_spawned so channel feedback shows a reaction (even for direct responses).
        // Role label is 'octipus' (the persona itself answering casually), NOT a specialist
        // expert — the direct-response path doesn't pick an expert. UI badges treat this as
        // identity, not as a routing decision.
        // Stable id reused by the matching worker_completed below — the web
        // correlates the two by workerId. Without it the completion can't find
        // the spawned line, so it falls back to creating a second, 0ms
        // "octipus" entry (the spawned line meanwhile never closes).
        const directWorkerId = `direct-${Date.now()}`;
        this.emit({
          type: 'worker_spawned',
          sessionId: resolvedSessionId,
          userId,
          data: { role: 'octipus', workerId: directWorkerId, model: 'direct' },
          timestamp: new Date(),
        });

        const { response, metadata } = await directResponse(
          message, resolvedSessionId, userId, this.modelSelector, classification.complexity, inputGuard.flags,
          turnContext,
        );

        const outputCheck = guardOutput(response, inputGuard.flags);
        const finalResponse = outputCheck.action === 'replace' ? outputCheck.response : response;
        if (outputCheck.action === 'replace') {
          coreLogger.warn({ flags: outputCheck.flags, sessionId }, 'Output guard replaced casual response');
        }

        // Emit worker_completed so channel feedback shows ✅. Carries the same
        // workerId (and the measured latency) so the UI closes the single
        // spawned line instead of rendering a duplicate 0ms entry.
        this.emit({
          type: 'worker_completed',
          sessionId: resolvedSessionId,
          userId,
          data: { role: 'octipus', workerId: directWorkerId, model: 'direct', durationMs: metadata.latencyMs, result: finalResponse },
          timestamp: new Date(),
        });

        maybeCompactSession(resolvedSessionId).catch(err =>
          coreLogger.error({ err, sessionId: resolvedSessionId }, 'Session compaction failed'),
        );

        fireMemoryUpdate();
        return { response: finalResponse, sessionId: resolvedSessionId, classification, metadata };
      }

      if (classification.type === 'approval') {
        const resolved = this.approvalManager.tryResolveFromMessage(message, userId);
        if (resolved) {
          return { response: 'Got it, continuing...', sessionId: resolvedSessionId, classification };
        }
      }

      const startTime = Date.now();
      const { response, agentId, sources } = await this.runOrchestrator(
        resolvedSessionId, userId, message, classification, inputGuard.flags, channel,
        turnContext,
        workspaceId,
        { mode: effectiveOutputMode, forced: outputForced },
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

      fireMemoryUpdate();
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
    return runOrchestrator(
      this, this.deps,
      sessionId, userId, message, classification, guardFlags, channel,
      extraSystemContext, workspaceId, outputDirective,
    );
  }

  // ── Worker spawning (internal — used by pipeline stages only) ────

  async spawnWorker(
    role: string,
    task: string,
    input: string,
    context: AgentContext,
    overrides?: { systemPrompt?: string; model?: string; swarmParent?: import('./worker-spawner').WorkerSwarmParent },
  ): Promise<unknown> {
    return spawnWorker(role, task, input, context, this.deps, overrides);
  }

  // ── Pipeline (called by create_pipeline meta-tool) ───────────────

  async createAndRunPipeline(
    title: string,
    type: string,
    description: string,
    context: AgentContext,
    options?: { maxRetries?: number; params?: Record<string, unknown> },
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

  /** Pre-flight lookup so callers (chat route) can verify principal owns the request. */
  peekApproval(requestId: string): ApprovalRequest | null {
    return this.approvalManager.peek(requestId);
  }

  getPendingApprovals(forUserId?: string): ApprovalRequest[] {
    return this.approvalManager.getPendingApprovals(forUserId);
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
