import { spawn, type ChildProcess } from 'child_process';
import { resolve as resolvePath } from 'path';
import { getModelRegistry } from '@/models/model-registry';
import { getConfig } from '@/config';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { agentLogger } from '@/utils/logger';
import { autoIndexAgentOutput } from '@/core/rag/auto-indexer';
import { getQuotaTracker } from '@/models/quota-tracker';
import { getCLIToolConfig } from './cli-agent-factory';
import { BaseAgentWorker } from './agent-base';
import { CLIArgumentBuilder, CLIOutputParser } from './cli-adapters';
import type { AgentContext, AgentMessage } from './types';
import type { AgentWorkerConfig, ToolHandler } from './agent-base';
import type { CLIAgentConfig } from '@/db/schema/models';

/**
 * CLIAgentWorker — spawns a CLI binary (Claude Code, Gemini CLI, Codex)
 * as an autonomous sub-agent.
 */
export class CLIAgentWorker extends BaseAgentWorker {
  private systemMessages: string[] = [];
  private process: ChildProcess | null = null;
  private aborted = false;
  private argBuilder = new CLIArgumentBuilder();

  constructor(context: AgentContext, config: AgentWorkerConfig) {
    super(context, config);
  }

  /** No-op — CLI models have their own tools */
  registerTool(_tool: ToolHandler): void {}

  /** No-op — CLI models have their own tools */
  registerTools(_tools: ToolHandler[]): void {}

  addSystemMessage(content: string): void {
    this.systemMessages.push(content);
    this.messages.push({ role: 'system', content, timestamp: new Date() });
  }

  async addUserMessage(content: string): Promise<void> {
    this.messages.push({ role: 'user', content, timestamp: new Date() });
    // Only persist for orchestrator (root agent) — sub-workers use handleMessage for persistence
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
        this.context.userId, this.context.sessionId, this.context.id,
        { durationMs: Date.now() - this.context.createdAt.getTime(), iterations: this.iteration, model: this.context.model, role: this.context.role },
      );

      // Auto-index output into knowledge base (fire-and-forget)
      autoIndexAgentOutput({
        agentId: this.context.id,
        sessionId: this.context.sessionId,
        userId: this.context.userId,
        role: this.context.role,
        topic: this.context.topic,
        output: result,
      }).catch(() => {});

      return result;
    } catch (error) {
      this.context.status = 'failed';
      this.emit('status_change', { status: 'failed' });
      this.emit('error', { error: (error as Error).message });

      await auditRepository.logAgentFailed(
        this.context.userId, this.context.sessionId, this.context.id,
        { error: (error as Error).message, iteration: this.iteration, model: this.context.model, role: this.context.role },
      );

      throw error;
    }
  }

  stop(): void {
    this.aborted = true;
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
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

  // ── Private implementation ────────────────────────────────────────

  private buildPrompt(): string {
    const parts: string[] = [];
    for (const msg of this.messages) {
      if (msg.role === 'system') parts.push(`[System] ${msg.content}`);
      else if (msg.role === 'user') parts.push(msg.content);
      else if (msg.role === 'assistant') parts.push(`[Assistant] ${msg.content}`);
    }
    return parts.join('\n\n');
  }

  private async getCLISettings(): Promise<CLIAgentConfig> {
    const registry = getModelRegistry();
    const model =
      (await registry.getModel(this.context.model)) ||
      (await registry.getModelByModelId(this.context.model));
    return model?.metadata?.cliAgent || {};
  }

  private async executeCLI(): Promise<string> {
    const toolConfig = getCLIToolConfig(this.context.model);
    if (!toolConfig) {
      throw new Error(`No CLI tool config found for model: ${this.context.model}`);
    }

    // Check quota
    const quotaTracker = getQuotaTracker();
    const quota = await quotaTracker.getStatus(toolConfig.quotaProvider);
    if (quota.exhausted) {
      throw new Error(`Quota exhausted for ${toolConfig.name}. Resets at ${quota.resetsAt?.toISOString() || 'unknown'}`);
    }

    const prompt = this.buildPrompt();
    const settings = await this.getCLISettings();
    const { binary, args } = this.argBuilder.build(toolConfig.name, prompt, settings, this.systemMessages);

    agentLogger.info(
      { agentId: this.context.id, tool: toolConfig.name, model: this.context.model },
      'Spawning CLI sub-agent',
    );
    this.emit('thought', { model: this.context.model, tool: toolConfig.name, status: 'spawning' });

    const parser = new CLIOutputParser(
      this.context.id,
      this.context.model,
      (type, data) => this.emit(type, data),
      () => { this.iteration++; },
    );

    const startTime = Date.now();

    return new Promise<string>((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;

      // Run in workspace root, not the assistant project directory
      let workspaceCwd: string;
      try {
        workspaceCwd = resolvePath(getConfig().workspace.rootPath);
      } catch {
        workspaceCwd = process.cwd();
      }

      const proc = spawn(binary, args, {
        env,
        cwd: workspaceCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.config.timeout,
      });

      this.process = proc;

      let accumulatedText = '';
      let stderr = '';
      let lineBuffer = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const result = parser.parse(event, toolConfig.name);
            if (result) {
              if (result.replace) {
                accumulatedText = result.text;
              } else {
                accumulatedText += result.text;
              }
            }
          } catch {
            agentLogger.debug({ line: line.slice(0, 200) }, 'Non-JSON CLI output');
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', async (code) => {
        this.process = null;

        // Process remaining buffer
        if (lineBuffer.trim()) {
          try {
            const event = JSON.parse(lineBuffer);
            const result = parser.parse(event, toolConfig.name);
            if (result) {
              if (result.replace) accumulatedText = result.text;
              else accumulatedText += result.text;
            }
          } catch {
            if (!accumulatedText && lineBuffer.trim()) {
              accumulatedText = lineBuffer.trim();
            }
          }
        }

        if (this.aborted) {
          reject(new Error('CLI agent execution aborted'));
          return;
        }

        if (toolConfig.isQuotaError(stderr || accumulatedText)) {
          await quotaTracker.markExhausted(toolConfig.quotaProvider);
          reject(new Error(`Quota exhausted for ${toolConfig.name}`));
          return;
        }

        if (code !== 0 && !accumulatedText) {
          reject(new Error(`CLI ${binary} exited with code ${code}: ${stderr || 'no output'}`));
          return;
        }

        // Only persist for orchestrator (root agent) — sub-workers use handleMessage for persistence
        if (accumulatedText && this.context.role === 'orchestrator') {
          await messageRepository.create({
            sessionId: this.context.sessionId,
            role: 'assistant',
            content: accumulatedText,
            agentId: this.context.id,
          });
          await sessionRepository.incrementMessageCount(this.context.sessionId);
        }

        agentLogger.info(
          { agentId: this.context.id, tool: toolConfig.name, durationMs: Date.now() - startTime, iterations: this.iteration },
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
}
