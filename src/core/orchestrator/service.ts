import { resolve } from 'path';
import { getAgentManager } from '@/core/agent-manager';
import type { AgentContext } from '@/core/types';
import { getConfig } from '@/config';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { sessionRepository } from '@/db/repositories/session-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { classifyMessage } from './classifier';
import { guardInput, buildSecurityReminder } from './input-guard';
import { guardOutput } from './output-guard';
import { filterPII } from './pii-filter';
import { createMetaTools } from './meta-tools';
import { getRoleConfig } from './roles';
import { ApprovalManager } from './approval-manager';
import { ModelSelector } from './model-selector';
import { resolveSession } from './session-resolver';
import { directResponse } from './direct-response';
import { maybeCompactSession } from './session-compaction';
import { handleExpertMessage, spawnWorker, spawnTeam } from './worker-spawner';
import { handleCommand } from '@/core/commands';
import type { ApprovalRequest } from './approval-manager';
import type { MessageClassification, ResponseMetadata } from './types';
import type { SessionContext } from '@/db/schema/sessions';

interface OrchestratorEventHandler {
  (event: OrchestratorEvent): void;
}

export interface OrchestratorEvent {
  type: 'chat_response' | 'status_update' | 'approval_required' | 'worker_spawned' | 'worker_completed' | 'pipeline_event' | 'team_started' | 'team_completed';
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

  onEvent(handler: OrchestratorEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: OrchestratorEvent): void {
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

      // Auto-title sessions with generic names
      const session = await sessionRepository.findById(resolvedSessionId);
      if (session) {
        const genericTitles = ['new chat', 'untitled', 'webchat conversation', 'telegram conversation', 'api conversation', 'slack conversation', 'teams conversation'];
        const currentTitle = (session.title || '').toLowerCase().trim();
        if (!currentTitle || genericTitles.includes(currentTitle) || currentTitle.endsWith(' conversation')) {
          const autoTitle = message.slice(0, 80).replace(/\n/g, ' ').trim();
          if (autoTitle) {
            sessionRepository.update(resolvedSessionId, { title: autoTitle }).catch(() => {});
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

        // Mark as executed BEFORE spawning to prevent race conditions
        await sessionRepository.update(resolvedSessionId, {
          context: { ...sessionCtx, planningState: { ...planState, executed: true } },
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
        const { response, agentId } = await this.runOrchestrator(
          resolvedSessionId, userId, planMessage, classification, inputGuard.flags, channel,
        );
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
        const { response, metadata } = await directResponse(
          message, resolvedSessionId, userId, this.modelSelector, classification.complexity, inputGuard.flags,
        );

        const outputCheck = guardOutput(response, inputGuard.flags);
        const finalResponse = outputCheck.action === 'replace' ? outputCheck.response : response;
        if (outputCheck.action === 'replace') {
          coreLogger.warn({ flags: outputCheck.flags, sessionId }, 'Output guard replaced casual response');
        }

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
      const { response, agentId } = await this.runOrchestrator(
        resolvedSessionId, userId, message, classification, inputGuard.flags, channel,
      );

      const outputCheck = guardOutput(response, inputGuard.flags);
      const finalResponse = outputCheck.action === 'replace' ? outputCheck.response : response;
      if (outputCheck.action === 'replace') {
        coreLogger.warn({ flags: outputCheck.flags, sessionId }, 'Output guard replaced orchestrator response');
      }

      await messageRepository.create({ sessionId: resolvedSessionId, role: 'assistant', content: finalResponse });
      await sessionRepository.incrementMessageCount(resolvedSessionId);

      maybeCompactSession(resolvedSessionId).catch(err =>
        coreLogger.error({ err, sessionId: resolvedSessionId }, 'Session compaction failed'),
      );

      return {
        response: finalResponse,
        sessionId: resolvedSessionId,
        agentId,
        classification,
        metadata: { latencyMs: Date.now() - startTime },
      };
    } catch (error) {
      coreLogger.error({ error, sessionId, channel }, 'handleMessage failed');
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
  ): Promise<{ response: string; agentId: string }> {
    const agentManager = getAgentManager();
    const modelName = await this.modelSelector.selectForOrchestration();

    const orchestratorConfig = getRoleConfig('orchestrator');
    const metaTools = createMetaTools(this);

    let systemPrompt = orchestratorConfig.systemPromptTemplate;
    if (guardFlags.length > 0) {
      systemPrompt += buildSecurityReminder(guardFlags);
    }

    const session = await sessionRepository.findById(sessionId);
    const sessionSummary = (session?.context as SessionContext)?.compactedSummary;
    if (sessionSummary) {
      systemPrompt += `\n\nPrevious conversation summary:\n${sessionSummary}`;
    }

    if (classification.topic) {
      systemPrompt += `\n\nThe user's message has been pre-classified as a "${classification.topic}" topic (confidence: ${classification.confidence.toFixed(2)}). Use this as a hint for choosing the worker role. Prefer spawn_worker for most tasks — only use create_pipeline when the user explicitly asks for a multi-stage workflow (e.g., "research then implement then review").`;
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
        const summaryPath = resolve(projectPath, '.assistant/project-summary.md');
        const file = Bun.file(summaryPath);
        if (await file.exists()) {
          const brief = (await file.text()).slice(0, 500);
          wsContext += `\nProject overview: ${brief}`;
        }
      } catch {}

      wsContext += `\n\nAll worker tasks MUST target this project. Always include the full path "${projectPath}" in every worker task description. The user does not need to specify the project — it is implicit.`;
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
        wsContext += `\n\nIMPORTANT: When the user references "this project" or a project by name, resolve it to the FULL ABSOLUTE PATH and include that path explicitly in every worker task description. For example, if the user says "audit this project (assistant)", your task descriptions must say "audit the project at ${wsRoot}/assistant". Workers do NOT know which project the user means unless you tell them the exact path.`;
        systemPrompt += wsContext;
      } catch {
        systemPrompt += `\nWORKSPACE: ${wsRoot}`;
      }
    }

    // Hook-triggered tasks get a longer timeout (45 min) since they run unattended
    const orchestratorTimeout = channel === 'hook' ? 2700000 : 1800000;

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
    });

    const agentId = worker.getContext().id;

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
      const finalResponse = this._lastWorkerResult || response;
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

      return { response: finalResponse, agentId };
    } catch (error) {
      this._lastWorkerResult = null;
      coreLogger.error({ error, agentId }, 'Orchestrator agent failed');

      this.emit({
        type: 'worker_completed',
        sessionId,
        userId,
        data: {
          workerId: agentId,
          role: 'orchestrator',
          result: '',
          model: modelName,
          status: 'failed',
          durationMs: Date.now() - orchStartTime,
          totalTokens: worker.getTotalTokens(),
          iterations: worker.getIteration(),
          error: (error as Error).message,
        },
        timestamp: new Date(),
      });

      const errMsg = (error as Error).message || '';
      const wasStopped = errMsg.includes('aborted') || errMsg.includes('stopped') || worker.getStatus() === 'stopped';
      const response = wasStopped
        ? 'Task was stopped. Would you like to adjust the request or start something new?'
        : `I encountered an error while processing your request: ${errMsg}`;
      return { response, agentId };
    }
  }

  // ── Worker/Team spawning (delegated to worker-spawner module) ────

  async spawnWorker(
    role: string,
    task: string,
    input: string,
    context: AgentContext,
    overrides?: { systemPrompt?: string; model?: string },
  ): Promise<unknown> {
    return spawnWorker(role, task, input, context, this.deps, overrides);
  }

  async spawnTeam(
    members: Array<{ role: string; task: string; input?: string }>,
    context: AgentContext,
  ): Promise<unknown> {
    return spawnTeam(members, context, this.deps);
  }

  // ── Pipeline (called by create_pipeline meta-tool) ───────────────

  async createAndRunPipeline(
    title: string,
    type: string,
    description: string,
    context: AgentContext,
  ): Promise<unknown> {
    const { getPipelineManager } = await import('./pipeline-manager');
    const pipelineManager = getPipelineManager();

    coreLogger.info({ title, type, description }, 'Creating pipeline');

    return pipelineManager.createAndRun(
      context.id,
      context.sessionId,
      context.userId,
      title,
      type,
      description,
      context,
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
