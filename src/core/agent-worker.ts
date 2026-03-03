import { getLiteLLMClient, type CompletionResult } from '@/models/litellm-client';
import { getCostTracker } from '@/models/cost-tracker';
import { getModelRegistry } from '@/models/model-registry';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { agentLogger } from '@/utils/logger';
import { generateId } from '@/utils/crypto';
import { compactMessagesWithSummary } from '@/utils/context-compaction';
import { getPermissionManager } from '@/security/permissions';
import { sanitizeToolOutput } from '@/utils/sanitize';
import type { AgentContext, AgentMessage, ToolCall, ToolResult, AgentStatus } from './types';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

export interface AgentWorkerConfig {
  maxIterations: number;
  contextWindowSize: number;
  timeout: number;
  maxTokenBudget: number;
}

export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  skillId?: string;
  /**
   * If true, after this tool executes successfully, all tools are stripped
   * from subsequent LLM calls — forcing the model to produce a text response.
   * Use this for "delegation" tools where the result should be summarized
   * and no further tool calls are needed.
   */
  final?: boolean;
  execute: (args: Record<string, unknown>, context: AgentContext) => Promise<unknown>;
}

export type AgentEventHandler = (event: AgentEvent) => void;

export interface AgentEvent {
  type: 'thought' | 'action' | 'observation' | 'error' | 'complete' | 'status_change' | 'permission_request';
  agentId: string;
  data: unknown;
  timestamp: Date;
}

export class AgentWorker {
  private context: AgentContext;
  private config: AgentWorkerConfig;
  private messages: AgentMessage[] = [];
  private tools: Map<string, ToolHandler> = new Map();
  private eventHandlers: Set<AgentEventHandler> = new Set();
  private abortController: AbortController;
  private iteration: number = 0;
  private totalTokensUsed: number = 0;
  private startTime: number = 0;
  private consecutiveToolErrors: number = 0;
  private toolsDisabled: boolean = false;
  private static MAX_CONSECUTIVE_TOOL_ERRORS = 3;

  constructor(context: AgentContext, config: AgentWorkerConfig) {
    this.context = context;
    this.config = config;
    this.abortController = new AbortController();
  }

  /**
   * Register a tool for the agent to use
   */
  registerTool(tool: ToolHandler): void {
    this.tools.set(tool.name, tool);
    agentLogger.debug({ agentId: this.context.id, tool: tool.name }, 'Tool registered');
  }

  /**
   * Register multiple tools
   */
  registerTools(tools: ToolHandler[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * Subscribe to agent events
   */
  onEvent(handler: AgentEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Emit an event to all handlers
   */
  private emit(type: AgentEvent['type'], data: unknown): void {
    const event: AgentEvent = {
      type,
      agentId: this.context.id,
      data,
      timestamp: new Date(),
    };

    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        agentLogger.error({ error, agentId: this.context.id }, 'Event handler error');
      }
    }
  }

  /**
   * Load conversation history from database
   */
  async loadHistory(): Promise<void> {
    // Orchestrators and task-specific workers are ephemeral — they receive their
    // task via run() and don't need session history. Loading history from
    // persistent sessions (e.g. Telegram) causes workers to see old messages
    // and act on stale tasks instead of the current one.
    if (this.context.role !== 'general') {
      agentLogger.debug({ agentId: this.context.id, role: this.context.role }, 'Skipping history for non-general agent');
      return;
    }

    const dbMessages = await messageRepository.findBySession(this.context.sessionId);

    // Only load user and assistant text messages — tool messages are internal
    // to a specific agent run and cause errors with strict models (e.g. DeepSeek)
    // that require tool messages to follow matching tool_calls.
    this.messages = dbMessages
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system')
      .filter((msg) => !msg.toolCalls && !msg.toolCallId)
      .map((msg) => ({
        role: msg.role as AgentMessage['role'],
        content: msg.content,
        timestamp: msg.createdAt,
      }));

    agentLogger.debug({ agentId: this.context.id, messageCount: this.messages.length }, 'History loaded');
  }

  /**
   * Add a system message
   */
  addSystemMessage(content: string): void {
    this.messages.push({
      role: 'system',
      content,
      timestamp: new Date(),
    });
  }

  /**
   * Add a user message
   */
  async addUserMessage(content: string): Promise<void> {
    const message: AgentMessage = {
      role: 'user',
      content,
      timestamp: new Date(),
    };

    this.messages.push(message);

    // Persist to database
    await messageRepository.create({
      sessionId: this.context.sessionId,
      role: 'user',
      content,
      agentId: this.context.id,
    });

    await sessionRepository.incrementMessageCount(this.context.sessionId);
  }

  /**
   * Run the agent loop
   */
  async run(userMessage?: string): Promise<string> {
    if (userMessage) {
      await this.addUserMessage(userMessage);
    }

    this.context.status = 'running';
    this.startTime = Date.now();
    this.emit('status_change', { status: 'running' });

    try {
      const result = await this.loop();
      this.context.status = 'completed';
      this.emit('status_change', { status: 'completed' });
      this.emit('complete', { result });

      await auditRepository.logAgentCompleted(
        this.context.userId,
        this.context.sessionId,
        this.context.id,
        Date.now() - this.context.createdAt.getTime()
      );

      return result;
    } catch (error) {
      this.context.status = 'failed';
      this.emit('status_change', { status: 'failed' });
      this.emit('error', { error: (error as Error).message });

      await auditRepository.logAgentFailed(
        this.context.userId,
        this.context.sessionId,
        this.context.id,
        (error as Error).message
      );

      throw error;
    }
  }

  /**
   * Main agent loop: Thought -> Action -> Observation
   */
  private async loop(): Promise<string> {
    while (this.iteration < this.config.maxIterations) {
      if (this.abortController.signal.aborted) {
        throw new Error('Agent execution aborted');
      }

      this.iteration++;
      agentLogger.debug({ agentId: this.context.id, iteration: this.iteration }, 'Agent iteration');

      // Check token budget
      if (this.config.maxTokenBudget > 0 && this.totalTokensUsed >= this.config.maxTokenBudget) {
        throw new Error(
          `Token budget exceeded (${this.totalTokensUsed}/${this.config.maxTokenBudget})`
        );
      }

      // Check timeout
      if (this.config.timeout > 0 && Date.now() - this.startTime > this.config.timeout) {
        throw new Error(
          `Agent timeout exceeded (${Math.round((Date.now() - this.startTime) / 1000)}s / ${Math.round(this.config.timeout / 1000)}s)`
        );
      }

      // Compact messages if needed (with LLM summary for removed context)
      const { messages: compactedMessages, removed } = await compactMessagesWithSummary(this.messages, {
        maxTokens: this.config.contextWindowSize,
        preserveSystemMessages: true,
        preserveRecentCount: 20,
        summaryModel: this.context.model,
      });

      if (removed > 0) {
        this.messages = compactedMessages;
        agentLogger.debug({ agentId: this.context.id, removed }, 'Messages compacted');
      }

      // Get completion from LLM
      const completion = await this.getCompletion();

      // Accumulate token usage
      this.totalTokensUsed += completion.usage.totalTokens;

      // Handle tool calls if present
      if (completion.toolCalls?.length) {
        await this.handleToolCalls(completion.toolCalls);
        continue;
      }

      // No tool calls — treat as final response (even if empty)
      const response = completion.content || 'I was unable to generate a response.';

      // Save assistant message
      await messageRepository.create({
        sessionId: this.context.sessionId,
        role: 'assistant',
        content: response,
        agentId: this.context.id,
      });

      await sessionRepository.incrementMessageCount(
        this.context.sessionId,
        completion.usage.totalTokens
      );

      return response;
    }

    throw new Error(`Max iterations (${this.config.maxIterations}) reached`);
  }

  /**
   * Get completion from LLM
   */
  private async getCompletion(): Promise<CompletionResult> {
    const client = getLiteLLMClient();
    const registry = getModelRegistry();
    const costTracker = getCostTracker();

    // Look up model by name or modelId
    const model = await registry.getModel(this.context.model) || await registry.getModelByModelId(this.context.model);
    if (!model) {
      throw new Error(`Model not found: ${this.context.model}`);
    }

    // Use modelId for LiteLLM calls (name is the display name, modelId is what LiteLLM expects)
    const litellmModel = model.modelId;

    // Convert tools to OpenAI format (omit if a final tool has already run)
    const tools: ChatCompletionTool[] = this.toolsDisabled
      ? []
      : Array.from(this.tools.values()).map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));

    this.emit('thought', { model: litellmModel, messageCount: this.messages.length });

    // Pass extra body params from model metadata (e.g. { think: false } for Qwen3)
    const metadata = model.metadata as import('@/db/schema/models').ModelMetadata | null;

    const result = await client.complete({
      model: litellmModel,
      messages: this.messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: model.defaultTemperature || 0.7,
      maxTokens: model.defaultMaxTokens || 4096,
      extraBody: metadata?.extraBody,
    });

    // Track cost
    await costTracker.logUsageWithCost(
      this.context.userId,
      this.context.model,
      result.usage.inputTokens,
      result.usage.outputTokens,
      {
        sessionId: this.context.sessionId,
        agentId: this.context.id,
        requestType: 'chat',
        metadata: { iteration: this.iteration },
      }
    );

    // Add assistant message to history
    const assistantMessage: AgentMessage = {
      role: 'assistant',
      content: result.content,
      toolCalls: result.toolCalls,
      timestamp: new Date(),
    };
    this.messages.push(assistantMessage);

    return result;
  }

  /**
   * Handle tool calls from the LLM with permission gating
   */
  private async handleToolCalls(toolCalls: ToolCall[]): Promise<void> {
    this.emit('action', { toolCalls });

    const permissionManager = getPermissionManager();
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      const tool = this.tools.get(toolCall.name);

      if (!tool) {
        results.push({
          toolCallId: toolCall.id,
          result: null,
          error: `Unknown tool: ${toolCall.name}`,
        });
        continue;
      }

      const skillId = tool.skillId || 'agent';

      // Internal orchestrator meta-tools are always allowed (no permission gate)
      if (skillId === 'agent') {
        try {
          const result = await tool.execute(toolCall.arguments, this.context);
          results.push({ toolCallId: toolCall.id, result });
        } catch (error) {
          results.push({ toolCallId: toolCall.id, result: null, error: (error as Error).message });
        }
        continue;
      }

      // Permission check
      const permResult = await permissionManager.check(
        this.context.userId,
        skillId,
        toolCall.name,
        toolCall.arguments
      );

      if (permResult.level === 'DENY') {
        agentLogger.info(
          { agentId: this.context.id, tool: toolCall.name, reason: permResult.reason },
          'Tool call denied by permission policy'
        );

        results.push({
          toolCallId: toolCall.id,
          result: null,
          error: `Permission denied: ${permResult.reason || 'action is not allowed'}`,
        });

        await auditRepository.logToolDenied(
          this.context.userId,
          this.context.sessionId,
          toolCall.name,
          skillId,
          { args: toolCall.arguments, reason: permResult.reason }
        );
        continue;
      }

      if (permResult.level === 'ASK') {
        // Request approval
        const requestId = await permissionManager.requestApproval(
          this.context.userId,
          this.context.id,
          skillId,
          toolCall.name,
          toolCall.arguments,
          this.context.sessionId
        );

        this.emit('permission_request', {
          requestId,
          toolName: toolCall.name,
          args: toolCall.arguments,
          skillId,
        });

        const approved = await permissionManager.waitForApproval(requestId);

        if (!approved) {
          agentLogger.info(
            { agentId: this.context.id, tool: toolCall.name, requestId },
            'Tool call denied by user'
          );

          results.push({
            toolCallId: toolCall.id,
            result: null,
            error: 'Permission denied: user rejected the request',
          });

          await auditRepository.logToolDenied(
            this.context.userId,
            this.context.sessionId,
            toolCall.name,
            skillId,
            { args: toolCall.arguments, reason: 'user_denied', requestId }
          );
          continue;
        }
      }

      // ALLOW path (or approved ASK) — execute tool
      try {
        agentLogger.debug(
          { agentId: this.context.id, tool: toolCall.name, args: toolCall.arguments },
          'Executing tool'
        );

        const result = await tool.execute(toolCall.arguments, this.context);

        results.push({
          toolCallId: toolCall.id,
          result,
        });

        // If this tool is marked as final, disable all tools for subsequent
        // LLM calls so the model is forced to produce a text response.
        if (tool.final) {
          this.toolsDisabled = true;
          agentLogger.info(
            { agentId: this.context.id, tool: toolCall.name },
            'Final tool executed — disabling tools for remaining iterations',
          );
        }

        const resultStr = sanitizeToolOutput(result);
        await auditRepository.logToolExecuted(
          this.context.userId,
          this.context.sessionId,
          toolCall.name,
          skillId,
          { args: toolCall.arguments, result: resultStr.slice(0, 10_000) }
        );
      } catch (error) {
        agentLogger.error(
          { error, agentId: this.context.id, tool: toolCall.name },
          'Tool execution failed'
        );

        results.push({
          toolCallId: toolCall.id,
          result: null,
          error: (error as Error).message,
        });
      }
    }

    this.emit('observation', { results });

    // Track consecutive tool failures — disable tools if they keep failing
    const allFailed = results.length > 0 && results.every(r => r.error);
    if (allFailed) {
      this.consecutiveToolErrors++;
      if (this.consecutiveToolErrors >= AgentWorker.MAX_CONSECUTIVE_TOOL_ERRORS) {
        agentLogger.warn(
          { agentId: this.context.id, consecutiveErrors: this.consecutiveToolErrors },
          'Too many consecutive tool failures — disabling tools'
        );
        // Disable tools so the model is forced to produce a text response
        this.toolsDisabled = true;
        this.messages.push({
          role: 'system',
          content: 'The tools have failed multiple times in a row and are now unavailable. Provide the best response you can with the information you already have. Explain to the user which tools failed and why.',
          timestamp: new Date(),
        });
      }
    } else {
      this.consecutiveToolErrors = 0;
    }

    // Add tool results to messages
    for (const result of results) {
      const toolMessage: AgentMessage = {
        role: 'tool',
        content: result.error || sanitizeToolOutput(result.result),
        toolCallId: result.toolCallId,
        timestamp: new Date(),
      };
      this.messages.push(toolMessage);

      // Persist tool result
      await messageRepository.create({
        sessionId: this.context.sessionId,
        role: 'tool',
        content: toolMessage.content,
        toolCallId: result.toolCallId,
        agentId: this.context.id,
      });
    }
  }

  /**
   * Stop the agent
   */
  stop(): void {
    this.abortController.abort();
    this.context.status = 'stopped';
    this.emit('status_change', { status: 'stopped' });
    agentLogger.info({ agentId: this.context.id }, 'Agent stopped');
  }

  /**
   * Get current status
   */
  getStatus(): AgentStatus {
    return this.context.status;
  }

  /**
   * Get context
   */
  getContext(): AgentContext {
    return this.context;
  }

  /**
   * Get current iteration count
   */
  getIteration(): number {
    return this.iteration;
  }
}
