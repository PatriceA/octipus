import { type ChildProcess, spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join as joinPath, resolve as resolvePath } from 'path';
import { getConfig } from '@/config';
import { recordAgentCompletion } from '@/core/agent-task-recorder';
import { agentRepository } from '@/db/repositories/agent-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { CLIAgentConfig } from '@/db/schema/models';
import { getModelRegistry } from '@/models/model-registry';
import { getQuotaTracker } from '@/models/quota-tracker';
import { agentLogger, coreLogger } from '@/utils/logger';
import type { AgentWorkerConfig, ToolHandler } from './agent-base';
import { BaseAgentWorker } from './agent-base';
import { CLIArgumentBuilder, CLIOutputParser } from './cli-adapters';
import { BudgetExceededError } from './swarm/errors';
import { getCLIToolConfig } from './cli-agent-factory';
import type { AgentContext, AgentMessage } from './types';

/**
 * CLIAgentWorker — spawns a CLI binary (Claude Code, Gemini CLI, Codex)
 * as an autonomous sub-agent.
 */
export class CLIAgentWorker extends BaseAgentWorker {
  private systemMessages: string[] = [];
  private process: ChildProcess | null = null;
  private aborted = false;
  private argBuilder = new CLIArgumentBuilder();
  /**
   * Running total of tokens reported by the CLI provider across all turns.
   * Populated from `CLIOutputParser.onTokenUsage`. Without this, swarm nodes
   * on CLI-backed models record `usedTokens = 0` because the base class
   * returns 0 for `getTotalTokens()`.
   */
  private totalTokens = 0;
  /**
   * Set by the token-usage callback when the CLI subprocess crosses its
   * `maxTokenBudget`. The base `AgentWorker` does this synchronously before
   * each LLM call; CLI workers can't intercept inter-turn calls, so the next
   * best gate is the token-usage report — when it crosses the cap, we kill
   * the subprocess and surface `BudgetExceededError` from `executeCLI()`.
   */
  private budgetExceeded = false;
  /**
   * Cleanup for the parent AbortSignal listener. Symmetric with `AgentWorker`
   * (Swarm Phase 2): when an ancestor aborts, the cascade reaches the CLI
   * worker too — it triggers `stop()` which kills the subprocess.
   */
  private parentSignalCleanup: (() => void) | null = null;

  constructor(
    context: AgentContext,
    config: AgentWorkerConfig,
    opts?: { parentSignal?: AbortSignal },
  ) {
    super(context, config);

    if (opts?.parentSignal) {
      const parent = opts.parentSignal;
      if (parent.aborted) {
        // Already aborted at construction — fire on next tick so the caller
        // has a chance to wire onEvent handlers before the abort lands.
        queueMicrotask(() => this.stop());
      } else {
        const onAbort = () => this.stop();
        parent.addEventListener('abort', onAbort, { once: true });
        this.parentSignalCleanup = () => parent.removeEventListener('abort', onAbort);
      }
    }
  }

  /** Return the running token count reported by the underlying CLI provider. */
  override getTotalTokens(): number {
    return this.totalTokens;
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
        this.context.completedAt = new Date();
        this.emit('status_change', { status: 'stopped' });
        const durationMs = Date.now() - this.context.createdAt.getTime();
        agentRepository.updateStatus(this.context.id, {
          status: 'stopped',
          iterations: this.iteration,
          durationMs,
        }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in cli-agent-worker'));
        throw new Error('Agent was aborted by user');
      }

      this.context.status = 'completed';
      this.context.completedAt = new Date();
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

      // Record completion to task_state (Phase B of memory-redesign).
      // Fire-and-forget — never block on recording failures.
      recordAgentCompletion({
        agentId: this.context.id,
        sessionId: this.context.sessionId,
        userId: this.context.userId,
        workspaceId: this.context.workspaceId ?? null,
        swarmNodeId: this.context.id,
        role: this.context.role,
        topic: this.context.topic,
        output: result,
      }).catch(err => agentLogger.warn({ err, agentId: this.context.id }, 'Failed to record agent completion'));

      return result;
    } catch (error) {
      this.context.status = 'failed';
      this.context.completedAt = new Date();
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
    if (this.parentSignalCleanup) {
      this.parentSignalCleanup();
      this.parentSignalCleanup = null;
    }
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
    this.context.completedAt = new Date();
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
        parts.push(`[Octipus] ${msg.content}`);
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
    const { binary, args, stdinPrompt, useShell, env: toolEnv } = this.argBuilder.build(toolConfig.name, prompt, settings, this.systemMessages, systemPrompt, this.config.maxTokenBudget);

    agentLogger.info(
      { agentId: this.context.id, tool: toolConfig.name, model: this.context.model },
      'Spawning CLI sub-agent',
    );
    this.emit('thought', { model: this.context.model, tool: toolConfig.name, status: 'spawning' });

    const parser = new CLIOutputParser(
      this.context.id,
      this.context.model,
      (type, data) => this.emit(type, data),
      () => {
        this.iteration++;
        // Surface iteration ticks so the chat UI can render live progress.
        // Base `action` event with a per-tool-call entry already fires; this
        // extra `thought` carries just the counter so the sidepanel can
        // update `agent.iterations` without re-counting tool calls.
        this.emit('thought', { type: 'iteration_update', iteration: this.iteration });
      },
      (tokens) => {
        this.totalTokens += tokens.total;
        const cap = this.config.maxTokenBudget;
        if (!this.budgetExceeded && cap > 0 && this.totalTokens >= cap) {
          this.budgetExceeded = true;
          agentLogger.warn(
            { agentId: this.context.id, used: this.totalTokens, cap },
            'CLI sub-agent exceeded token budget — killing subprocess',
          );
          this.stop();
        }
      },
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
      { tool: toolConfig.name, hasSystemPrompt: !!systemPrompt, cwd: workspaceCwd },
      'CLI agent context',
    );

    try {
      const dumpDir = joinPath(homedir(), '.octipus', 'prompts');
      mkdirSync(dumpDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dumpPath = joinPath(dumpDir, `${ts}_${this.context.id}_${toolConfig.name.replace(/\s+/g, '-')}.md`);
      const body = [
        `# Agent ${this.context.id}`,
        `tool: ${toolConfig.name}`,
        `model: ${this.context.model}`,
        `cwd: ${workspaceCwd}`,
        '',
        '## System Prompt',
        systemPrompt || '(none)',
        '',
        '## User Prompt',
        prompt || '(none)',
        '',
        '## stdinPrompt',
        stdinPrompt || '(none)',
        '',
        '## CLI args',
        '```',
        [binary, ...args].join(' '),
        '```',
      ].join('\n');
      writeFileSync(dumpPath, body, 'utf-8');
      agentLogger.info({ agentId: this.context.id, path: dumpPath }, 'Dumped CLI agent prompt');
    } catch (err) {
      agentLogger.debug({ err, agentId: this.context.id }, 'Failed to dump CLI agent prompt');
    }
    if (systemPrompt) {
      const contextFileMap: Record<string, string> = {
        'Gemini CLI': 'GEMINI.md',
        'Codex CLI': 'AGENTS.md',
        // vibe reads AGENTS.md from the workdir for project context.
        'Mistral Vibe': 'AGENTS.md',
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

    // Cleanup helper — removes temp context files and any ephemeral per-spawn
    // VIBE_HOME the arg builder created for vibe's MCP registration.
    const tempVibeHome = toolEnv?.VIBE_HOME;
    const cleanupContextFiles = () => {
      for (const f of tempContextFiles) {
        try { unlinkSync(f); } catch { /* already gone */ }
      }
      if (tempVibeHome && tempVibeHome.includes('octipus-cli')) {
        try { rmSync(tempVibeHome, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    };

    // On Windows: shell: true is required for .cmd wrappers, and prompts are piped
    // via stdin (set up by CLIArgumentBuilder) to avoid shell argument mangling.
    //
    // useShell:false override — when the adapter has already wrapped the call in a
    // shell of its own (e.g. Gemini-on-Windows uses powershell.exe with a generated
    // .ps1 to dodge cmd.exe argv re-tokenization), we MUST NOT double-wrap or
    // Node's shell:true escaping mangles the prompt all over again.
    const useShellForSpawn = useShell !== false && process.platform === 'win32';
    return new Promise<string>((resolve, reject) => {
      // toolEnv carries per-tool overrides (e.g. vibe's ephemeral VIBE_HOME that
      // registers the Octipus MCP server).
      const env = { ...process.env, ...(toolEnv || {}) };
      delete env.CLAUDECODE;

      const proc = spawn(binary, args, {
        env,
        cwd: workspaceCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.config.timeout,
        shell: useShellForSpawn,
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
      // Buffer-at-end tools (e.g. vibe --output json) emit their whole result as
      // one blob at process close, not incremental stream-json events. For those
      // we collect raw stdout and run parseOutput on the full buffer in `close`.
      let rawStdout = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        if (this.aborted) return; // Stop processing events after abort
        if (toolConfig.bufferOutput) {
          rawStdout += chunk.toString();
          return;
        }
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

        // Buffer-at-end tools: parse the whole accumulated stdout via the tool's
        // parseOutput (the streaming line-parser above is skipped for these).
        if (toolConfig.bufferOutput) {
          try {
            const parsed = toolConfig.parseOutput(rawStdout, startTime);
            accumulatedText = parsed.content;
            // Usage is typically 0 for these tools (vibe reports none); only add
            // if the parser surfaced real counts.
            if (parsed.usage.totalTokens > 0) {
              this.totalTokens += parsed.usage.totalTokens;
            }
          } catch (err) {
            agentLogger.warn({ err, agentId: this.context.id, tool: toolConfig.name }, 'Buffer-mode parseOutput failed; falling back to raw stdout');
            accumulatedText = rawStdout.trim();
          }
        } else if (lineBuffer.trim()) {
          // Process remaining streamed line buffer
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

        if (this.budgetExceeded) {
          reject(new BudgetExceededError({
            agentId: this.context.id,
            used: this.totalTokens,
            cap: this.config.maxTokenBudget,
          }));
          return;
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
