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
import type { ApprovalRequest } from './approval-manager';
import type { AgentRole, WorkerResult, MessageClassification } from './types';

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
  ): Promise<{ response: string; sessionId?: string; agentId?: string; classification: MessageClassification }> {
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

      const classification = classifyMessage(message);
      coreLogger.info(
        { sessionId, classification: classification.type, confidence: classification.confidence, channel },
        'Message classified',
      );

      const resolvedSessionId = await this.resolveSession(sessionId, userId, channel || 'api');

      if (classification.type === 'casual' && classification.confidence >= 0.7) {
        const response = await this.directResponse(message, resolvedSessionId, userId);
        return { response, sessionId: resolvedSessionId, classification };
      }

      if (classification.type === 'approval') {
        const resolved = this.approvalManager.tryResolveFromMessage(message);
        if (resolved) {
          return { response: 'Got it, continuing...', sessionId: resolvedSessionId, classification };
        }
      }

      const { response, agentId } = await this.runOrchestrator(resolvedSessionId, userId, message, classification);
      return { response, sessionId: resolvedSessionId, agentId, classification };
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

  // ── Direct LLM response (casual messages) ────────────────────────

  private async directResponse(message: string, sessionId: string, userId: string): Promise<string> {
    const client = getLiteLLMClient();
    const registry = getModelRegistry();

    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      return 'No model configured. Please add one in the Models page.';
    }

    const modelName = defaultModel.modelId;

    await messageRepository.create({ sessionId, role: 'user', content: message });
    await sessionRepository.incrementMessageCount(sessionId);

    try {
      const recentMessages = await messageRepository.findBySession(sessionId, 20);
      const historyMessages = recentMessages.map(m => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
        timestamp: m.createdAt,
      }));

      const metadata = defaultModel.metadata as import('@/db/schema/models').ModelMetadata | null;

      const result = await client.complete({
        model: modelName,
        messages: [
          { role: 'system', content: 'You are a friendly development assistant. Keep casual responses brief and helpful.', timestamp: new Date() },
          ...historyMessages,
        ],
        temperature: 0.7,
        maxTokens: 512,
        extraBody: metadata?.extraBody,
      });

      await messageRepository.create({ sessionId, role: 'assistant', content: result.content });
      await sessionRepository.incrementMessageCount(sessionId);
      return result.content;
    } catch (error) {
      coreLogger.error({ error, model: modelName }, 'Direct response failed');
      const errorMsg = `Sorry, I'm having trouble connecting to the language model (${modelName}). Please check that the model provider is running and configured correctly.`;
      await messageRepository.create({ sessionId, role: 'assistant', content: errorMsg });
      await sessionRepository.incrementMessageCount(sessionId);
      return errorMsg;
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
  ): Promise<unknown> {
    const agentManager = getAgentManager();
    const agentRole = role as AgentRole;
    const roleConfig = getRoleConfig(agentRole);
    const roleTools = getToolsForRole(agentRole);

    const routing = await this.modelSelector.selectForWorker(
      roleConfig.defaultTopic,
      roleTools.length > 0,
    );

    if (!routing.model) {
      return { error: 'No model configured. Please add one in the Models page.' };
    }

    const startTime = Date.now();

    const worker = await agentManager.spawn({
      sessionId: context.sessionId,
      userId: context.userId,
      topic: roleConfig.defaultTopic,
      model: routing.model,
      role: agentRole,
      systemPrompt: roleConfig.systemPromptTemplate,
      tools: roleTools,
    });

    const workerId = worker.getContext().id;

    this.emit({
      type: 'worker_spawned',
      sessionId: context.sessionId,
      userId: context.userId,
      data: { workerId, role: agentRole, model: routing.model, parentAgentId: context.id },
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
        model: routing.model,
        iterations: worker.getIteration(),
        durationMs,
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
