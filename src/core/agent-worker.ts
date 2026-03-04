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

  /** Milliseconds since agent start */
  private elapsed(): number {
    return Date.now() - this.startTime;
  }

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

    // Only persist for orchestrator (root agent). Worker sub-agents are internal —
    // their task messages would appear as fake "user" messages in the chat.
    if (this.context.role === 'orchestrator') {
      await messageRepository.create({
        sessionId: this.context.sessionId,
        role: 'user',
        content,
        agentId: this.context.id,
      });
      await sessionRepository.incrementMessageCount(this.context.sessionId);
    }
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

      const durationMs = Date.now() - this.startTime;
      agentLogger.info({
        agentId: this.context.id, sessionId: this.context.sessionId,
        iterations: this.iteration, totalTokensUsed: this.totalTokensUsed,
        model: this.context.model, role: this.context.role, durationMs,
      }, 'Agent completed');

      await auditRepository.logAgentCompleted(
        this.context.userId,
        this.context.sessionId,
        this.context.id,
        {
          durationMs,
          iterations: this.iteration,
          totalTokensUsed: this.totalTokensUsed,
          model: this.context.model,
          role: this.context.role,
        },
      );

      return result;
    } catch (error) {
      this.context.status = 'failed';
      this.emit('status_change', { status: 'failed' });
      this.emit('error', { error: (error as Error).message });

      const failDurationMs = Date.now() - this.startTime;
      agentLogger.error({
        agentId: this.context.id, sessionId: this.context.sessionId,
        iteration: this.iteration, elapsedMs: failDurationMs,
        totalTokensUsed: this.totalTokensUsed,
        model: this.context.model, role: this.context.role,
        error: (error as Error).message,
      }, 'Agent failed');

      await auditRepository.logAgentFailed(
        this.context.userId,
        this.context.sessionId,
        this.context.id,
        {
          error: (error as Error).message,
          iteration: this.iteration,
          elapsedMs: failDurationMs,
          totalTokensUsed: this.totalTokensUsed,
          model: this.context.model,
          role: this.context.role,
        },
      );

      throw error;
    }
  }

  /**
   * Main agent loop: Thought -> Action -> Observation
   */
  /**
   * Race a promise against the agent timeout. Throws if the timeout fires first.
   */
  private raceTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    if (this.config.timeout <= 0) return promise;
    const remaining = this.config.timeout - this.elapsed();
    if (remaining <= 0) {
      const msg = `Agent timeout exceeded (${Math.round(this.elapsed() / 1000)}s / ${Math.round(this.config.timeout / 1000)}s) during ${label}`;
      agentLogger.error({
        agentId: this.context.id, sessionId: this.context.sessionId,
        iteration: this.iteration, elapsedMs: this.elapsed(),
        phase: label, timeoutMs: this.config.timeout,
      }, msg);
      throw new Error(msg);
    }
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          const msg = `Agent timeout exceeded (${Math.round(this.elapsed() / 1000)}s / ${Math.round(this.config.timeout / 1000)}s) during ${label}`;
          agentLogger.error({
            agentId: this.context.id, sessionId: this.context.sessionId,
            iteration: this.iteration, elapsedMs: this.elapsed(),
            phase: label, timeoutMs: this.config.timeout,
          }, msg);
          reject(new Error(msg));
        }, remaining),
      ),
    ]);
  }

  private async loop(): Promise<string> {
    while (this.iteration < this.config.maxIterations) {
      if (this.abortController.signal.aborted) {
        throw new Error('Agent execution aborted');
      }

      this.iteration++;
      agentLogger.info({
        agentId: this.context.id, sessionId: this.context.sessionId,
        iteration: this.iteration, elapsedMs: this.elapsed(),
        role: this.context.role, model: this.context.model,
      }, 'Agent loop iteration');

      // Check token budget
      if (this.config.maxTokenBudget > 0 && this.totalTokensUsed >= this.config.maxTokenBudget) {
        throw new Error(
          `Token budget exceeded (${this.totalTokensUsed}/${this.config.maxTokenBudget})`
        );
      }

      // Check timeout
      if (this.config.timeout > 0 && this.elapsed() > this.config.timeout) {
        throw new Error(
          `Agent timeout exceeded (${Math.round(this.elapsed() / 1000)}s / ${Math.round(this.config.timeout / 1000)}s)`
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
        agentLogger.info({
          agentId: this.context.id, sessionId: this.context.sessionId,
          iteration: this.iteration, elapsedMs: this.elapsed(),
          messagesRemoved: removed, messagesRemaining: compactedMessages.length,
        }, 'Messages compacted');
      }

      // Get completion from LLM (with timeout guard)
      agentLogger.info({
        agentId: this.context.id, sessionId: this.context.sessionId,
        iteration: this.iteration, elapsedMs: this.elapsed(),
        phase: 'getCompletion', model: this.context.model,
        messageCount: this.messages.length, toolsDisabled: this.toolsDisabled,
      }, 'LLM call starting');

      const llmStart = Date.now();
      const completion = await this.raceTimeout(this.getCompletion(), 'getCompletion');

      // Accumulate token usage
      this.totalTokensUsed += completion.usage.totalTokens;

      agentLogger.info({
        agentId: this.context.id, sessionId: this.context.sessionId,
        iteration: this.iteration, elapsedMs: this.elapsed(),
        phase: 'getCompletion', llmLatencyMs: Date.now() - llmStart,
        inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens,
        totalTokensUsed: this.totalTokensUsed,
        hasToolCalls: !!(completion.toolCalls?.length), finishReason: completion.finishReason,
      }, 'LLM call completed');

      // Handle tool calls if present — but ignore them when tools are disabled
      // (some models hallucinate tool calls even when none are provided)
      if (completion.toolCalls?.length && !this.toolsDisabled) {
        const toolNames = completion.toolCalls.map(tc => tc.name);
        agentLogger.info({
          agentId: this.context.id, sessionId: this.context.sessionId,
          iteration: this.iteration, elapsedMs: this.elapsed(),
          phase: 'handleToolCalls', toolCount: completion.toolCalls.length, tools: toolNames,
        }, 'Tool execution starting');

        const toolStart = Date.now();
        await this.raceTimeout(this.handleToolCalls(completion.toolCalls), 'handleToolCalls');

        agentLogger.info({
          agentId: this.context.id, sessionId: this.context.sessionId,
          iteration: this.iteration, elapsedMs: this.elapsed(),
          phase: 'handleToolCalls', toolDurationMs: Date.now() - toolStart, tools: toolNames,
        }, 'Tool execution completed');
        continue;
      }

      // No tool calls — treat as final response (even if empty)
      const response = completion.content || 'I was unable to generate a response.';

      agentLogger.info({
        agentId: this.context.id, sessionId: this.context.sessionId,
        iteration: this.iteration, elapsedMs: this.elapsed(),
        responseLength: response.length, totalTokensUsed: this.totalTokensUsed,
      }, 'Agent returning response');

      // Only persist messages for orchestrator agents (workers are internal)
      if (this.context.role === 'orchestrator') {
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
      }

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
          const toolExecStart = Date.now();
          const result = await tool.execute(toolCall.arguments, this.context);
          const toolExecMs = Date.now() - toolExecStart;

          agentLogger.info({
            agentId: this.context.id, sessionId: this.context.sessionId,
            tool: toolCall.name, skillId, durationMs: toolExecMs,
          }, 'Tool executed');

          results.push({ toolCallId: toolCall.id, result });

          if (tool.final) {
            this.toolsDisabled = true;
            agentLogger.info(
              { agentId: this.context.id, tool: toolCall.name },
              'Final tool executed — disabling tools for remaining iterations',
            );
          }
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
        const toolExecStart = Date.now();
        const result = await tool.execute(toolCall.arguments, this.context);
        const toolExecMs = Date.now() - toolExecStart;

        agentLogger.info({
          agentId: this.context.id, sessionId: this.context.sessionId,
          tool: toolCall.name, skillId, durationMs: toolExecMs,
        }, 'Tool executed');

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
          { args: toolCall.arguments, result: resultStr.slice(0, 10_000), durationMs: toolExecMs }
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

      // Persist tool result (skip for orchestrator — its tool results are internal routing)
      if (this.context.role !== 'orchestrator') {
        await messageRepository.create({
          sessionId: this.context.sessionId,
          role: 'tool',
          content: toolMessage.content,
          toolCallId: result.toolCallId,
          agentId: this.context.id,
        });
      }
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
