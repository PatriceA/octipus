import { spawn, type ChildProcess } from 'child_process';
import { getModelRegistry } from '@/models/model-registry';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { agentLogger } from '@/utils/logger';
import { getQuotaTracker } from '@/models/quota-tracker';
import { getCLIToolConfig } from './cli-agent-factory';
import type { AgentContext, AgentMessage, AgentStatus } from './types';
import type { AgentWorkerConfig, ToolHandler, AgentEvent, AgentEventHandler } from './agent-worker';
import type { CLIAgentConfig } from '@/db/schema/models';

/**
 * CLIAgentWorker — spawns a CLI binary (Claude Code, Gemini CLI, Codex)
 * as an autonomous sub-agent. The CLI handles its own agent loop, tools,
 * and reasoning; we stream its output and emit AgentEvents.
 */
export class CLIAgentWorker {
  private context: AgentContext;
  private config: AgentWorkerConfig;
  private systemMessages: string[] = [];
  private messages: AgentMessage[] = [];
  private eventHandlers: Set<AgentEventHandler> = new Set();
  private process: ChildProcess | null = null;
  private aborted = false;
  private iteration = 0;

  constructor(context: AgentContext, config: AgentWorkerConfig) {
    this.context = context;
    this.config = config;
  }

  // ── Public interface (matches AgentWorker) ────────────────────────

  /**
   * Run the CLI sub-agent with the given user message.
   * Spawns the CLI binary, streams output, returns the final text response.
   */
  async run(userMessage?: string): Promise<string> {
    if (userMessage) {
      await this.addUserMessage(userMessage);
    }

    this.context.status = 'running';
    this.emit('status_change', { status: 'running' });

    try {
      const result = await this.executeCLI();
      this.context.status = 'completed';
      this.emit('status_change', { status: 'completed' });
      this.emit('complete', { result });

      await auditRepository.logAgentCompleted(
        this.context.userId,
        this.context.sessionId,
        this.context.id,
        Date.now() - this.context.createdAt.getTime(),
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
        (error as Error).message,
      );

      throw error;
    }
  }

  stop(): void {
    this.aborted = true;
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      // Force kill after 5s if still alive
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }
    this.context.status = 'stopped';
    this.emit('status_change', { status: 'stopped' });
    agentLogger.info({ agentId: this.context.id }, 'CLI agent stopped');
  }

  getStatus(): AgentStatus {
    return this.context.status;
  }

  getContext(): AgentContext {
    return this.context;
  }

  getIteration(): number {
    return this.iteration;
  }

  /** No-op — CLI models have their own tools */
  registerTool(_tool: ToolHandler): void {
    // CLI agents use their own built-in tools
  }

  /** No-op — CLI models have their own tools */
  registerTools(_tools: ToolHandler[]): void {
    // CLI agents use their own built-in tools
  }

  onEvent(handler: AgentEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  addSystemMessage(content: string): void {
    this.systemMessages.push(content);
    this.messages.push({ role: 'system', content, timestamp: new Date() });
  }

  async addUserMessage(content: string): Promise<void> {
    const message: AgentMessage = { role: 'user', content, timestamp: new Date() };
    this.messages.push(message);

    await messageRepository.create({
      sessionId: this.context.sessionId,
      role: 'user',
      content,
      agentId: this.context.id,
    });

    await sessionRepository.incrementMessageCount(this.context.sessionId);
  }

  async loadHistory(): Promise<void> {
    const dbMessages = await messageRepository.findBySession(this.context.sessionId);
    this.messages = dbMessages.map((msg) => ({
      role: msg.role as AgentMessage['role'],
      content: msg.content,
      timestamp: msg.createdAt,
    }));
    agentLogger.debug(
      { agentId: this.context.id, messageCount: this.messages.length },
      'CLI agent history loaded',
    );
  }

  // ── Private implementation ────────────────────────────────────────

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
   * Build the prompt from system messages + conversation history + user message
   */
  private buildPrompt(): string {
    const parts: string[] = [];

    for (const msg of this.messages) {
      if (msg.role === 'system') {
        parts.push(`[System] ${msg.content}`);
      } else if (msg.role === 'user') {
        parts.push(msg.content);
      } else if (msg.role === 'assistant') {
        parts.push(`[Assistant] ${msg.content}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Get CLI agent settings from model metadata
   */
  private async getCLISettings(): Promise<CLIAgentConfig> {
    const registry = getModelRegistry();
    const model =
      (await registry.getModel(this.context.model)) ||
      (await registry.getModelByModelId(this.context.model));
    return model?.metadata?.cliAgent || {};
  }

  /**
   * Build CLI arguments based on the tool type and settings
   */
  private buildArgs(
    toolName: string,
    prompt: string,
    settings: CLIAgentConfig,
  ): { binary: string; args: string[] } {
    switch (toolName) {
      case 'Claude Code':
        return this.buildClaudeArgs(prompt, settings);
      case 'Gemini CLI':
        return this.buildGeminiArgs(prompt, settings);
      case 'Codex CLI':
        return this.buildCodexArgs(prompt);
      default:
        throw new Error(`Unknown CLI tool: ${toolName}`);
    }
  }

  private buildClaudeArgs(
    prompt: string,
    settings: CLIAgentConfig,
  ): { binary: string; args: string[] } {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

    // Permission mode
    const permMode = settings.permissionMode || 'bypassPermissions';
    args.push('--permission-mode', permMode);

    // System prompt (use --append-system-prompt to keep defaults)
    if (this.systemMessages.length > 0) {
      args.push('--append-system-prompt', this.systemMessages.join('\n'));
    }

    // MCP config
    if (settings.mcpConfigPath) {
      args.push('--mcp-config', settings.mcpConfigPath);
    }

    // Allowed tools
    if (settings.allowedTools?.length) {
      args.push('--allowedTools', ...settings.allowedTools);
    }

    // Budget cap
    if (settings.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(settings.maxBudgetUsd));
    }

    // Extra args
    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    return { binary: 'claude', args };
  }

  private buildGeminiArgs(
    prompt: string,
    settings: CLIAgentConfig,
  ): { binary: string; args: string[] } {
    const args = ['-p', prompt, '-o', 'stream-json'];

    // Permission mode
    const approvalMode = settings.permissionMode || 'yolo';
    args.push('--approval-mode', approvalMode);

    // Extra args
    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    return { binary: 'gemini', args };
  }

  private buildCodexArgs(prompt: string): { binary: string; args: string[] } {
    return { binary: 'codex', args: ['exec', '--json', prompt] };
  }

  /**
   * Execute the CLI binary and stream its output
   */
  private async executeCLI(): Promise<string> {
    const toolConfig = getCLIToolConfig(this.context.model);
    if (!toolConfig) {
      throw new Error(`No CLI tool config found for model: ${this.context.model}`);
    }

    // Check quota
    const quotaTracker = getQuotaTracker();
    const quota = await quotaTracker.getStatus(toolConfig.quotaProvider);
    if (quota.exhausted) {
      throw new Error(
        `Quota exhausted for ${toolConfig.name}. Resets at ${quota.resetsAt?.toISOString() || 'unknown'}`,
      );
    }

    const prompt = this.buildPrompt();
    const settings = await this.getCLISettings();
    const { binary, args } = this.buildArgs(toolConfig.name, prompt, settings);

    agentLogger.info(
      { agentId: this.context.id, tool: toolConfig.name, model: this.context.model },
      'Spawning CLI sub-agent',
    );
    this.emit('thought', { model: this.context.model, tool: toolConfig.name, status: 'spawning' });

    const startTime = Date.now();

    return new Promise<string>((resolve, reject) => {
      // Unset CLAUDECODE to avoid nested session detection when spawning Claude Code
      const env = { ...process.env };
      delete env.CLAUDECODE;

      const proc = spawn(binary, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.config.timeout,
      });

      this.process = proc;

      let accumulatedText = '';
      let stderr = '';
      let lineBuffer = '';

      // Process stdout line by line (JSONL)
      proc.stdout.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        // Keep the last incomplete line in the buffer
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const result = this.processStreamEvent(event, toolConfig.name);
            if (result) {
              if (result.replace) {
                accumulatedText = result.text;
              } else {
                accumulatedText += result.text;
              }
            }
          } catch {
            // Non-JSON line, ignore
            agentLogger.debug({ line: line.slice(0, 200) }, 'Non-JSON CLI output');
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', async (code) => {
        this.process = null;

        // Process any remaining data in the buffer
        if (lineBuffer.trim()) {
          try {
            const event = JSON.parse(lineBuffer);
            const result = this.processStreamEvent(event, toolConfig.name);
            if (result) {
              if (result.replace) {
                accumulatedText = result.text;
              } else {
                accumulatedText += result.text;
              }
            }
          } catch {
            // If it's plain text, use it as the result
            if (!accumulatedText && lineBuffer.trim()) {
              accumulatedText = lineBuffer.trim();
            }
          }
        }

        const durationMs = Date.now() - startTime;

        if (this.aborted) {
          reject(new Error('CLI agent execution aborted'));
          return;
        }

        // Check for quota errors
        if (toolConfig.isQuotaError(stderr || accumulatedText)) {
          await quotaTracker.markExhausted(toolConfig.quotaProvider);
          reject(new Error(`Quota exhausted for ${toolConfig.name}`));
          return;
        }

        if (code !== 0 && !accumulatedText) {
          reject(
            new Error(`CLI ${binary} exited with code ${code}: ${stderr || 'no output'}`),
          );
          return;
        }

        // Persist the assistant response
        if (accumulatedText) {
          await messageRepository.create({
            sessionId: this.context.sessionId,
            role: 'assistant',
            content: accumulatedText,
            agentId: this.context.id,
          });
          await sessionRepository.incrementMessageCount(this.context.sessionId);
        }

        agentLogger.info(
          {
            agentId: this.context.id,
            tool: toolConfig.name,
            durationMs,
            iterations: this.iteration,
          },
          'CLI sub-agent completed',
        );

        resolve(accumulatedText || '(no response)');
      });

      proc.on('error', (err) => {
        this.process = null;
        reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
      });
    });
  }

  /**
   * Process a streaming JSON event from the CLI binary.
   * Returns { text, replace } — text to add, replace=true means reset accumulated text.
   */
  private processStreamEvent(event: Record<string, unknown>, toolName: string): { text: string; replace?: boolean } | null {
    const type = event.type as string;

    // ── Claude Code stream-json format ──
    if (toolName === 'Claude Code') {
      return this.processClaudeEvent(event, type);
    }

    // ── Gemini CLI stream-json format ──
    if (toolName === 'Gemini CLI') {
      return this.processGeminiEvent(event, type);
    }

    // ── Codex CLI JSONL format ──
    if (toolName === 'Codex CLI') {
      return this.processCodexEvent(event, type);
    }

    return null;
  }

  private processClaudeEvent(event: Record<string, unknown>, type: string): { text: string; replace?: boolean } | null {
    // stream_event wraps raw Claude API events
    if (type === 'stream_event') {
      const inner = event.event as Record<string, unknown> | undefined;
      if (!inner) return null;

      const innerType = inner.type as string;

      if (innerType === 'content_block_start') {
        const block = inner.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          this.iteration++;
          this.emit('action', {
            tool: block.name,
            type: 'cli_tool_use',
            toolName: block.name,
          });
        }
      }

      if (innerType === 'content_block_delta') {
        const delta = inner.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta') {
          // Don't emit individual text deltas as events — too noisy
          return null;
        }
      }

      return null;
    }

    // AssistantMessage — complete assistant turn
    if (type === 'assistant') {
      const content = event.message as Record<string, unknown> | undefined;
      if (content?.content) {
        const blocks = content.content as Array<Record<string, unknown>>;
        const textBlocks = blocks.filter((b) => b.type === 'text');
        if (textBlocks.length > 0) {
          const text = textBlocks.map((b) => b.text as string).join('');
          this.emit('thought', { text: text.slice(0, 200), model: this.context.model });
          return { text, replace: true };
        }
      }
      return null;
    }

    // ResultMessage — final result (replaces any accumulated text)
    if (type === 'result') {
      const result = (event.result as string) || '';
      if (result) {
        return { text: result, replace: true };
      }
      const text = event.text as string | undefined;
      return text ? { text, replace: true } : null;
    }

    return null;
  }

  private processGeminiEvent(event: Record<string, unknown>, type: string): { text: string; replace?: boolean } | null {
    // Gemini stream-json format:
    // {"type":"init", "session_id":"...", "model":"..."}
    // {"type":"message", "role":"user", "content":"..."}
    // {"type":"message", "role":"assistant", "content":"...", "delta":true}
    // {"type":"tool_call", "tool":"...", "args":{...}}
    // {"type":"tool_result", "tool":"...", "result":"..."}
    // {"type":"result", "status":"success", "stats":{...}}

    if (type === 'init') {
      const model = event.model as string || 'gemini';
      this.emit('thought', { model, status: 'initialized', sessionId: event.session_id });
      return null;
    }

    if (type === 'message') {
      const role = event.role as string;
      const content = event.content as string | undefined;

      if (role === 'assistant' && content) {
        // Gemini sends delta:true for streaming chunks — accumulate them
        return { text: content };
      }
      return null;
    }

    if (type === 'tool_use' || type === 'tool_call') {
      this.iteration++;
      this.emit('action', {
        tool: event.tool_name || event.tool || event.name || 'unknown',
        type: 'cli_tool_use',
        toolName: event.tool_name || event.tool || event.name,
        args: event.parameters || event.args,
      });
      return null;
    }

    if (type === 'tool_result') {
      this.emit('observation', {
        tool: event.tool_name || event.tool || event.name,
        toolId: event.tool_id,
        status: event.status,
        result: typeof event.output === 'string' ? (event.output as string).slice(0, 500) : event.output,
      });
      return null;
    }

    if (type === 'result') {
      const stats = event.stats as Record<string, unknown> | undefined;
      if (stats) {
        this.emit('thought', {
          status: 'completed',
          stats: {
            totalTokens: stats.total_tokens,
            inputTokens: stats.input_tokens,
            outputTokens: stats.output_tokens,
            durationMs: stats.duration_ms,
            toolCalls: stats.tool_calls,
          },
        });
      }
      // Result event doesn't contain the text — it was in the last assistant message
      return null;
    }

    return null;
  }

  private processCodexEvent(event: Record<string, unknown>, type: string): { text: string; replace?: boolean } | null {
    // Codex JSONL events
    if (type === 'message' && event.content) {
      return { text: event.content as string };
    }
    if (type === 'result' && event.text) {
      return { text: event.text as string, replace: true };
    }
    if (type === 'tool_call') {
      this.iteration++;
      this.emit('action', {
        tool: event.name || 'unknown',
        type: 'cli_tool_use',
        toolName: event.name,
      });
    }
    return null;
  }
}
