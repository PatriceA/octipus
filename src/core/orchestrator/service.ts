import { getAgentManager } from '@/core/agent-manager';
import type { AgentContext } from '@/core/types';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { generateId } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';
import { sessionRepository } from '@/db/repositories/session-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { classifyMessage } from './classifier';
import { filterPII } from './pii-filter';
import { createMetaTools } from './meta-tools';
import { getRoleConfig, getToolsForRole } from './roles';
import { getNotificationService } from '@/core/notification-service';
import type { AgentRole, WorkerResult, MessageClassification } from './types';

interface ApprovalRequest {
  id: string;
  summary: string;
  question: string;
  options?: string[];
  resolve: (response: string) => void;
  reject: (reason: string) => void;
  createdAt: Date;
}

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
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private eventHandlers: Set<OrchestratorEventHandler> = new Set();

  /**
   * Subscribe to orchestrator events (for WebSocket forwarding)
   */
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

  /**
   * Main entry point — handle any incoming message from any channel.
   * Routes casual messages to direct LLM response, tasks to orchestrator agent.
   */
  async handleMessage(
    sessionId: string,
    userId: string,
    message: string,
    channel?: string,
  ): Promise<{ response: string; sessionId?: string; agentId?: string; classification: MessageClassification }> {
    try {
      // Check if any model is configured
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

      // Always resolve a proper DB session for all message types
      const resolvedSessionId = await this.resolveSession(sessionId, userId, channel || 'api');

      // High-confidence casual → direct LLM response (no agent)
      if (classification.type === 'casual' && classification.confidence >= 0.7) {
        const response = await this.directResponse(message, resolvedSessionId, userId);
        return { response, sessionId: resolvedSessionId, classification };
      }

      // Approval response → resolve pending approval
      if (classification.type === 'approval') {
        const resolved = this.tryResolveApprovalFromMessage(message);
        if (resolved) {
          return { response: 'Got it, continuing...', sessionId: resolvedSessionId, classification };
        }
      }

      // Task or ambiguous → spawn orchestrator agent with meta-tools
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

  /**
   * Resolve a session ID to a valid DB session UUID.
   * If the given ID is already a UUID, use it. Otherwise, find or create a session.
   */
  private async resolveSession(sessionId: string, userId: string, channel: string): Promise<string> {
    // Check if it's already a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(sessionId)) {
      return sessionId;
    }

    // Parse channel info from the session ID (e.g., "telegram-13441034")
    const parts = sessionId.split('-');
    const channelType = parts[0] || channel;
    const channelId = parts.slice(1).join('-') || sessionId;

    // Look for an existing active session for this user + channel
    const existing = await sessionRepository.findByUserAndChannel(userId, channelType, channelId);
    if (existing) {
      return existing.id;
    }

    // Create a new session
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

  /**
   * Direct LLM response for casual messages (no agent overhead).
   */
  private async directResponse(message: string, sessionId: string, userId: string): Promise<string> {
    const client = getLiteLLMClient();
    const registry = getModelRegistry();

    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      return 'No model configured. Please add one in the Models page.';
    }

    const modelName = defaultModel.modelId;

    // Persist user message
    await messageRepository.create({
      sessionId,
      role: 'user',
      content: message,
    });
    await sessionRepository.incrementMessageCount(sessionId);

    try {
      // Load recent conversation history for context
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
          {
            role: 'system',
            content: 'You are a friendly development assistant. Keep casual responses brief and helpful.',
            timestamp: new Date(),
          },
          ...historyMessages,
        ],
        temperature: 0.7,
        maxTokens: 512,
        extraBody: metadata?.extraBody,
      });

      // Persist assistant response
      await messageRepository.create({
        sessionId,
        role: 'assistant',
        content: result.content,
      });
      await sessionRepository.incrementMessageCount(sessionId);

      return result.content;
    } catch (error) {
      coreLogger.error({ error, model: modelName }, 'Direct response failed');
      const errorMsg = `Sorry, I'm having trouble connecting to the language model (${modelName}). Please check that the model provider is running and configured correctly.`;

      // Persist error as assistant message so user sees it on reload
      await messageRepository.create({
        sessionId,
        role: 'assistant',
        content: errorMsg,
      });
      await sessionRepository.incrementMessageCount(sessionId);

      return errorMsg;
    }
  }

  /**
   * Spawn the orchestrator agent with meta-tools to handle a task.
   */
  private async runOrchestrator(
    sessionId: string,
    userId: string,
    message: string,
    classification: MessageClassification,
  ): Promise<{ response: string; agentId: string }> {
    const agentManager = getAgentManager();
    const registry = getModelRegistry();

    // Find a suitable orchestrator model — must support tool calling and
    // must NOT be a reasoning model (e.g. deepseek-reasoner requires special
    // message fields like reasoning_content that our agent loop doesn't handle).
    const defaultModel = await registry.getDefaultModel();
    let modelName = defaultModel?.modelId || 'gpt-oss';

    if (defaultModel) {
      const isReasoner = defaultModel.modelId.includes('reasoner') || defaultModel.modelId.includes('thinking');
      const noTools = !defaultModel.supportsTools && defaultModel.provider !== 'cli';
      if (isReasoner || noTools) {
        // Try to find a non-reasoning model that supports tools
        const allModels = await registry.getAllModels();
        const suitable = allModels.find(m =>
          m.supportsTools &&
          !m.modelId.includes('reasoner') &&
          !m.modelId.includes('thinking') &&
          m.provider !== 'cli'
        );
        if (suitable) {
          modelName = suitable.modelId;
          coreLogger.info(
            { defaultModel: defaultModel.modelId, selectedModel: modelName },
            'Default model unsuitable for orchestration, using alternative',
          );
        }
      }
    }

    const orchestratorConfig = getRoleConfig('orchestrator');
    const metaTools = createMetaTools(this);

    // Build system prompt with classification context
    let systemPrompt = orchestratorConfig.systemPromptTemplate;
    if (classification.suggestedPipeline) {
      systemPrompt += `\n\nThe user's message has been pre-classified as a "${classification.suggestedPipeline}" task (confidence: ${classification.confidence.toFixed(2)}). Use this as a hint for deciding how to delegate.`;
    }
    if (classification.type === 'ambiguous') {
      systemPrompt += `\n\nThe user's message could not be confidently classified. Analyze it yourself and decide the best course of action.`;
    }

    const worker = await agentManager.spawn({
      sessionId,
      userId,
      topic: orchestratorConfig.defaultTopic,
      model: modelName,
      role: 'orchestrator',
      systemPrompt,
      tools: metaTools,
      maxIterations: 10,
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

  /**
   * Spawn a specialist worker agent (called by the orchestrator's spawn_worker meta-tool).
   */
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

    // Look up the best model for this role's topic directly (not keyword classification)
    const registry = getModelRegistry();
    const topicModel = await registry.getModelForTopic(roleConfig.defaultTopic);

    const routing = {
      model: topicModel?.modelId || '',
      topic: roleConfig.defaultTopic,
      reason: topicModel ? `Best model for topic: ${roleConfig.defaultTopic}` : '',
    };

    // Fallback to default model if no topic-specific model found
    if (!routing.model) {
      const defaultModel = await registry.getDefaultModel();
      if (defaultModel) {
        routing.model = defaultModel.modelId;
        routing.reason = 'Fallback to default model';
      } else {
        return { error: 'No model configured. Please add one in the Models page.' };
      }
    }

    // If the worker needs tools, verify the routed model supports them
    if (roleTools.length > 0) {
      const model = await registry.getModelByModelId(routing.model);
      if (model && !model.supportsTools && model.provider !== 'cli') {
        coreLogger.info(
          { model: routing.model, role },
          'Routed model does not support tools, finding alternative'
        );
        // Only fall back to local models (ollama) to avoid unexpected API costs
        const localProviders = ['ollama'];
        // Try default model first
        const defaultModel = await registry.getDefaultModel();
        if (defaultModel && defaultModel.supportsTools
            && defaultModel.modelId !== routing.model
            && localProviders.includes(defaultModel.provider)) {
          routing.model = defaultModel.modelId;
          routing.reason = 'Fallback: routed model does not support tool calling';
        } else {
          // Find any local model with tool support
          const allModels = await registry.getAllModels();
          const toolModel = allModels.find(m =>
            m.supportsTools
            && m.provider !== 'cli'
            && localProviders.includes(m.provider)
            && m.modelId !== routing.model
          );
          if (toolModel) {
            routing.model = toolModel.modelId;
            routing.reason = `Fallback: using ${toolModel.name} for tool support`;
            coreLogger.info(
              { fallbackModel: toolModel.modelId, role },
              'Found alternative local model with tool support'
            );
          } else {
            coreLogger.warn(
              { model: routing.model, role },
              'No local model with tool support found — proceeding without tools'
            );
          }
        }
      }
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
      // Build the worker's input message
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

      // Notify user of agent completion
      getNotificationService().notify(
        context.userId,
        'agent_complete',
        `Agent "${agentRole}" completed`,
        result.slice(0, 200),
        { workerId, role: agentRole, durationMs },
      ).catch(() => {});

      return workerResult;
    } catch (error) {
      coreLogger.error({ error, workerId, role }, 'Worker agent failed');

      // Don't fallback on user-initiated stops — only on genuine failures
      const errorMsg = (error as Error).message || '';
      const wasUserStopped = errorMsg.includes('aborted') || errorMsg.includes('stopped')
        || worker.getStatus() === 'stopped';
      if (wasUserStopped) {
        coreLogger.info({ workerId, role }, 'Worker stopped by user, not retrying');
        return {
          workerId,
          role: agentRole,
          result: 'Agent was stopped by user.',
          model: routing.model,
          iterations: worker.getIteration(),
          durationMs: Date.now() - startTime,
          error: 'stopped_by_user',
        };
      }

      // If a CLI sub-agent failed (e.g. quota exhausted), try falling back to
      // the default model with standard tool calling
      const failedModel = await registry.getModelByModelId(routing.model);
      if (failedModel?.provider === 'cli') {
        const defaultModel = await registry.getDefaultModel();
        if (defaultModel && defaultModel.modelId !== routing.model && defaultModel.supportsTools) {
          coreLogger.info(
            { failedModel: routing.model, fallbackModel: defaultModel.modelId, role },
            'CLI sub-agent failed, retrying with default model',
          );
          try {
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
            const durationMs = Date.now() - startTime;
            const result: WorkerResult = {
              workerId: fallbackWorker.getContext().id,
              role: agentRole,
              result: fallbackResult,
              model: defaultModel.modelId,
              iterations: fallbackWorker.getIteration(),
              durationMs,
            };
            this.emit({
              type: 'worker_completed',
              sessionId: context.sessionId,
              userId: context.userId,
              data: result,
              timestamp: new Date(),
            });
            return result;
          } catch (fallbackError) {
            coreLogger.error({ error: fallbackError, role }, 'Fallback worker also failed');
          }
        }
      }

      // Notify user of agent error
      getNotificationService().notify(
        context.userId,
        'agent_error',
        `Agent "${agentRole}" failed`,
        (error as Error).message,
        { workerId, role: agentRole },
      ).catch(() => {});

      return {
        workerId,
        role: agentRole,
        result: `Worker failed: ${(error as Error).message}`,
        model: routing.model,
        iterations: worker.getIteration(),
        durationMs: Date.now() - startTime,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Create and run a multi-stage pipeline (called by create_pipeline meta-tool).
   */
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

  /**
   * Request user approval (called by request_user_approval meta-tool).
   * Returns a promise that resolves when the user responds.
   */
  async requestApproval(
    summary: string,
    question: string,
    context: AgentContext,
    options?: string[],
  ): Promise<unknown> {
    const requestId = generateId();

    this.emit({
      type: 'approval_required',
      sessionId: context.sessionId,
      userId: context.userId,
      data: { requestId, summary, question, options },
      timestamp: new Date(),
    });

    // Notify user of approval required
    getNotificationService().notify(
      context.userId,
      'approval_required',
      'Approval Required',
      `${summary}\n\n${question}`,
      { requestId },
    ).catch(() => {});

    return new Promise<unknown>((resolve, reject) => {
      const approval: ApprovalRequest = {
        id: requestId,
        summary,
        question,
        options,
        resolve: (response: string) => {
          this.pendingApprovals.delete(requestId);
          resolve({ approved: true, response, requestId });
        },
        reject: (reason: string) => {
          this.pendingApprovals.delete(requestId);
          resolve({ approved: false, reason, requestId });
        },
        createdAt: new Date(),
      };

      this.pendingApprovals.set(requestId, approval);

      // Auto-timeout after configured duration (default: 1 hour)
      const timeout = setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          this.pendingApprovals.delete(requestId);
          resolve({ approved: false, reason: 'Approval timed out', requestId });
        }
      }, 3600000);

      // Clean up timeout when resolved
      const originalResolve = approval.resolve;
      const originalReject = approval.reject;
      approval.resolve = (response: string) => {
        clearTimeout(timeout);
        originalResolve(response);
      };
      approval.reject = (reason: string) => {
        clearTimeout(timeout);
        originalReject(reason);
      };
    });
  }

  /**
   * Resolve a pending approval request (called from WebSocket or API).
   */
  resolveApproval(requestId: string, approved: boolean, response?: string): boolean {
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) {
      coreLogger.warn({ requestId }, 'Approval request not found');
      return false;
    }

    if (approved) {
      approval.resolve(response || 'approved');
    } else {
      approval.reject(response || 'denied');
    }

    return true;
  }

  /**
   * Try to resolve a pending approval from a chat message (e.g. "yes", "approve").
   */
  private tryResolveApprovalFromMessage(message: string): boolean {
    // If there's exactly one pending approval, resolve it
    if (this.pendingApprovals.size !== 1) return false;

    const [requestId, approval] = [...this.pendingApprovals.entries()][0];
    const normalized = message.trim().toLowerCase();

    const approvePatterns = /^(approve|yes|go\s*ahead|proceed|confirm|accept|lgtm|ship\s*it)\b/i;
    const denyPatterns = /^(deny|reject|no|stop|cancel|abort|don'?t)\b/i;

    if (approvePatterns.test(normalized)) {
      approval.resolve(message);
      return true;
    } else if (denyPatterns.test(normalized)) {
      approval.reject(message);
      return true;
    }

    return false;
  }

  /**
   * Send a status update to the user (called by send_status_update meta-tool).
   */
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

  /**
   * Filter PII from text (called by filter_pii meta-tool).
   */
  filterPIIText(text: string): unknown {
    return filterPII(text);
  }

  /**
   * Get all pending approvals for a session.
   */
  getPendingApprovals(sessionId?: string): ApprovalRequest[] {
    const approvals = [...this.pendingApprovals.values()];
    // Note: approvals don't track sessionId directly, so return all for now
    return approvals;
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
