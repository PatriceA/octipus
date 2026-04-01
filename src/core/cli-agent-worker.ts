import { spawn, type ChildProcess } from 'child_process';
import { resolve as resolvePath, join as joinPath } from 'path';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { getModelRegistry } from '@/models/model-registry';
import { getConfig } from '@/config';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { agentRepository } from '@/db/repositories/agent-repository';
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

      // Don't mark as completed if we were stopped mid-execution
      if (this.aborted) {
        this.context.status = 'stopped';
        this.emit('status_change', { status: 'stopped' });
        const durationMs = Date.now() - this.context.createdAt.getTime();
        agentRepository.updateStatus(this.context.id, {
          status: 'stopped',
          iterations: this.iteration,
          durationMs,
        }).catch(() => {});
        throw new Error('Agent was aborted by user');
      }

      this.context.status = 'completed';
      this.emit('status_change', { status: 'completed' });
      this.emit('complete', { result });

      const durationMs = Date.now() - this.context.createdAt.getTime();
      await auditRepository.logAgentCompleted(
        this.context.userId, this.context.sessionId, this.context.id,
        { durationMs, iterations: this.iteration, model: this.context.model, role: this.context.role },
      );

      agentRepository.updateStatus(this.context.id, {
        status: 'completed',
        iterations: this.iteration,
        durationMs,
      }).catch(err => agentLogger.error({ err, agentId: this.context.id }, 'Failed to persist agent completion'));

      // Auto-index output into knowledge base
      autoIndexAgentOutput({
        agentId: this.context.id,
        sessionId: this.context.sessionId,
        userId: this.context.userId,
        role: this.context.role,
        topic: this.context.topic,
        output: result,
      }).catch(err => agentLogger.warn({ err, agentId: this.context.id }, 'Failed to index agent output'));

      return result;
    } catch (error) {
      this.context.status = 'failed';
      this.emit('status_change', { status: 'failed' });
      this.emit('error', { error: (error as Error).message });

      const failDurationMs = Date.now() - this.context.createdAt.getTime();
      await auditRepository.logAgentFailed(
        this.context.userId, this.context.sessionId, this.context.id,
        { error: (error as Error).message, iteration: this.iteration, model: this.context.model, role: this.context.role },
      );

      agentRepository.updateStatus(this.context.id, {
        status: 'failed',
        iterations: this.iteration,
        durationMs: failDurationMs,
        error: (error as Error).message,
      }).catch(err => agentLogger.error({ err, agentId: this.context.id }, 'Failed to persist agent failure'));

      throw error;
    }
  }

  stop(): void {
    this.aborted = true;
    if (this.process && !this.process.killed) {
      const pid = this.process.pid;

      // Destroy streams first to stop event processing immediately
      try { this.process.stdout?.destroy(); } catch { /* ignore */ }
      try { this.process.stderr?.destroy(); } catch { /* ignore */ }
      try { this.process.stdin?.destroy(); } catch { /* ignore */ }

      if (process.platform === 'win32' && pid) {
        // On Windows, SIGTERM doesn't work for shell:true processes (cmd.exe wraps child).
        // taskkill /F /T kills the entire process tree.
        try {
          const { execSync } = require('child_process');
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
        } catch {
          try { this.process.kill('SIGKILL'); } catch { /* already dead */ }
        }
      } else {
        this.process.kill('SIGTERM');
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL');
          }
        }, 5000);
      }
    }
    this.context.status = 'stopped';
    this.emit('status_change', { status: 'stopped' });
    agentLogger.info({ agentId: this.context.id }, 'CLI agent stopped');
  }

  // ── Private implementation ────────────────────────────────────────

  /**
   * Build the conversation prompt (user + assistant messages only).
   * System messages are handled separately via buildSystemPrompt().
   */
  private buildPrompt(): string {
    const parts: string[] = [];

    for (const msg of this.messages) {
      if (msg.role === 'user') {
        parts.push(msg.content);
      } else if (msg.role === 'assistant') {
        parts.push(`[Assistant] ${msg.content}`);
      }
      // System messages are excluded — they go through buildSystemPrompt()
    }

    return parts.join('\n\n');
  }

  /**
   * Build the system instruction from all system messages.
   * This is passed separately to CLI tools (--append-system-prompt for Claude,
   * stdin for Gemini) so it's treated as authoritative context rather than
   * user-level prompt text.
   */
  private buildSystemPrompt(): string | null {
    const systemParts: string[] = [];
    for (const msg of this.messages) {
      if (msg.role === 'system') {
        systemParts.push(msg.content);
      }
    }
    if (systemParts.length === 0) return null;
    return systemParts.join('\n\n');
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
    const systemPrompt = this.buildSystemPrompt();
    const settings = await this.getCLISettings();
    const { binary, args, stdinPrompt } = this.argBuilder.build(toolConfig.name, prompt, settings, this.systemMessages, systemPrompt);

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

    // Resolve cwd: dev mode sessions use project path, otherwise workspace root
    let workspaceCwd: string;
    try {
      const session = await sessionRepository.findById(this.context.sessionId);
      const sessionCtx = session?.context as import('@/db/schema/sessions').SessionContext | undefined;
      if (sessionCtx?.devMode && sessionCtx.projectPath) {
        workspaceCwd = resolvePath(sessionCtx.projectPath);
      } else {
        workspaceCwd = resolvePath(getConfig().workspace.rootPath);
      }
    } catch {
      workspaceCwd = process.cwd();
    }

    // Write temporary project context files so CLI tools pick up the expert identity.
    // Gemini reads GEMINI.md, Codex reads AGENTS.md from the cwd.
    // These are cleaned up after the CLI process exits.
    const tempContextFiles: string[] = [];
    agentLogger.info(
      { tool: toolConfig.name, hasSystemPrompt: !!systemPrompt, systemPromptLen: systemPrompt?.length || 0, cwd: workspaceCwd },
      'CLI agent context check',
    );
    if (systemPrompt) {
      const contextFileMap: Record<string, string> = {
        'Gemini CLI': 'GEMINI.md',
        'Codex CLI': 'AGENTS.md',
      };
      const contextFileName = contextFileMap[toolConfig.name];
      if (contextFileName) {
        const contextFilePath = joinPath(workspaceCwd, contextFileName);
        // Only write if no existing file (don't overwrite user's own)
        if (!existsSync(contextFilePath)) {
          try {
            writeFileSync(contextFilePath, systemPrompt, 'utf-8');
            tempContextFiles.push(contextFilePath);
            agentLogger.info({ tool: toolConfig.name, file: contextFileName, path: contextFilePath }, 'Wrote temp context file for CLI agent');
          } catch (err) {
            agentLogger.debug({ err, file: contextFileName }, 'Failed to write temp context file');
          }
        }
      }
    }

    // Cleanup helper
    const cleanupContextFiles = () => {
      for (const f of tempContextFiles) {
        try { unlinkSync(f); } catch { /* already gone */ }
      }
    };

    // On Windows: shell: true is required for .cmd wrappers, and prompts are piped
    // via stdin (set up by CLIArgumentBuilder) to avoid shell argument mangling.
    return new Promise<string>((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;

      const proc = spawn(binary, args, {
        env,
        cwd: workspaceCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.config.timeout,
        shell: process.platform === 'win32',
      });

      // Pipe prompt via stdin on Windows (avoids shell mangling of long args)
      if (stdinPrompt && proc.stdin) {
        proc.stdin.write(stdinPrompt);
        proc.stdin.end();
      } else if (proc.stdin) {
        proc.stdin.end();
      }

      this.process = proc;

      // Hard timeout: forcefully kill the CLI process if it exceeds the configured timeout.
      // The spawn `timeout` option is unreliable across platforms.
      const hardTimeout = setTimeout(() => {
        if (!this.aborted && this.process && !this.process.killed) {
          agentLogger.warn(
            { agentId: this.context.id, tool: toolConfig.name, timeoutMs: this.config.timeout },
            'CLI agent exceeded hard timeout, force-killing',
          );
          this.stop();
        }
      }, this.config.timeout);

      let accumulatedText = '';
      let stderr = '';
      let lineBuffer = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        if (this.aborted) return; // Stop processing events after abort
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || this.aborted) continue;
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
        clearTimeout(hardTimeout);
        cleanupContextFiles();
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
          resolve(accumulatedText || 'Task was stopped. Would you like to adjust the request or start something new?');
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

        if (this.aborted) {
          resolve(accumulatedText || 'Task was stopped. Would you like to adjust the request or start something new?');
        } else {
          resolve(accumulatedText || '(no response)');
        }
      });

      proc.on('error', (err) => {
        clearTimeout(hardTimeout);
        cleanupContextFiles();
        this.process = null;
        reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
      });
    });
  }
}
