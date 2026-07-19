import { createHash } from 'crypto';
import { type ChildProcess, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
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
import { CLIArgumentBuilder, CLIOutputParser, sweepStaleFiles } from './cli-adapters';
import type { CLIToolConfig } from '@/models/providers/cli-provider';
import { BudgetExceededError } from './swarm/errors';
import { getCLIToolConfig } from './cli-agent-factory';
import type { AgentContext, AgentMessage } from './types';

/**
 * CLIAgentWorker — spawns a CLI binary (Claude Code, Antigravity, Codex, Mistral Vibe)
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
   * Why the subprocess was stopped, when it wasn't a plain user/parent abort.
   * Set by the hard-timeout path so `run()` can surface "timed out" instead of
   * the default "aborted by user" (which downstream maps to "action denied").
   */
  private abortReason: string | null = null;
  /**
   * Set to true on the child's 'exit' event. `ChildProcess.killed` only means
   * a signal was *sent* (true the instant SIGTERM leaves), so the SIGKILL
   * escalation keyed off it could never fire — a SIGTERM-ignoring CLI leaked
   * (C7). Liveness is now this flag / `kill(pid, 0)`.
   */
  private processExited = false;
  /**
   * Failure reason reported by the CLI itself (Claude error_max_turns /
   * is_error, codex turn.failed / error). The close handler rejects with this
   * so an error run surfaces as failed, never a soft success (C3).
   */
  private runError: string | null = null;
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
        throw new Error(this.abortReason ?? 'Agent was aborted by user');
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
    if (this.process && !this.processExited) {
      const proc = this.process;
      const pid = proc.pid;

      // Give the child a moment to flush its final result/turn.completed line
      // before we tear the streams down — otherwise a clean SIGTERM loses the
      // last event and the abort resolves as a soft success (low item). We do
      // NOT destroy stdout here; the close handler drains lineBuffer.
      try { proc.stdin?.destroy(); } catch { /* ignore */ }

      if (process.platform === 'win32' && pid) {
        // On Windows, SIGTERM doesn't work for shell:true processes (cmd.exe wraps child).
        // taskkill /F /T kills the entire process tree.
        try {
          const { execSync } = require('child_process');
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
        } catch {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }
      } else {
        proc.kill('SIGTERM');
        setTimeout(() => {
          // Escalate only if the process is genuinely still alive. `killed`
          // just means a signal was sent; probe the real pid instead (C7).
          if (!this.processExited && pid && isProcessAlive(pid)) {
            try { proc.kill('SIGKILL'); } catch { /* already dead */ }
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
    // Adapter family for arg-building + output parsing (defaults to name);
    // vendor CLIs on the claude binary set adapter='Claude Code'.
    const adapterKey = toolConfig.adapter ?? toolConfig.name;
    const built = this.argBuilder.build(adapterKey, prompt, settings, this.systemMessages, systemPrompt, this.config.maxTokenBudget, this.context.id);
    const { binary, args, stdinPrompt, useShell } = built;
    // Vendor CLIs that reuse the `claude` binary (z.ai GLM / Moonshot Kimi) inject
    // ANTHROPIC_BASE_URL + auth token via buildEnv — merge it over the adapter's env.
    const toolEnv = toolConfig.buildEnv
      ? { ...(built.env || {}), ...(await toolConfig.buildEnv()) }
      : built.env;

    agentLogger.info(
      { agentId: this.context.id, tool: toolConfig.name, model: this.context.model },
      'Spawning CLI sub-agent',
    );
    this.emit('thought', { model: this.context.model, tool: toolConfig.name, status: 'spawning' });

    const startTime = Date.now();

    // Resolve cwd: dev mode sessions use project path, otherwise workspace root.
    // Fail loud (C12): NEVER fall back to process.cwd() — a write-enabled CLI
    // agent running inside the octipus server repo could corrupt it.
    let workspaceCwd: string;
    {
      const session = await sessionRepository.findById(this.context.sessionId);
      const sessionCtx = session?.context as import('@/db/schema/sessions').SessionContext | undefined;
      if (sessionCtx?.devMode && sessionCtx.projectPath) {
        workspaceCwd = resolvePath(sessionCtx.projectPath);
      } else {
        const root = getConfig().workspace.rootPath;
        if (!root) throw new Error('CLI agent cwd resolution failed: workspace.rootPath is unset');
        workspaceCwd = resolvePath(root);
      }
      if (!existsSync(workspaceCwd)) {
        throw new Error(`CLI agent cwd does not exist: ${workspaceCwd}`);
      }
    }

    const parser = new CLIOutputParser(
      this.context.id,
      this.context.model,
      (type, data) => this.emit(type, data),
      {
        onTurn: () => {
          // Iteration = model turns (C15). Tool-call count is tracked
          // separately by the UI (toolCalls.length); the server owns turns.
          this.iteration++;
          this.emit('thought', { type: 'iteration_update', iteration: this.iteration });
        },
        onTurnCount: (turns) => {
          // Authoritative final count (Claude num_turns) — never regress.
          if (turns > this.iteration) {
            this.iteration = turns;
            this.emit('thought', { type: 'iteration_update', iteration: this.iteration });
          }
        },
        onTokenUsage: (tokens) => {
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
        onRunError: (reason) => {
          // Record the first CLI-reported failure; the close handler rejects
          // with it so the run surfaces as failed, not (no response) success.
          if (!this.runError) this.runError = reason;
        },
      },
      workspaceCwd,
    );

    // Write temporary project context files so CLI tools pick up the expert identity.
    // Gemini reads GEMINI.md, Codex reads AGENTS.md from the cwd.
    // These are cleaned up after the CLI process exits.
    const tempContextFiles: string[] = [];
    // Context files we temporarily augmented (a real curated AGENTS.md already
    // existed): restore the original on cleanup — but ONLY if the file still
    // holds exactly what we wrote (C13). A concurrent agent in the same cwd may
    // have rewritten it; blindly restoring our `original` would clobber theirs.
    const contextFileBackups = new Map<string, { original: string; wroteHash: string }>();
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    agentLogger.info(
      { tool: toolConfig.name, hasSystemPrompt: !!systemPrompt, cwd: workspaceCwd },
      'CLI agent context',
    );

    try {
      const dumpDir = joinPath(homedir(), '.octipus', 'prompts');
      mkdirSync(dumpDir, { recursive: true });
      // Cap retention — prompt dumps used to accumulate unboundedly (C13).
      sweepStaleFiles(dumpDir, '', 7 * 24 * 3600_000);
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
        // The prompt and system prompt are printed in full above; don't re-inline
        // them here (they're the "-p <prompt>" / "--append-system-prompt <sys>"
        // args and make the dump look duplicated). Redact any oversized arg —
        // only prompt/system-prompt bodies are ever this long.
        [binary, ...args.map((a) => (a.length > 400 ? `<${a.length} chars — see sections above>` : a))].join(' '),
        '```',
      ].join('\n');
      writeFileSync(dumpPath, body, 'utf-8');
      agentLogger.info({ agentId: this.context.id, path: dumpPath }, 'Dumped CLI agent prompt');
    } catch (err) {
      agentLogger.debug({ err, agentId: this.context.id }, 'Failed to dump CLI agent prompt');
    }
    if (systemPrompt) {
      const contextFileMap: Record<string, string> = {
        // agy (Antigravity) reads GEMINI.md from the workdir, like gemini-cli did.
        'Antigravity': 'GEMINI.md',
        'Codex CLI': 'AGENTS.md',
        // vibe reads AGENTS.md from the workdir for project context.
        'Mistral Vibe': 'AGENTS.md',
      };
      const contextFileName = contextFileMap[toolConfig.name];
      if (contextFileName) {
        const contextFilePath = joinPath(workspaceCwd, contextFileName);
        try {
          if (!existsSync(contextFilePath)) {
            // No existing file — write our prompt and delete it afterward.
            writeFileSync(contextFilePath, systemPrompt, 'utf-8');
            tempContextFiles.push(contextFilePath);
            agentLogger.info({ tool: toolConfig.name, file: contextFileName, path: contextFilePath }, 'Wrote temp context file for CLI agent');
          } else {
            // A real curated AGENTS.md (or GEMINI.md) already exists. Prepend our
            // system prompt so the CLI gets both, then restore the original on exit.
            const original = readFileSync(contextFilePath, 'utf-8');
            const augmented = `${systemPrompt}\n\n---\n\n${original}`;
            contextFileBackups.set(contextFilePath, { original, wroteHash: sha(augmented) });
            writeFileSync(contextFilePath, augmented, 'utf-8');
            agentLogger.info({ tool: toolConfig.name, file: contextFileName, path: contextFilePath }, 'Augmented existing context file for CLI agent (will restore)');
          }
        } catch (err) {
          agentLogger.debug({ err, file: contextFileName }, 'Failed to write temp context file');
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
      // Restore any pre-existing context files we augmented — but only if the
      // file on disk is still exactly what we wrote (C13). If a concurrent
      // agent rewrote it, leave theirs; the last restorer no longer wins.
      for (const [f, { original, wroteHash }] of contextFileBackups) {
        try {
          if (existsSync(f) && sha(readFileSync(f, 'utf-8')) === wroteHash) {
            writeFileSync(f, original, 'utf-8');
          }
        } catch { /* best effort */ }
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
      // Minimal env allowlist (C6): a CLI child running with bypassed
      // permissions must NOT inherit the server's DB creds and all API keys.
      // Pass only PATH/HOME/locale/TERM, the CLI's own auth var, and toolEnv.
      const env = buildChildEnv(toolConfig, toolEnv);

      this.processExited = false;
      const proc = spawn(binary, args, {
        env,
        cwd: workspaceCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // No spawn-option `timeout` — the single timeout source is the
        // hardTimeout below, which stamps abortReason='timeout' so a timeout
        // always surfaces as a timeout, not "exited with code null" (C8).
        shell: useShellForSpawn,
      });
      // 'exit' fires when the process terminates (before streams flush).
      proc.once('exit', () => { this.processExited = true; });

      // EPIPE guard (low): a child that exits before reading stdin makes the
      // write throw asynchronously — attach the handler BEFORE writing.
      if (proc.stdin) {
        proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EPIPE') {
            agentLogger.debug({ err, agentId: this.context.id }, 'CLI stdin error');
          }
        });
        if (stdinPrompt) proc.stdin.write(stdinPrompt);
        proc.stdin.end();
      }

      this.process = proc;

      // Single hard timeout: force-kill on overrun and stamp abortReason so
      // run() reports "timed out" instead of "aborted by user". timeout <= 0
      // means unlimited (matches AgentWorker.withTimeout).
      const hardTimeout =
        this.config.timeout > 0
          ? setTimeout(() => {
              if (!this.aborted && !this.processExited) {
                agentLogger.warn(
                  { agentId: this.context.id, tool: toolConfig.name, timeoutMs: this.config.timeout },
                  'CLI agent exceeded hard timeout, force-killing',
                );
                this.abortReason = `CLI agent ${toolConfig.name} timed out after ${this.config.timeout}ms`;
                this.stop();
              }
            }, this.config.timeout)
          : undefined;

      let accumulatedText = '';
      // stderr ring buffer — keep only the tail so a chatty CLI can't pin
      // memory, and we still have the last N chars to surface on failure (C4).
      let stderr = '';
      const STDERR_TAIL = 8192;
      let lineBuffer = '';
      let consecutiveNonJson = 0;
      let nonJsonWarned = false;
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
            consecutiveNonJson = 0;
            const result = parser.parse(event, adapterKey);
            if (result) {
              if (result.replace) {
                accumulatedText = result.text;
              } else {
                accumulatedText += result.text;
              }
            }
          } catch {
            agentLogger.debug({ line: line.slice(0, 200) }, 'Non-JSON CLI output');
            // JSONL discipline (low): a version banner or non-JSON preamble
            // used to silently degrade to "(no response)". After N consecutive
            // non-JSON lines, surface one visible warning event.
            if (++consecutiveNonJson >= 5 && !nonJsonWarned) {
              nonJsonWarned = true;
              this.emit('observation', {
                type: 'warning',
                message: `CLI ${toolConfig.name} is emitting non-JSON output; results may be incomplete`,
                sample: line.slice(0, 200),
              });
            }
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > STDERR_TAIL) stderr = stderr.slice(-STDERR_TAIL);
      });

      proc.on('close', async (code) => {
        clearTimeout(hardTimeout);
        this.process = null;
        // C5: any throw in this async handler used to leave the executeCLI
        // promise unsettled forever (agent stuck "running"). Wrap the whole
        // body so a DB/parse error rejects instead of hanging.
        try {
          cleanupContextFiles();

          // Buffer-at-end tools: parse the whole accumulated stdout via the
          // tool's parseOutput, then post-parse tool_calls into events so the
          // UI shows what happened (no silent zero-event vibe/agy runs).
          if (toolConfig.bufferOutput) {
            try {
              const parsed = toolConfig.parseOutput(rawStdout, startTime);
              accumulatedText = parsed.content;
              if (parsed.usage.totalTokens > 0) {
                this.totalTokens += parsed.usage.totalTokens;
              }
            } catch (err) {
              agentLogger.warn({ err, agentId: this.context.id, tool: toolConfig.name }, 'Buffer-mode parseOutput failed; falling back to raw stdout');
              accumulatedText = rawStdout.trim();
            }
            try { parser.postParseBufferedEvents(toolConfig.name, rawStdout); } catch (err) {
              agentLogger.debug({ err, agentId: this.context.id }, 'Buffered event post-parse failed');
            }
          } else if (lineBuffer.trim()) {
            // Process remaining streamed line buffer
            try {
              const event = JSON.parse(lineBuffer);
              const result = parser.parse(event, adapterKey);
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
            // Abort surfaces via run() (which throws abortReason → stopped);
            // resolve here with whatever was captured so the caller sees it.
            resolve(accumulatedText || 'Task was stopped. Would you like to adjust the request or start something new?');
            return;
          }

          if (toolConfig.isQuotaError(stderr || accumulatedText)) {
            await quotaTracker.markExhausted(toolConfig.quotaProvider);
            reject(new Error(`Quota exhausted for ${toolConfig.name}`));
            return;
          }

          // CLI reported its own failure (Claude error_max_turns/is_error,
          // codex turn.failed/error) — never resolve as success (C3).
          if (this.runError) {
            reject(new Error(this.runError));
            return;
          }

          // Non-zero exit — fail with the code + stderr tail, even when there
          // was partial stdout. Resolving success on a crashed run hid real
          // failures (C4).
          if (code !== 0 && code !== null) {
            const tail = stderr.trim().slice(-1000) || accumulatedText.slice(-500) || 'no output';
            reject(new Error(`CLI ${binary} exited with code ${code}: ${tail}`));
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
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(hardTimeout);
        this.processExited = true;
        try { cleanupContextFiles(); } catch { /* best effort */ }
        this.process = null;
        reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
      });
    });
  }
}

/** True if a process with `pid` is still alive (signal 0 probe). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = alive but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Minimal env for a spawned CLI child (C6). Only PATH/HOME/locale/TERM, the
 * CLI's own auth var, and per-tool overrides — NOT the server's full env
 * (DB creds, every API key, internal secrets).
 */
function buildChildEnv(tool: CLIToolConfig, toolEnv?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  const pass = (k: string) => { const v = process.env[k]; if (v != null) base[k] = v; };
  // Core shell/runtime env every CLI needs to find its binary + config dir.
  for (const k of ['PATH', 'HOME', 'LANG', 'TERM', 'TZ', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR']) pass(k);
  // Windows equivalents.
  for (const k of ['SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP']) pass(k);
  // Locale (LC_ALL, LC_CTYPE, …).
  for (const k of Object.keys(process.env)) if (k.startsWith('LC_')) pass(k);
  // The CLI's own auth vars — scoped per provider so codex doesn't see the
  // Anthropic key, etc.
  const authByProvider: Record<string, string[]> = {
    anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    openai: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
    mistral: ['MISTRAL_API_KEY'],
  };
  for (const k of authByProvider[tool.modelProvider] || []) pass(k);
  // Per-tool overrides (e.g. vibe's ephemeral VIBE_HOME).
  Object.assign(base, toolEnv || {});
  // Never let the child think it's running inside Claude Code itself.
  delete base.CLAUDECODE;
  return base;
}
