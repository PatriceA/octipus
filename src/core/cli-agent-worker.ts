import { recordProviderUsage } from '@/models/providers/instrumented';
import { randomUUID } from 'crypto';
import { type ChildProcess, spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join as joinPath, resolve as resolvePath } from 'path';
import { recordAgentCompletion } from '@/core/agent-task-recorder';
import { agentRepository } from '@/db/repositories/agent-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { WorkspaceFS } from '@/security/workspace-fs';
import type { CLIAgentConfig } from '@/db/schema/models';
import { getModelRegistry } from '@/models/model-registry';
import { getQuotaTracker } from '@/models/quota-tracker';
import { agentLogger } from '@/utils/logger';
import type { AgentWorkerConfig, ToolHandler } from './agent-base';
import { BaseAgentWorker } from './agent-base';
import { CLIArgumentBuilder, CLIOutputParser, discoverCodexMcpServers, resolveCliMcpEntry, sweepStaleFiles, type CliRunConnection } from './cli-adapters';
import { startCliToolBridge, type BridgeResult } from './cli-tool-bridge';
import { ToolExecutor } from './tool-executor';
import { answerCliPermissionRequest } from './cli-permissions';
import { getPermissionManager } from '@/security/permissions';
import { workPlanRepository } from '@/db/repositories/work-plan-repository';
import { formatWorkPlanContext } from './agent/work-plan-context';
import { isPlanMode } from './agent/plan-mode';
import type { CLIToolConfig } from '@/models/providers/cli-provider';
import { emptyCounters, mergeCounters, type SideEffectCounters } from './swarm/receipt';
import { BudgetExceededError } from './swarm/errors';
import { getCLIToolConfig } from './cli-agent-factory';
import { isRootAgent } from './types';
import type { AgentContext, AgentMessage } from './types';

/**
 * Whether this session's cwd is a directory someone ELSE owns — a dev-mode
 * `projectPath` — rather than the per-user workspace octipus materialises
 * lazily.
 *
 * It decides what a MISSING cwd means. Ours: routine, create it. Theirs: the
 * project has been moved, deleted or unmounted since the session was created
 * (`checkProjectPath` runs once, at creation, and never again), and creating it
 * would drop a write-enabled agent into an empty tree where it can report
 * success against no code at all.
 */
export function isBorrowedProjectDir(
  sessionContext: { devMode?: boolean; projectPath?: string } | undefined | null,
): boolean {
  return !!(sessionContext?.devMode && sessionContext.projectPath);
}

/**
 * CLIAgentWorker — spawns a CLI binary (Claude Code, Antigravity, Codex, Mistral Vibe)
 * as an autonomous sub-agent.
 */
export class CLIAgentWorker extends BaseAgentWorker {
  private systemMessages: string[] = [];
  private readonly toolExecutor: ToolExecutor;
  private connection?: CliRunConnection;
  private launchCleanup: (() => void) | undefined;
  private bridge?: Awaited<ReturnType<typeof startCliToolBridge>>;
  private pastParserCounters: SideEffectCounters | null = null;
  private readonly abortController = new AbortController();
  getAbortSignal(): AbortSignal { return this.abortController.signal; }
  private terminalEmitted = false;
  private runStartedAt = 0;
  private pausedMs = 0;
  private pauseStartedAt: number | null = null;
  private pauseReasons = new Set<string>();
  private setPause(reason: string, on: boolean): void {
    if (on) this.pauseReasons.add(reason); else this.pauseReasons.delete(reason);
    if (this.pauseReasons.size && this.pauseStartedAt === null) this.pauseStartedAt = Date.now();
    if (!this.pauseReasons.size && this.pauseStartedAt !== null) {
      this.pausedMs += Date.now() - this.pauseStartedAt;
      this.pauseStartedAt = null;
    }
  }
  private elapsed(): number {
    return Date.now() - this.runStartedAt - this.pausedMs - (this.pauseStartedAt === null ? 0 : Date.now() - this.pauseStartedAt);
  }
  private bridgeErrors = new Map<string, boolean>();
  private steeringQueue: AgentMessage[] = [];

  /** Guidance is delivered at the next Octipus tool response or a follow-up CLI turn. */
  steer(message: AgentMessage): void {
    this.steeringQueue.push(message);
    this.emit('thought', { type: 'steering_queued', delivery: 'next Octipus tool response or follow-up turn' });
  }

  private async controlContext(): Promise<string> {
    const state = await workPlanRepository.read(this.context.sessionId, this.context.userId);
    const guidance = this.steeringQueue.splice(0);
    this.messages.push(...guidance);
    return JSON.stringify({
      agentId: this.context.id, sessionId: this.context.sessionId,
      workspaceId: this.context.workspaceId, planMode: this.connection?.planMode ?? false,
      workPlan: formatWorkPlanContext(state), guidance: guidance.map(m => m.content),
      guidanceDelivery: 'Review this guidance before further affected work. Pending feedback must be acknowledged through update_work_plan.',
    });
  }

  private async executeBridgedTool(name: string, args: Record<string, unknown>): Promise<BridgeResult> {
    const id = randomUUID();
    const delegation = name === 'spawn_child' || name === 'escalate_to_different_expert' || name === 'collect_children' || this.toolExecutor.getTools().get(name)?.final === true;
    if (delegation) this.setPause('delegation', true);
    try {
      let messages: AgentMessage[];
      try {
        messages = await this.toolExecutor.handleToolCalls([{ id, name, arguments: args }]);
      } catch (error) {
        // Executor throws are terminal (approval cancellation or final-tool failure).
        // Preserve an existing user cancellation instead of reclassifying it.
        if (!this.aborted) {
          this.runError = error instanceof Error ? error.message : String(error);
          this.stop();
        }
        throw error;
      }
      const isError = this.bridgeErrors.get(id) ?? false;
      let contextText: string;
      try { contextText = `Octipus run context: ${await this.controlContext()}`; }
      catch (error) {
        agentLogger.warn({ error, agentId: this.context.id }, 'CLI context refresh failed after tool execution');
        contextText = 'Tool execution finished. Run context refresh is temporarily unavailable; use get_cli_run_context before further affected work.';
      }
      return { content: [
        ...messages.map(m => ({ type: 'text' as const, text: m.content })),
        { type: 'text', text: contextText },
      ], isError };
    } finally { this.bridgeErrors.delete(id); if (delegation) this.setPause('delegation', false); }
  }

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
  private accountingModelName: string | undefined;
  /**
   * Cleanup for the parent AbortSignal listener. Symmetric with `AgentWorker`
   * (Swarm Phase 2): when an ancestor aborts, the cascade reaches the CLI
   * worker too — it triggers `stop()` which kills the subprocess.
   */
  private parentSignalCleanup: (() => void) | null = null;
  /** Stream parser for the current run — owns the side-effect tally. */
  private parser: CLIOutputParser | null = null;

  constructor(
    context: AgentContext,
    config: AgentWorkerConfig,
    opts?: { parentSignal?: AbortSignal },
  ) {
    super(context, config);
    this.toolExecutor = new ToolExecutor(context, (type, data) => {
      if (type === 'observation' && data && typeof data === 'object' && 'results' in data) {
        for (const result of (data as { results: Array<{ toolCallId: string; error?: string }> }).results) {
          this.bridgeErrors.set(result.toolCallId, !!result.error);
        }
      }
      this.emit(type, data);
    });
    this.registerTool({ name: 'get_cli_run_context', description: 'Read the current Octipus plan, feedback and new user guidance. Check before further work and before your final answer.',
      parameters: { type: 'object', properties: {} }, execute: async () => this.controlContext() });

    if (opts?.parentSignal) {
      const parent = opts.parentSignal;
      if (parent.aborted) {
        this.aborted = true;
        this.abortController.abort('Parent already stopped');
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

  /**
   * Side-effect counters for this run. A CLI writes files in its own process,
   * so octipus has no `ToolExecutor` tally here — the parsed output stream is
   * the only ground truth, and `CLIOutputParser` counts it. Stays `null` (=
   * unknown, NOT zero) when the run never produced a recognized stream, so an
   * evidence gate treats it as "no evidence" rather than "wrote nothing".
   */
  override getSideEffectCounters(): import('./swarm/receipt').SideEffectCounters | null {
    const parsed = this.parser?.getSideEffectCounters() ?? null;
    const native = this.toolExecutor.getSideEffectCounters();
    const observed = parsed || this.pastParserCounters;
    if (!observed && native.toolCalls === 0 && native.permissionDenials === 0 && native.toolErrors === 0) return null;
    return mergeCounters(mergeCounters(this.pastParserCounters ?? emptyCounters(), parsed ?? emptyCounters()), native);
  }

  /** Expose the same registered handlers through the run-scoped bridge. */
  registerTool(tool: ToolHandler): void { this.toolExecutor.registerTool(tool); }

  registerTools(tools: ToolHandler[]): void { this.toolExecutor.registerTools(tools); }

  addSystemMessage(content: string): void {
    this.systemMessages.push(content);
    this.messages.push({ role: 'system', content, timestamp: new Date() });
  }

  async addUserMessage(content: string): Promise<void> {
    this.messages.push({ role: 'user', content, timestamp: new Date() });
    // Only persist for the root agent — sub-workers use handleMessage for persistence
    if (isRootAgent(this.context)) {
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
    let permissionCleanup: () => void = () => {};
    try {
    if (this.aborted) throw new Error('Agent was aborted before starting');
    if (userMessage) {
      await this.addUserMessage(userMessage);
    }

    if (this.aborted) throw new Error('Agent was aborted before starting');
    this.runStartedAt = Date.now();
    permissionCleanup = getPermissionManager().onWaitStateChange((agentId, waiting) => {
      if (agentId === this.context.id) this.setPause('approval', waiting);
    });
    this.context.status = 'running';
    this.emit('status_change', { status: 'running' });

      const session = await sessionRepository.findById(this.context.sessionId);
      if (this.aborted) throw new Error('Agent was aborted before bridge startup');
      if (!session || session.userId !== this.context.userId) throw new Error('CLI session ownership mismatch');
      this.bridge = await startCliToolBridge({
        tools: () => this.toolExecutor.toolsDisabled ? [] : [...this.toolExecutor.getTools().values()],
        active: () => this.context.status === 'running' && !this.aborted,
        execute: (name, args) => this.executeBridgedTool(name, args),
        unqueued: new Set(['get_cli_run_context', 'get_work_plan']),
      });
      if (this.aborted) throw new Error('Agent was aborted during bridge startup');
      this.connection = { url: this.bridge.url, key: this.bridge.key,
        planMode: isPlanMode(session.context as { planMode?: boolean }), maxIterations: this.config.maxIterations };
      const helper = resolveCliMcpEntry().replace(/index\.js$/, 'agent-bridge-client.js');
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      this.addSystemMessage(`You are connected to your Octipus run through the octipus MCP server. Its tools are your actual registered Octipus tools, including skills, plans and delegation when allowed. Prefer these tools for Octipus work.
` +
        `Call get_cli_run_context before working and before the final answer. Every Octipus tool response also includes fresh plan feedback and queued user guidance. Respect permissions and do not bypass a refused Octipus tool through vendor tools.
` +
        `If your CLI cannot load this MCP server, use its terminal tool to run the bridge helper: ${quote(process.execPath)} ${quote(helper)} tools; or ${quote(process.execPath)} ${quote(helper)} call <tool-name> '<JSON arguments>'. Quote arguments safely. Credentials are supplied by the parent environment; never print them.
` +
        `Tool names: ${[...this.toolExecutor.getTools().keys()].join(', ')}.`);
      this.messages.push({ role: 'user', content: `Octipus run context: ${await this.controlContext()}`, timestamp: new Date() });
      let result = await this.executeCLI();
      const checkLateFeedback = async () => {
        if (!this.toolExecutor.getTools().has('update_work_plan')) return;
        try {
          const latest = await workPlanRepository.read(this.context.sessionId, this.context.userId);
          if (latest.current?.feedback.some(f => f.status === 'pending')) {
            this.steeringQueue.push({ role: 'user', content: 'New plan feedback arrived. Read the current plan and handle pending feedback before finalizing.', timestamp: new Date() });
          }
        } catch (err) {
          // Feedback stays pending in the plan record; do not fail a finished run over a read outage.
          agentLogger.warn({ err, agentId: this.context.id }, 'Late plan feedback check failed');
        }
      };
      await checkLateFeedback();
      // A plain CLI has no mid-turn input protocol. If guidance arrived after
      // its last bridge call, run a bounded follow-up instead of silently losing it.
      const buffered = getCLIToolConfig(this.context.model)?.bufferOutput === true;
      let followups = 0;
      while (!this.aborted && this.steeringQueue.length > 0 && !buffered && followups < 2 && this.iteration < this.config.maxIterations) {
        followups++;
        this.messages.push({ role: 'assistant', content: result, timestamp: new Date() });
        this.messages.push({ role: 'user', content: `New guidance: ${await this.controlContext()}`, timestamp: new Date() });
        result = await this.executeCLI();
        await checkLateFeedback();
      }
      if (!this.aborted && this.steeringQueue.length > 0) {
        // Keep the completed work; say plainly what was not applied. Plan feedback
        // stays pending in the durable record; steering text is already in the
        // session history, so the next message carries it.
        const pending = this.steeringQueue.length;
        const reason = buffered ? 'this CLI reports only at completion' : this.iteration >= this.config.maxIterations ? 'the turn budget is exhausted' : 'the follow-up limit was reached';
        this.emit('thought', { type: 'guidance_pending', count: pending, reason });
        result += `\n\n[Octipus] ${pending} guidance/feedback item${pending === 1 ? '' : 's'} arrived after this CLI's last Octipus tool call and ${pending === 1 ? 'was' : 'were'} not applied because ${reason}. Send another message to continue with it.`;
      }

      if (this.aborted) throw new Error(this.runError ?? this.abortReason ?? 'Agent was aborted by user');

      this.context.status = 'completed';
      this.context.completedAt = new Date();
      this.emit('status_change', { status: 'completed' });
      this.emit('complete', { result });
      this.terminalEmitted = true;

      const durationMs = Date.now() - this.context.createdAt.getTime();
      await auditRepository.logAgentCompleted(
        this.context.userId, this.context.sessionId, this.context.id,
        { durationMs, iterations: this.iteration, model: this.context.model, role: this.context.role },
      ).catch(err => agentLogger.warn({ err, agentId: this.context.id }, 'Failed to audit CLI completion'));

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
        root: isRootAgent(this.context),
        topic: this.context.topic,
        output: result,
      }).catch(err => agentLogger.warn({ err, agentId: this.context.id }, 'Failed to record agent completion'));

      return result;
    } catch (error) {
      const wasStopped = this.aborted && !this.abortReason && !this.runError && !this.budgetExceeded;
      const status = wasStopped ? 'stopped' : 'failed';
      this.context.status = status;
      this.context.completedAt = new Date();
      if (!this.terminalEmitted) {
        this.emit('status_change', { status });
        if (wasStopped) this.emit('complete', { result: 'Agent stopped', stopped: true });
        else this.emit('error', { error: (error as Error).message });
        this.terminalEmitted = true;
      }
      const durationMs = Date.now() - this.context.createdAt.getTime();
      if (!wasStopped) await auditRepository.logAgentFailed(
        this.context.userId, this.context.sessionId, this.context.id,
        { error: (error as Error).message, iteration: this.iteration, model: this.context.model, role: this.context.role },
      ).catch(err => agentLogger.warn({ err, agentId: this.context.id }, 'Failed to audit CLI failure'));
      agentRepository.updateStatus(this.context.id, {
        status, iterations: this.iteration, durationMs, totalTokens: this.totalTokens,
        error: wasStopped ? undefined : (error as Error).message,
      }).catch(err => agentLogger.error({ err, agentId: this.context.id }, 'Failed to persist CLI terminal status'));

      throw error;
    } finally {
      permissionCleanup();
      this.launchCleanup?.();
      this.launchCleanup = undefined;
      this.abortController.abort('CLI run ended');
      getPermissionManager().cancelWaits(this.context.id);
      this.parentSignalCleanup?.();
      this.parentSignalCleanup = null;
      if (this.bridge) {
        try { await this.bridge.close(); }
        catch (err) { agentLogger.error({ err, agentId: this.context.id }, 'CLI bridge cleanup failed'); }
        this.bridge = undefined;
      }
      this.connection = undefined;
    }
  }

  stop(): void {
    if (this.terminalEmitted) return;
    this.aborted = true;
    this.abortController.abort('CLI agent stopped');
    getPermissionManager().cancelWaits(this.context.id);
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
    if (!this.terminalEmitted && !this.abortReason && !this.runError && !this.budgetExceeded) {
      this.emit('status_change', { status: 'stopped' });
      this.emit('complete', { result: 'Agent stopped', stopped: true });
      this.terminalEmitted = true;
    }
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
    this.accountingModelName = model?.name;
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

    agentLogger.info(
      { agentId: this.context.id, tool: toolConfig.name, model: this.context.model },
      'Spawning CLI sub-agent',
    );
    this.emit('thought', { model: this.context.model, tool: toolConfig.name, status: 'spawning' });

    const startTime = Date.now();

    // Resolve cwd through the SHARED resolver, which already encodes the rule
    // this block used to reimplement: a dev-mode session with a `projectPath`
    // runs inside that project, everyone else gets their own nested workspace.
    //
    // The hand-rolled version used the FLAT `workspace.rootPath`, two levels
    // above `<root>/users/<uid>/workspaces/default/files` — so a CLI agent
    // wrote outside the user's workspace, where neither the file browser, the
    // Changes tab, nor the pipeline evidence gate's snapshot looks. A CLI stage
    // could therefore build the whole deliverable and be failed for changing
    // nothing. (`WorkspaceFS.forSession`'s own doc says it mirrors this
    // function; it was written with the fix and this side never caught up —
    // the same divergence the shell tool's default cwd had.)
    //
    // Fail loud (C12) is preserved on both counts: never fall back to
    // process.cwd(), since a write-enabled CLI agent inside the octipus server
    // repo could corrupt it — and never invent a dev-mode project directory
    // that has gone missing (see below).
    let workspaceCwd: string;
    {
      const session = await sessionRepository.findById(this.context.sessionId);
      if (!session) {
        throw new Error(`CLI agent cwd resolution failed: no session ${this.context.sessionId}`);
      }
      workspaceCwd = resolvePath(WorkspaceFS.forSession(session).root);

      if (!existsSync(workspaceCwd)) {
        // Whether a missing directory is routine or alarming depends on WHOSE
        // it is, so the two cases are kept apart deliberately.
        //
        // A dev-mode `projectPath` is a directory someone else owns. It is
        // checked once, when the session is created (`checkProjectPath`), and
        // never again — so by the time a later turn runs it may have been
        // deleted, renamed or unmounted. Creating it would spawn a
        // write-enabled agent into an EMPTY tree and let it report success
        // against no code at all, with nothing saying the project had gone.
        // That is the same class of silent-success this whole session's work is
        // about, so it stays fail-loud.
        //
        // A per-user workspace, by contrast, is ours and is materialised
        // lazily: "not there yet" is the normal first-run state.
        if (isBorrowedProjectDir(session.context as import('@/db/schema/sessions').SessionContext | undefined)) {
          throw new Error(
            `CLI agent cwd does not exist: ${workspaceCwd}. This session is pinned to a dev-mode ` +
              `project path; it was present when the session was created, so it has since been ` +
              `moved, deleted or unmounted. Refusing to run an agent in an empty directory.`,
          );
        }
        mkdirSync(workspaceCwd, { recursive: true });
      }
    }

    this.launchCleanup?.();
    this.launchCleanup = undefined;
    // Async vendor discovery stays out of the synchronous arg builder (event-loop safe).
    const codexMcpServers = this.connection && adapterKey === 'Codex CLI' ? await discoverCodexMcpServers(workspaceCwd) : undefined;
    const built = this.argBuilder.build(adapterKey, toolConfig.name === 'Mistral Vibe' && systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt, settings, this.systemMessages, systemPrompt, Math.max(0, this.config.maxTokenBudget - this.totalTokens), this.context.id, this.connection ? { ...this.connection, workingDirectory: workspaceCwd, codexMcpServers, maxIterations: Math.max(1, this.config.maxIterations - this.iteration) } : undefined);
    const { binary, args, stdinPrompt, useShell } = built;
    this.launchCleanup = () => {
      const configIndex = args.indexOf('--mcp-config');
      const paths = [built.env?.VIBE_HOME, ...(this.connection && configIndex >= 0 ? [args[configIndex + 1]] : [])];
      for (const path of paths) if (path) {
        try { rmSync(path, { recursive: true, force: true }); }
        catch (err) { agentLogger.warn({ err, path }, 'CLI temporary configuration cleanup failed'); }
      }
    };
    // Vendor CLIs that reuse the `claude` binary (z.ai GLM / Moonshot Kimi) inject
    // ANTHROPIC_BASE_URL + auth token via buildEnv — merge it over the adapter's env.
    const toolEnv = toolConfig.buildEnv
      ? { ...(built.env || {}), ...(await toolConfig.buildEnv()) }
      : built.env;


    const previousCounters = this.parser?.getSideEffectCounters();
    if (previousCounters) this.pastParserCounters = mergeCounters(this.pastParserCounters ?? emptyCounters(), previousCounters);
    const invocationStartIteration = this.iteration;
    let invocationUsage: import('@/models/litellm-client').CompletionResult['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false };
    const parser = this.parser = new CLIOutputParser(
      this.context.id,
      this.context.model,
      (type, data) => {
        const stats = (data as { stats?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheRead?: number; cacheCreation?: number } }).stats;
        if (type === 'thought' && stats?.totalTokens != null) {
          const claude = toolConfig.modelProvider === 'anthropic' || toolConfig.modelProvider === 'zai' || toolConfig.modelProvider === 'moonshot';
          const input = (stats.inputTokens ?? 0) + (claude ? (stats.cacheRead ?? 0) + (stats.cacheCreation ?? 0) : 0);
          invocationUsage = { inputTokens: (claude ? 0 : invocationUsage.inputTokens) + input,
            outputTokens: (claude ? 0 : invocationUsage.outputTokens) + (stats.outputTokens ?? 0),
            totalTokens: (claude ? 0 : invocationUsage.totalTokens) + stats.totalTokens,
            cacheReadTokens: (claude ? 0 : invocationUsage.cacheReadTokens ?? 0) + (stats.cacheRead ?? 0),
            cacheCreationTokens: stats.cacheCreation, available: stats.totalTokens > 0 };
        }
        this.emit(type, data);
      },
      {
        isBridgedTool: name => /^mcp__octipus__|^octipus[_.]|^octipus_run_[a-f0-9]+\./.test(name),
        onTurn: () => {
          // Iteration = model turns (C15). Tool-call count is tracked
          // separately by the UI (toolCalls.length); the server owns turns.
          this.iteration++;
          if (this.iteration > this.config.maxIterations) { this.abortReason = 'CLI agent exceeded its turn limit'; this.stop(); }
          this.emit('thought', { type: 'iteration_update', iteration: this.iteration });
        },
        onTurnCount: (turns) => {
          // Authoritative final count (Claude num_turns) — never regress.
          const totalTurns = invocationStartIteration + turns;
          if (totalTurns > this.iteration) {
            this.iteration = totalTurns;
            if (this.iteration > this.config.maxIterations) { this.abortReason = 'CLI agent exceeded its turn limit'; this.stop(); }
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
      writeFileSync(dumpPath, body, { encoding: 'utf-8', mode: 0o600 });
      agentLogger.info({ agentId: this.context.id, path: dumpPath }, 'Dumped CLI agent prompt');
    } catch (err) {
      agentLogger.debug({ err, agentId: this.context.id }, 'Failed to dump CLI agent prompt');
    }

    // Cleanup helper — removes temp context files and any ephemeral per-spawn
    // VIBE_HOME the arg builder created for vibe's MCP registration.
    const tempVibeHome = toolEnv?.VIBE_HOME;
    const cleanupContextFiles = () => {
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
      const env = buildChildEnv(toolConfig, { ...toolEnv,
        ...(this.connection ? { OCTIPUS_AGENT_URL: this.connection.url, OCTIPUS_AGENT_KEY: this.connection.key } : {}),
      }, settings.inheritApiKeys === true);

      if (this.aborted) { cleanupContextFiles(); reject(new Error('Agent was aborted before CLI spawn')); return; }
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
        if (!built.keepStdinOpen) proc.stdin.end();
      }

      this.process = proc;

      // Single hard timeout: force-kill on overrun and stamp abortReason so
      // run() reports "timed out" instead of "aborted by user". timeout <= 0
      // means unlimited (matches AgentWorker.withTimeout).
      const hardTimeout = this.config.timeout > 0 ? setInterval(() => {
        if (!this.aborted && !this.processExited && this.elapsed() >= this.config.timeout) {
          this.abortReason = `CLI agent ${toolConfig.name} timed out after ${this.config.timeout}ms of active work`;
          this.stop();
        }
      }, 250) : undefined;

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
            if (built.keepStdinOpen && event.type === 'control_request') {
              void answerCliPermissionRequest(event, this.context, (type, data) => this.emit(type, data)).then(response => {
                if (!this.aborted && proc.stdin?.writable) proc.stdin.write(JSON.stringify(response) + '\n');
              }).catch((err: unknown) => {
                this.runError = `CLI permission protocol failed: ${err instanceof Error ? err.message : String(err)}`;
                this.stop();
              });
              continue;
            }
            if (built.keepStdinOpen && event.type === 'result') proc.stdin?.end();
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
        clearInterval(hardTimeout);
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
              invocationUsage = parsed.usage;
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

          await recordProviderUsage({ model: this.context.model, modelConfigName: this.accountingModelName, messages: [], userId: this.context.userId, sessionId: this.context.sessionId, agentId: this.context.id, requestType: 'cli' }, 'cli', { model: this.context.model, usage: invocationUsage }, code !== 0 || this.aborted || !!this.runError);

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

          // Only persist for the root agent — sub-workers use handleMessage for persistence
          if (accumulatedText && isRootAgent(this.context)) {
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
        clearInterval(hardTimeout);
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
export function buildChildEnv(tool: CLIToolConfig, toolEnv?: Record<string, string>, inheritApiKeys = false): Record<string, string> {
  const base: Record<string, string> = {};
  const pass = (k: string) => { const v = process.env[k]; if (v != null) base[k] = v; };
  // Core shell/runtime env every CLI needs to find its binary + config dir.
  for (const k of ['PATH', 'HOME', 'LANG', 'TERM', 'TZ', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'CODEX_HOME']) pass(k);
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
  if (inheritApiKeys) for (const k of authByProvider[tool.modelProvider] || []) pass(k);
  if (tool.modelProvider === 'anthropic') pass('CLAUDE_CODE_OAUTH_TOKEN');
  // Per-tool overrides (e.g. vibe's ephemeral VIBE_HOME).
  Object.assign(base, toolEnv || {});
  // Never let the child think it's running inside Claude Code itself.
  delete base.CLAUDECODE;
  return base;
}
