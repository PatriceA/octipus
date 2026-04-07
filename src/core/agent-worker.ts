import { getLiteLLMClient, type CompletionResult } from '@/models/litellm-client';
import { getCostTracker } from '@/models/cost-tracker';
import { getModelRegistry } from '@/models/model-registry';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { agentRepository } from '@/db/repositories/agent-repository';
import { autoIndexAgentOutput } from '@/core/rag/auto-indexer';
import { agentLogger } from '@/utils/logger';
import { compactMessagesWithSummary } from '@/utils/context-compaction';
import type { AgentMessage, ToolCall } from './types';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { BaseAgentWorker } from './agent-base';
import { ToolExecutor } from './tool-executor';

// Re-export types for backward compatibility
export type { AgentWorkerConfig, ToolHandler, AgentEventHandler, AgentEvent } from './agent-base';

export class AgentWorker extends BaseAgentWorker {
  private toolExecutor: ToolExecutor;
  private abortController: AbortController;
  private totalTokensUsed: number = 0;
  private startTime: number = 0;
  private emptyRetries: number = 0;
  private llmRetries: number = 0;
  /** Track consecutive identical tool calls to detect loops */
  private lastToolCallSignature: string = '';
  private consecutiveRepeatCount: number = 0;
  private static MAX_CONSECUTIVE_REPEATS = 3;

  /** Milliseconds since agent start */
  private elapsed(): number {
    return Date.now() - this.startTime;
  }

  /** Public elapsed time for status reporting */
  getElapsedMs(): number {
    return this.startTime > 0 ? Date.now() - this.startTime : 0;
  }

  constructor(context: import('./types').AgentContext, config: import('./agent-base').AgentWorkerConfig) {
    super(context, config);
    this.abortController = new AbortController();
    this.toolExecutor = new ToolExecutor(
      context,
      (type, data) => this.emit(type, data),
    );
  }

  override getTotalTokens(): number {
    return this.totalTokensUsed;
  }

  registerTool(tool: import('./agent-base').ToolHandler): void {
    this.toolExecutor.registerTool(tool);
  }

  registerTools(tools: import('./agent-base').ToolHandler[]): void {
    this.toolExecutor.registerTools(tools);
  }

  async loadHistory(): Promise<void> {
    // Orchestrators and task-specific workers are ephemeral — they receive their
    // task via run() and don't need session history.
    if (this.context.role !== 'general') {
      agentLogger.debug({ agentId: this.context.id, role: this.context.role }, 'Skipping history for non-general agent');
      return;
    }

    const dbMessages = await messageRepository.findBySession(this.context.sessionId);

    // Only load user and assistant text messages — tool messages are internal
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

  addSystemMessage(content: string): void {
    this.messages.push({ role: 'system', content, timestamp: new Date() });
  }

  async addUserMessage(content: string): Promise<void> {
    const message: AgentMessage = { role: 'user', content, timestamp: new Date() };
    this.messages.push(message);

    // Only persist for orchestrator (root agent)
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
        this.context.userId, this.context.sessionId, this.context.id,
        { durationMs, iterations: this.iteration, totalTokensUsed: this.totalTokensUsed, model: this.context.model, role: this.context.role },
      );

      // Persist final state to DB
      agentRepository.updateStatus(this.context.id, {
        status: 'completed',
        iterations: this.iteration,
        totalTokens: this.totalTokensUsed,
        durationMs,
      }).catch(err => agentLogger.error({ err, agentId: this.context.id }, 'Failed to persist agent completion'));

      // Auto-index output into knowledge base (fire-and-forget)
      autoIndexAgentOutput({
        agentId: this.context.id,
        sessionId: this.context.sessionId,
        userId: this.context.userId,
        role: this.context.role,
        topic: this.context.topic,
        output: typeof result === 'string' ? result : JSON.stringify(result),
      }).catch(() => {}); // Never block on indexing failures

      // Auto-update project summary for roles that work on projects
      const summaryRoles = ['coding', 'research', 'review', 'general', 'qa', 'devops', 'analysis', 'design', 'security', 'data', 'ai'];
      if (summaryRoles.includes(this.context.role) && typeof result === 'string' && result.length > 50) {
        import('@/core/orchestrator/project-summary').then(({ autoUpdateProjectSummary }) => {
          const title = `${this.context.role} — ${this.context.topic || 'task'}`;
          autoUpdateProjectSummary(this.context, title, result).catch(() => {});
        }).catch(() => {});
      }

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
        this.context.userId, this.context.sessionId, this.context.id,
        { error: (error as Error).message, iteration: this.iteration, elapsedMs: failDurationMs, totalTokensUsed: this.totalTokensUsed, model: this.context.model, role: this.context.role },
      );

      // Persist final state to DB
      agentRepository.updateStatus(this.context.id, {
        status: 'failed',
        iterations: this.iteration,
        totalTokens: this.totalTokensUsed,
        durationMs: failDurationMs,
        error: (error as Error).message,
      }).catch(err => agentLogger.error({ err, agentId: this.context.id }, 'Failed to persist agent failure'));

      throw error;
    }
  }

  /**
   * Race a promise against the agent timeout.
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
        throw new Error(`Token budget exceeded (${this.totalTokensUsed}/${this.config.maxTokenBudget})`);
      }

      // Check timeout — skip if a final/delegation tool already completed
      // (tools are disabled after delegation; we just need one more LLM call for the summary)
      if (this.config.timeout > 0 && this.elapsed() > this.config.timeout && !this.toolExecutor.toolsDisabled) {
        throw new Error(`Agent timeout exceeded (${Math.round(this.elapsed() / 1000)}s / ${Math.round(this.config.timeout / 1000)}s)`);
      }

      // Proactive compaction: when cumulative input tokens exceed threshold, compact aggressively
      // This prevents context window overflow before it happens (inspired by claw-code-parity's 100K threshold)
      const AUTO_COMPACT_THRESHOLD = 100_000;
      if (this.totalTokensUsed > AUTO_COMPACT_THRESHOLD && this.messages.length > 10) {
        const { messages: proactiveCompacted, removed: proactiveRemoved } = await compactMessagesWithSummary(this.messages, {
          maxTokens: Math.floor(this.config.contextWindowSize * 0.6),
          preserveSystemMessages: true,
          preserveRecentCount: 10,
          summaryModel: this.context.model,
        });
        if (proactiveRemoved > 0) {
          this.messages = proactiveCompacted;
          agentLogger.info({
            agentId: this.context.id, iteration: this.iteration,
            messagesRemoved: proactiveRemoved, totalTokens: this.totalTokensUsed,
          }, 'Proactive compaction triggered (token threshold)');
        }
      }

      // Regular compaction: compact if messages approach context window limit
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

      // Get completion from LLM (with retry for transient failures)
      const llmStart = Date.now();
      let completion: CompletionResult;
      try {
        // Skip timeout for post-delegation LLM calls (toolsDisabled means a pipeline/worker already completed)
        completion = this.toolExecutor.toolsDisabled
          ? await this.getCompletion()
          : await this.raceTimeout(this.getCompletion(), 'getCompletion');
      } catch (err) {
        const errMsg = (err as Error).message || '';

        // Handle context window overflow — aggressively compact and retry
        if (errMsg.includes('ContextWindowExceeded') || errMsg.includes('context_length_exceeded') || errMsg.includes('maximum context length')) {
          agentLogger.warn({
            agentId: this.context.id, iteration: this.iteration,
            messageCount: this.messages.length,
          }, 'Context window exceeded, compacting aggressively and retrying');

          for (const msg of this.messages) {
            if (msg.role === 'tool' && msg.content.length > 2000) {
              msg.content = msg.content.slice(0, 2000) + '\n\n[... truncated due to context window limit]';
            }
          }

          const { messages: compacted } = await compactMessagesWithSummary(this.messages, {
            maxTokens: Math.floor(this.config.contextWindowSize * 0.5),
            preserveSystemMessages: true,
            preserveRecentCount: 6,
            summaryModel: this.context.model,
          });
          this.messages = compacted;
          continue;
        }

        // Retry transient LLM failures (JSON parse, rate limit, server errors)
        const isTransient = errMsg.includes('JSON') || errMsg.includes('parse')
          || errMsg.includes('Unterminated') || errMsg.includes('500')
          || errMsg.includes('502') || errMsg.includes('503')
          || errMsg.includes('rate_limit') || errMsg.includes('overloaded');

        this.llmRetries = (this.llmRetries || 0) + 1;
        if (isTransient && this.llmRetries <= 3) {
          agentLogger.warn({
            agentId: this.context.id, iteration: this.iteration,
            error: errMsg, retry: this.llmRetries,
          }, 'Transient LLM error, retrying after delay');

          // Brief backoff: 2s, 4s, 8s
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, this.llmRetries)));

          // Remove the last assistant message if it was malformed (caused the parse error)
          if (this.messages.length > 0 && this.messages[this.messages.length - 1].role === 'assistant') {
            this.messages.pop();
          }
          continue;
        }

        throw err;
      }
      // Reset retry counter on success
      this.llmRetries = 0;
      this.totalTokensUsed += completion.usage.totalTokens;

      agentLogger.info({
        agentId: this.context.id, sessionId: this.context.sessionId,
        iteration: this.iteration, elapsedMs: this.elapsed(),
        phase: 'getCompletion', llmLatencyMs: Date.now() - llmStart,
        inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens,
        totalTokensUsed: this.totalTokensUsed,
        hasToolCalls: !!(completion.toolCalls?.length), finishReason: completion.finishReason,
      }, 'LLM call completed');

      // Handle tool calls if present
      if (completion.toolCalls?.length && !this.toolExecutor.toolsDisabled) {
        const toolNames = completion.toolCalls.map(tc => tc.name);

        // Detect hallucinated "respond" tools — smaller models sometimes invent
        // a tool to deliver their answer instead of returning plain text.
        // Extract the message and treat it as the final response.
        const RESPOND_TOOLS = new Set(['respond', 'reply', 'answer', 'send_response', 'final_answer']);
        if (completion.toolCalls.length === 1 && RESPOND_TOOLS.has(completion.toolCalls[0].name)) {
          const args = completion.toolCalls[0].arguments as Record<string, unknown>;
          const msg = (args.message || args.text || args.content || args.response) as string | undefined;
          if (msg) {
            agentLogger.info(
              { agentId: this.context.id, tool: completion.toolCalls[0].name },
              'Intercepted hallucinated respond tool, using message as final response',
            );
            return msg;
          }
        }

        // Detect repetitive tool call loops (same tool + same args N times in a row)
        const callSignature = completion.toolCalls
          .map(tc => `${tc.name}:${JSON.stringify(tc.arguments)}`)
          .join('|');
        if (callSignature === this.lastToolCallSignature) {
          this.consecutiveRepeatCount++;
          if (this.consecutiveRepeatCount >= AgentWorker.MAX_CONSECUTIVE_REPEATS) {
            agentLogger.warn({
              agentId: this.context.id, sessionId: this.context.sessionId,
              iteration: this.iteration, tools: toolNames,
              repeats: this.consecutiveRepeatCount,
            }, 'Repetitive tool call loop detected, forcing completion');
            // Inject a nudge to stop looping and return a final response
            this.messages.push({
              role: 'user' as const,
              content: '[SYSTEM] You have called the same tool multiple times with identical arguments. The task appears complete. Stop calling tools and provide your final text response now.',
              timestamp: new Date(),
            });
            continue;
          }
        } else {
          this.lastToolCallSignature = callSignature;
          this.consecutiveRepeatCount = 1;
        }

        agentLogger.info({
          agentId: this.context.id, sessionId: this.context.sessionId,
          iteration: this.iteration, elapsedMs: this.elapsed(),
          phase: 'handleToolCalls', toolCount: completion.toolCalls.length, tools: toolNames,
        }, 'Tool execution starting');

        // Emit tool_call action so channels can show tool-specific emojis
        for (const tc of completion.toolCalls) {
          this.emit('action', {
            type: 'tool_call',
            toolName: tc.name,
            toolId: this.toolExecutor.getToolId(tc.name),
            sessionId: this.context.sessionId,
          });
        }

        const toolStart = Date.now();
        // Final/delegation tools (spawn_worker, create_pipeline) manage their own timeouts.
        // Don't race the orchestrator timeout against them — a pipeline can legitimately
        // run for much longer than the orchestrator's own timeout.
        const isFinalTool = this.toolExecutor.hasFinalToolCall(completion.toolCalls);
        const toolMessages = isFinalTool
          ? await this.toolExecutor.handleToolCalls(completion.toolCalls)
          : await this.raceTimeout(
              this.toolExecutor.handleToolCalls(completion.toolCalls),
              'handleToolCalls',
            );
        this.messages.push(...toolMessages);

        agentLogger.info({
          agentId: this.context.id, sessionId: this.context.sessionId,
          iteration: this.iteration, elapsedMs: this.elapsed(),
          phase: 'handleToolCalls', toolDurationMs: Date.now() - toolStart, tools: toolNames,
        }, 'Tool execution completed');
        continue;
      }

      // Some models (e.g. Gemma4 via LiteLLM) emit tool calls as JSON text instead of structured tool_calls.
      // Detect and parse these so they execute properly.
      if (completion.content && !completion.toolCalls?.length) {
        const textToolCalls = this.parseTextToolCalls(completion.content);
        if (textToolCalls.length > 0) {
          completion.toolCalls = textToolCalls;
          // Re-run the tool call handling above
          agentLogger.info({
            agentId: this.context.id, iteration: this.iteration,
            tools: textToolCalls.map(tc => tc.name),
          }, 'Recovered tool calls from text output');

          const assistantMsg: AgentMessage = {
            role: 'assistant',
            content: '',
            toolCalls: textToolCalls,
            timestamp: new Date(),
          };
          this.messages.push(assistantMsg);

          this.emit('action', {
            toolCalls: textToolCalls.map(tc => ({
              id: tc.id, name: tc.name,
              argsSummary: JSON.stringify(tc.arguments).slice(0, 80),
            })),
          });

          const isFinalTool = this.toolExecutor.hasFinalToolCall(textToolCalls);
          const toolMessages = isFinalTool
            ? await this.toolExecutor.handleToolCalls(textToolCalls)
            : await this.raceTimeout(
                this.toolExecutor.handleToolCalls(textToolCalls),
                'handleToolCalls',
              );
          this.messages.push(...toolMessages);
          continue;
        }
      }

      // No tool calls — treat as final response
      // If content is empty (e.g. thinking tokens consumed entire output), retry up to 3 times
      if (!completion.content?.trim()) {
        this.emptyRetries = (this.emptyRetries || 0) + 1;
        if (this.emptyRetries <= 3) {
          agentLogger.warn({
            agentId: this.context.id, iteration: this.iteration,
            outputTokens: completion.usage.outputTokens, emptyRetry: this.emptyRetries,
          }, 'Empty response (likely thinking-only output), retrying');
          // Add a nudge to help the model produce visible output
          this.messages.push({ role: 'user', content: 'Please provide a direct response to the question. Do not think silently — output your answer as text.', timestamp: new Date() });
          continue;
        }
        agentLogger.warn({ agentId: this.context.id }, 'Max empty retries reached, returning fallback');
      }

      let response = completion.content || 'I was unable to generate a response.';

      // Strip raw tool call JSON that some models (e.g. Ollama/qwen3) emit as text
      response = response.replace(/\{"id":\s*"call_[^"]*",\s*"type":\s*"function",\s*"function":\s*\{[^}]*\}\s*\}/g, '').trim();

      // Strip thinking/reasoning blocks in various formats (gemma4, qwen3, etc.)
      // XML-style: <think>...</think>, <thinking>...</thinking>
      response = response.replace(/<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/g, '').trim();
      // JSON-style: {"thought":"..."} or {"thinking":"..."}
      response = response.replace(/\{"(?:thought|thinking|reasoning)"\s*:\s*"[\s\S]*?"\s*\}/g, '').trim();

      // Strip repetitive text loops (e.g. "A task orchestrator. A task orchestrator. A task...")
      // Detect any phrase repeated 5+ times and truncate
      response = response.replace(/(.{10,}?)\1{4,}/g, '$1').trim();

      // Treat trivial JSON responses ({}, [], "") as empty — the model failed to produce text
      if (/^\s*(\{\s*\}|\[\s*\]|"\s*")\s*$/.test(response)) {
        response = '';
      }

      if (!response) {
        // Try to salvage a response from tool results already in the conversation
        // instead of retrying (retries bloat context and cause timeouts on local models)
        const lastToolResult = [...this.messages].reverse().find(m => m.role === 'tool');
        if (lastToolResult?.content) {
          agentLogger.warn({ agentId: this.context.id }, 'Empty response after tool calls — returning last tool result as fallback');
          try {
            const parsed = JSON.parse(typeof lastToolResult.content === 'string' ? lastToolResult.content : JSON.stringify(lastToolResult.content));
            // Extract meaningful data from tool result
            response = `Here's what I found:\n\n${JSON.stringify(parsed, null, 2)}`;
          } catch {
            response = `Here's what I found:\n\n${lastToolResult.content}`;
          }
        } else {
          response = 'I was unable to generate a response.';
        }
      }

      // Track token usage for orchestrator agents (response is saved by handleMessage with correct content)
      if (this.context.role === 'orchestrator') {
        await sessionRepository.incrementMessageCount(this.context.sessionId, completion.usage.totalTokens);
      }

      return response;
    }

    throw new Error(`Max iterations (${this.config.maxIterations}) reached`);
  }

  /**
   * Parse tool calls emitted as JSON text by models that don't use structured tool calling.
   * Supports formats: {"call":"tool_name","arguments":{...}} and {"name":"tool_name","arguments":{...}}
   */
  private parseTextToolCalls(content: string): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
    const results: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    const registeredTools = new Set(Array.from(this.toolExecutor.getTools().keys()));

    // Extract balanced JSON objects, skipping over string contents
    const jsonBlocks: string[] = [];
    for (let i = 0; i < content.length; i++) {
      if (content[i] !== '{') continue;
      // Found a '{', try to find the matching '}' respecting strings
      let depth = 0;
      let inString = false;
      let escaped = false;
      let j = i;
      for (; j < content.length; j++) {
        const ch = content[j];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { jsonBlocks.push(content.slice(i, j + 1)); break; }
        }
      }
    }

    for (const jsonStr of jsonBlocks) {
      try {
        const parsed = JSON.parse(jsonStr);
        const toolName = parsed.call || parsed.name || parsed.function;
        const args = parsed.arguments || parsed.args || parsed.parameters || {};

        if (toolName && typeof toolName === 'string' && registeredTools.has(toolName)) {
          results.push({
            id: `call_text_${Date.now()}_${results.length}`,
            name: toolName,
            arguments: typeof args === 'object' ? args : {},
          });
        }
      } catch {
        // Not valid JSON, skip
      }
    }

    return results;
  }

  private async getCompletion(): Promise<CompletionResult> {
    const client = getLiteLLMClient();
    const registry = getModelRegistry();
    const costTracker = getCostTracker();

    const model = await registry.getModel(this.context.model) || await registry.getModelByModelId(this.context.model);
    if (!model) {
      throw new Error(`Model not found: ${this.context.model}`);
    }

    const litellmModel = model.modelId;
    const tools: ChatCompletionTool[] = this.toolExecutor.toolsDisabled
      ? []
      : Array.from(this.toolExecutor.getTools().values()).map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));

    this.emit('thought', { model: litellmModel, messageCount: this.messages.length });

    const metadata = model.metadata as import('@/db/schema/models').ModelMetadata | null;

    // Respect the model's configured extraBody (e.g. think:false).
    // The user controls thinking via the model configuration — we never override it
    // for the orchestrator. For expert workers only, remove think:false so the model
    // can reason before acting (prevents tool-call loops on smaller models).
    let extraBody = metadata?.extraBody && Object.keys(metadata.extraBody).length > 0
      ? { ...metadata.extraBody }
      : undefined;

    const isExpertWorker = this.context.metadata?.isExpert === true;
    const isOrchestrator = this.context.role === 'orchestrator';
    if (isExpertWorker && !isOrchestrator && extraBody && 'think' in extraBody) {
      delete extraBody.think;
      if (Object.keys(extraBody).length === 0) extraBody = undefined;
    }

    // Resolve API key from vault for custom/direct providers
    let apiKey: string | undefined;
    if (model.apiKeyRef) {
      try {
        const { getVault } = await import('@/security/vault');
        apiKey = await getVault().getByName('system', model.apiKeyRef) || undefined;
      } catch {}
    }

    const completionOpts = {
      model: litellmModel,
      messages: this.messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: model.defaultTemperature || 0.7,
      maxTokens: model.defaultMaxTokens || model.maxTokens || 4096,
      extraBody,
      endpoint: model.endpoint || undefined,
      apiKey,
    };

    // Route to the correct provider based on DB config.
    // Direct providers (openrouter, openai, anthropic, etc.) bypass LiteLLM.
    let result: CompletionResult;
    if (model.provider && model.provider !== 'litellm') {
      const { getProviderRouter } = await import('@/models/providers');
      const router = getProviderRouter();
      const directProvider = router.getProviderByName(model.provider);
      if (directProvider) {
        agentLogger.debug({ model: litellmModel, provider: model.provider }, 'Using direct provider');
        result = await directProvider.complete(completionOpts);
      } else {
        result = await client.complete(completionOpts);
      }
    } else {
      result = await client.complete(completionOpts);
    }

    await costTracker.logUsageWithCost(
      this.context.userId,
      this.context.model,
      result.usage.inputTokens,
      result.usage.outputTokens,
      { sessionId: this.context.sessionId, agentId: this.context.id, requestType: 'chat', metadata: { iteration: this.iteration } },
    );

    const assistantMessage: AgentMessage = {
      role: 'assistant',
      content: result.content,
      toolCalls: result.toolCalls,
      timestamp: new Date(),
    };
    this.messages.push(assistantMessage);

    return result;
  }

  stop(): void {
    this.abortController.abort();
    this.context.status = 'stopped';
    this.emit('status_change', { status: 'stopped' });
    agentLogger.info({ agentId: this.context.id }, 'Agent stopped');
  }
}
