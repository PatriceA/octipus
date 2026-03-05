import { getAgentManager } from '@/core/agent-manager';
import type { AgentContext } from '@/core/types';
import { getConfig } from '@/config';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { sessionRepository } from '@/db/repositories/session-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { classifyMessage } from './classifier';
import { filterPII } from './pii-filter';
import { createMetaTools } from './meta-tools';
import { getRoleConfig, getToolsForRole } from './roles';
import { getNotificationService } from '@/core/notification-service';
import { ApprovalManager } from './approval-manager';
import { ModelSelector } from './model-selector';
import { getResponseCache } from '@/core/response-cache';
import { compactMessagesWithSummary } from '@/utils/context-compaction';
import type { ApprovalRequest } from './approval-manager';
import type { AgentRole, WorkerResult, MessageClassification, ResponseMetadata } from './types';
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

  // ── Main entry point ─────────────────────────────────────────────

  async handleMessage(
    sessionId: string,
    userId: string,
    message: string,
    channel?: string,
    presetId?: string,
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

      const resolvedSessionId = await this.resolveSession(sessionId, userId, channel || 'api');

      // Token budget check
      const session = await sessionRepository.findById(resolvedSessionId);
      const tokenBudget = (session?.context as Record<string, unknown>)?.tokenBudget as number || 100_000;
      const sessionTokens = session?.tokenCount || 0;
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

      // Preset bypass: skip classification and orchestrator, spawn worker directly
      if (presetId) {
        return this.handlePresetMessage(presetId, message, resolvedSessionId, userId);
      }

      const classification = classifyMessage(message);
      coreLogger.info(
        { sessionId, classification: classification.type, confidence: classification.confidence, channel },
        'Message classified',
      );

      if (classification.type === 'casual' && classification.confidence >= 0.7) {
        const { response, metadata } = await this.directResponse(message, resolvedSessionId, userId, classification.complexity);

        this.maybeCompactSession(resolvedSessionId).catch(err =>
          coreLogger.error({ err, sessionId: resolvedSessionId }, 'Session compaction failed'),
        );

        return { response, sessionId: resolvedSessionId, classification, metadata };
      }

      if (classification.type === 'approval') {
        const resolved = this.approvalManager.tryResolveFromMessage(message);
        if (resolved) {
          return { response: 'Got it, continuing...', sessionId: resolvedSessionId, classification };
        }
      }

      const startTime = Date.now();
      const { response, agentId } = await this.runOrchestrator(resolvedSessionId, userId, message, classification);

      // Trigger async compaction check after response
      this.maybeCompactSession(resolvedSessionId).catch(err =>
        coreLogger.error({ err, sessionId: resolvedSessionId }, 'Session compaction failed'),
      );

      return {
        response,
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

  // ── Session resolution ───────────────────────────────────────────

  private async resolveSession(sessionId: string, userId: string, channel: string): Promise<string> {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(sessionId)) {
      return sessionId;
    }

    const parts = sessionId.split('-');
    const channelType = parts[0] || channel;
    const channelId = parts.slice(1).join('-') || sessionId;

    const existing = await sessionRepository.findByUserAndChannel(userId, channelType, channelId);
    if (existing) return existing.id;

    const session = await sessionRepository.create({
      userId,
      channelType,
      channelId,
      title: `${channelType} conversation`,
      status: 'active',
    });

    coreLogger.info({ sessionId: session.id, channelType, channelId }, 'Created new session for channel');
    return session.id;
  }

  // ── Preset-based direct worker spawning ─────────────────────────

  private async handlePresetMessage(
    presetId: string,
    message: string,
    sessionId: string,
    userId: string,
  ): Promise<{ response: string; sessionId: string; classification: MessageClassification; metadata?: ResponseMetadata }> {
    const { getDb } = await import('@/db/postgres');
    const db = getDb();
    const { presets } = await import('@/db/schema/presets');
    const { eq } = await import('drizzle-orm');

    const [preset] = await db.select().from(presets).where(eq(presets.id, presetId)).limit(1);
    if (!preset) {
      return {
        response: `Preset not found: ${presetId}`,
        sessionId,
        classification: { type: 'task', confidence: 1, complexity: 'simple' },
      };
    }

    const startTime = Date.now();
    const agentRole = preset.role as AgentRole;
    const context: AgentContext = {
      id: `preset-${Date.now()}`,
      sessionId,
      userId,
      model: preset.modelPreference || '',
      topic: preset.name,
      role: agentRole,
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: { presetId },
    };

    await messageRepository.create({ sessionId, role: 'user', content: message });
    await sessionRepository.incrementMessageCount(sessionId);

    try {
      const result = await this.spawnWorker(agentRole, message, '', context, {
        systemPrompt: preset.systemPrompt || undefined,
        model: preset.modelPreference || undefined,
      });

      const response = String(result);
      await messageRepository.create({ sessionId, role: 'assistant', content: response });
      await sessionRepository.incrementMessageCount(sessionId);

      return {
        response,
        sessionId,
        classification: { type: 'task', confidence: 1, complexity: 'moderate', topic: preset.role },
        metadata: { latencyMs: Date.now() - startTime },
      };
    } catch (error) {
      coreLogger.error({ error, presetId, role: agentRole }, 'Preset worker failed');
      return {
        response: `Preset worker failed: ${(error as Error).message}`,
        sessionId,
        classification: { type: 'task', confidence: 1 },
      };
    }
  }

  // ── Direct LLM response (casual messages) ────────────────────────

  private async directResponse(
    message: string,
    sessionId: string,
    userId: string,
    complexity: 'simple' | 'moderate' | 'complex' = 'moderate',
  ): Promise<{ response: string; metadata: ResponseMetadata }> {
    const startTime = Date.now();
    const client = getLiteLLMClient();

    // Select model based on complexity
    const modelName = await this.modelSelector.selectByComplexity(complexity);

    await messageRepository.create({ sessionId, role: 'user', content: message });
    await sessionRepository.incrementMessageCount(sessionId);

    // Check response cache for casual messages
    const cache = getResponseCache();
    const recentMessages = await messageRepository.findBySession(sessionId, 10, 0, ['user', 'assistant']);
    const recentContext = recentMessages.slice(0, 2).map(m => m.content).join('|');

    const cached = await cache.get(message, recentContext);
    if (cached) {
      await messageRepository.create({ sessionId, role: 'assistant', content: cached.response });
      await sessionRepository.incrementMessageCount(sessionId);
      return {
        response: cached.response,
        metadata: {
          model: cached.model,
          tokens: cached.tokens,
          latencyMs: Date.now() - startTime,
          cached: true,
        },
      };
    }

    try {
      const historyMessages = recentMessages.map(m => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
        timestamp: m.createdAt,
      }));

      // Prepend compacted summary if available
      const session = await sessionRepository.findById(sessionId);
      const summary = (session?.context as SessionContext)?.compactedSummary;
      const systemContent = summary
        ? `You are a friendly development assistant. Keep casual responses brief and helpful.\n\nPrevious conversation summary:\n${summary}`
        : 'You are a friendly development assistant. Keep casual responses brief and helpful.';

      const registry = getModelRegistry();
      const resolvedModel = await registry.getModelByModelId(modelName);
      const modelMeta = resolvedModel?.metadata as import('@/db/schema/models').ModelMetadata | null;

      const result = await client.complete({
        model: modelName,
        messages: [
          { role: 'system', content: systemContent, timestamp: new Date() },
          ...historyMessages,
        ],
        temperature: 0.7,
        maxTokens: 512,
        extraBody: modelMeta?.extraBody,
      });

      const tokens = result.usage?.totalTokens || 0;

      await messageRepository.create({ sessionId, role: 'assistant', content: result.content });
      await sessionRepository.incrementMessageCount(sessionId);

      // Cache the response
      await cache.set(message, recentContext, {
        response: result.content,
        model: modelName,
        tokens,
        cachedAt: Date.now(),
      });

      return {
        response: result.content,
        metadata: {
          model: modelName,
          tokens,
          latencyMs: Date.now() - startTime,
          cached: false,
        },
      };
    } catch (error) {
      coreLogger.error({ error, model: modelName }, 'Direct response failed');
      const errorMsg = `Sorry, I'm having trouble connecting to the language model (${modelName}). Please check that the model provider is running and configured correctly.`;
      await messageRepository.create({ sessionId, role: 'assistant', content: errorMsg });
      await sessionRepository.incrementMessageCount(sessionId);
      return {
        response: errorMsg,
        metadata: { model: modelName, latencyMs: Date.now() - startTime },
      };
    }
  }

  // ── Orchestrator agent ───────────────────────────────────────────

  private async runOrchestrator(
    sessionId: string,
    userId: string,
    message: string,
    classification: MessageClassification,
  ): Promise<{ response: string; agentId: string }> {
    const agentManager = getAgentManager();
    const modelName = await this.modelSelector.selectForOrchestration();

    const orchestratorConfig = getRoleConfig('orchestrator');
    const metaTools = createMetaTools(this);

    let systemPrompt = orchestratorConfig.systemPromptTemplate;

    // Prepend compacted summary if available
    const session = await sessionRepository.findById(sessionId);
    const sessionSummary = (session?.context as SessionContext)?.compactedSummary;
    if (sessionSummary) {
      systemPrompt += `\n\nPrevious conversation summary:\n${sessionSummary}`;
    }

    if (classification.suggestedPipeline) {
      systemPrompt += `\n\nThe user's message has been pre-classified as a "${classification.suggestedPipeline}" task (confidence: ${classification.confidence.toFixed(2)}). Use this as a hint for deciding how to delegate.`;
    }
    if (classification.type === 'ambiguous') {
      systemPrompt += `\n\nThe user's message could not be confidently classified. Analyze it yourself and decide the best course of action.`;
    }

    const config = getConfig();
    const workerTimeout = config.agent.defaultTimeout;

    const worker = await agentManager.spawn({
      sessionId,
      userId,
      topic: orchestratorConfig.defaultTopic,
      model: modelName,
      role: 'orchestrator',
      systemPrompt,
      tools: metaTools,
      maxIterations: 10,
      timeout: workerTimeout * 2 + 60_000,
    });

    const agentId = worker.getContext().id;

    this.emit({
      type: 'worker_spawned',
      sessionId,
      userId,
      data: { agentId, role: 'orchestrator', model: modelName },
      timestamp: new Date(),
    });

    try {
      const response = await worker.run(message);
      return { response, agentId };
    } catch (error) {
      coreLogger.error({ error, agentId }, 'Orchestrator agent failed');
      return {
        response: `I encountered an error while processing your request: ${(error as Error).message}`,
        agentId,
      };
    }
  }

  // ── Worker spawning (called by spawn_worker meta-tool) ───────────

  async spawnWorker(
    role: string,
    task: string,
    input: string,
    context: AgentContext,
    overrides?: { systemPrompt?: string; model?: string },
  ): Promise<unknown> {
    const agentManager = getAgentManager();
    const agentRole = role as AgentRole;
    const roleConfig = getRoleConfig(agentRole);
    const roleTools = getToolsForRole(agentRole);

    const routing = await this.modelSelector.selectForWorker(
      roleConfig.defaultTopic,
      roleTools.length > 0,
    );

    const finalModel = overrides?.model || routing.model;
    if (!finalModel) {
      return { error: 'No model configured. Please add one in the Models page.' };
    }

    const startTime = Date.now();

    // For coding role, prepend project summary if available
    let systemPrompt = overrides?.systemPrompt || roleConfig.systemPromptTemplate;
    if (agentRole === 'coding') {
      const projectSummary = await this.loadProjectSummary();
      if (projectSummary) {
        systemPrompt += `\n\n--- Existing Project Summary ---\n${projectSummary}`;
      }
    }

    const worker = await agentManager.spawn({
      sessionId: context.sessionId,
      userId: context.userId,
      topic: roleConfig.defaultTopic,
      model: finalModel,
      role: agentRole,
      systemPrompt,
      tools: roleTools,
    });

    const workerId = worker.getContext().id;

    this.emit({
      type: 'worker_spawned',
      sessionId: context.sessionId,
      userId: context.userId,
      data: { workerId, role: agentRole, model: finalModel, parentAgentId: context.id },
      timestamp: new Date(),
    });

    try {
      const workerMessage = input
        ? `${task}\n\n--- Context from previous steps ---\n${input}`
        : task;

      const result = await worker.run(workerMessage);
      const durationMs = Date.now() - startTime;

      const workerResult: WorkerResult = {
        workerId,
        role: agentRole,
        result,
        model: finalModel,
        iterations: worker.getIteration(),
        durationMs,
        totalTokens: worker.getTotalTokens(),
      };

      this.emit({
        type: 'worker_completed',
        sessionId: context.sessionId,
        userId: context.userId,
        data: workerResult,
        timestamp: new Date(),
      });

      getNotificationService().notify(
        context.userId,
        'agent_complete',
        `Agent "${agentRole}" completed`,
        result.slice(0, 200),
        { workerId, role: agentRole, durationMs },
      ).catch(() => {});

      return result;
    } catch (error) {
      return this.handleWorkerFailure(error as Error, worker, workerId, routing.model, agentRole, roleConfig, roleTools, task, input, context, startTime);
    }
  }

  // ── Team spawning (called by spawn_team meta-tool) ─────────────

  async spawnTeam(
    members: Array<{ role: string; task: string; input?: string }>,
    context: AgentContext,
  ): Promise<unknown> {
    const teamId = `team-${Date.now()}`;
    const startTime = Date.now();

    this.emit({
      type: 'team_started',
      sessionId: context.sessionId,
      userId: context.userId,
      data: {
        teamId,
        members: members.map(m => ({ role: m.role, task: m.task.slice(0, 100) })),
      },
      timestamp: new Date(),
    });

    // Spawn all workers in parallel
    const results = await Promise.all(
      members.map(async (member) => {
        try {
          const result = await this.spawnWorker(
            member.role,
            member.task,
            member.input || '',
            context,
          );
          return { role: member.role, task: member.task, result: String(result), error: null };
        } catch (error) {
          return { role: member.role, task: member.task, result: null, error: (error as Error).message };
        }
      }),
    );

    const durationMs = Date.now() - startTime;

    this.emit({
      type: 'team_completed',
      sessionId: context.sessionId,
      userId: context.userId,
      data: { teamId, results: results.map(r => ({ role: r.role, error: r.error })), durationMs },
      timestamp: new Date(),
    });

    // Merge results into a structured report
    return results.map(r =>
      `### ${r.role} Agent\n**Task:** ${r.task}\n**Result:**\n${r.error ? `ERROR: ${r.error}` : r.result}`
    ).join('\n\n---\n\n');
  }

  // ── Project summary loading ────────────────────────────────────

  private async loadProjectSummary(): Promise<string | null> {
    try {
      const config = getConfig();
      const { resolve } = await import('path');
      const summaryPath = resolve(config.workspace?.rootPath || '.', '.assistant/project-summary.md');
      const file = Bun.file(summaryPath);
      if (await file.exists()) {
        const content = await file.text();
        return content.slice(0, 4000); // Cap at 4k chars to avoid bloating context
      }
    } catch {
      // File doesn't exist or not readable
    }
    return null;
  }

  // ── Session context compaction ─────────────────────────────────

  private async maybeCompactSession(sessionId: string): Promise<void> {
    const session = await sessionRepository.findById(sessionId);
    if (!session) return;

    const COMPACTION_MESSAGE_THRESHOLD = 20;
    const COMPACTION_TOKEN_THRESHOLD = 8000;

    if (session.messageCount >= COMPACTION_MESSAGE_THRESHOLD || session.tokenCount >= COMPACTION_TOKEN_THRESHOLD) {
      await this.compactSessionContext(sessionId);
    }
  }

  private async compactSessionContext(sessionId: string): Promise<void> {
    const messages = await messageRepository.findBySession(sessionId, 200, 0, ['user', 'assistant']);
    if (messages.length < 10) return;

    const agentMessages = messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
      timestamp: m.createdAt,
    }));

    const result = await compactMessagesWithSummary(agentMessages, {
      maxTokens: 4000,
      preserveRecentCount: 6,
    });

    // Find the summary message (first system message in the result)
    const summaryMsg = result.messages.find(m => m.role === 'system' && m.content.startsWith('Summary'));
    if (summaryMsg || result.removed > 0) {
      const session = await sessionRepository.findById(sessionId);
      const existingContext = (session?.context as SessionContext) || {};
      await sessionRepository.update(sessionId, {
        context: {
          ...existingContext,
          compactedSummary: summaryMsg?.content || existingContext.compactedSummary,
        },
      });
      coreLogger.info({ sessionId, removed: result.removed }, 'Session context compacted');
    }
  }

  private async handleWorkerFailure(
    error: Error,
    worker: import('@/core/agent-base').BaseAgentWorker,
    workerId: string,
    routedModel: string,
    agentRole: AgentRole,
    roleConfig: import('./types').RoleConfig,
    roleTools: import('@/core/agent-base').ToolHandler[],
    task: string,
    input: string,
    context: AgentContext,
    startTime: number,
  ): Promise<unknown> {
    coreLogger.error({ error, workerId, role: agentRole }, 'Worker agent failed');

    // Don't fallback on user-initiated stops
    const errorMsg = error.message || '';
    const wasUserStopped = errorMsg.includes('aborted') || errorMsg.includes('stopped')
      || worker.getStatus() === 'stopped';
    if (wasUserStopped) {
      coreLogger.info({ workerId, role: agentRole }, 'Worker stopped by user, not retrying');
      return 'Agent was stopped by user.';
    }

    // If a CLI sub-agent failed, try falling back to the default model
    const registry = getModelRegistry();
    const failedModel = await registry.getModelByModelId(routedModel);
    if (failedModel?.provider === 'cli') {
      const defaultModel = await registry.getDefaultModel();
      if (defaultModel && defaultModel.modelId !== routedModel && defaultModel.supportsTools) {
        coreLogger.info(
          { failedModel: routedModel, fallbackModel: defaultModel.modelId, role: agentRole },
          'CLI sub-agent failed, retrying with default model',
        );
        try {
          const agentManager = getAgentManager();
          const fallbackWorker = await agentManager.spawn({
            sessionId: context.sessionId,
            userId: context.userId,
            topic: roleConfig.defaultTopic,
            model: defaultModel.modelId,
            role: agentRole,
            systemPrompt: roleConfig.systemPromptTemplate,
            tools: roleTools,
          });
          const workerMessage = input
            ? `${task}\n\n--- Context from previous steps ---\n${input}`
            : task;
          const fallbackResult = await fallbackWorker.run(workerMessage);
          const fbDurationMs = Date.now() - startTime;
          const fallbackWorkerResult: WorkerResult = {
            workerId: fallbackWorker.getContext().id,
            role: agentRole,
            result: fallbackResult,
            model: defaultModel.modelId,
            iterations: fallbackWorker.getIteration(),
            durationMs: fbDurationMs,
          };
          this.emit({
            type: 'worker_completed',
            sessionId: context.sessionId,
            userId: context.userId,
            data: fallbackWorkerResult,
            timestamp: new Date(),
          });
          return fallbackResult;
        } catch (fallbackError) {
          coreLogger.error({ error: fallbackError, role: agentRole }, 'Fallback worker also failed');
        }
      }
    }

    getNotificationService().notify(
      context.userId,
      'agent_error',
      `Agent "${agentRole}" failed`,
      error.message,
      { workerId, role: agentRole },
    ).catch(() => {});

    return `Worker failed: ${error.message}`;
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
