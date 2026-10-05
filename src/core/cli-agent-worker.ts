import { VAULT_USAGE_GUIDANCE } from '@/core/agent/vault-guidance';
import { usageContextOf } from '@/core/agent/context';
import { recordProviderUsage } from '@/models/providers/instrumented';
import { billableTokens } from '@/models/billable-tokens';
import { assertWindowsCmdLineFits, windowsShellQuote, windowsShellQuoter } from '@/models/providers/cli-provider';
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
import { sessionGeneration, type SessionContext } from '@/db/schema/sessions';
import { WorkspaceFS } from '@/security/workspace-fs';
import type { CLIAgentConfig } from '@/db/schema/models';
import { getQuotaTracker } from '@/models/quota-tracker';
import { agentLogger } from '@/utils/logger';
import { killProcessTree } from '@/utils/proc';
import type { AgentWorkerConfig, ToolHandler } from './agent-base';
import { BaseAgentWorker } from './agent-base';
import { CLIArgumentBuilder, CLIOutputParser, isCodexHookTrustWarning, discoverCodexMcpServers, resolveCliMcpEntry, sweepStaleFiles, type CliRunConnection } from './cli-adapters';
import { childCliSessionKey, claimCliSession, cliSessionHolder, dropCliSession, fingerprintRun, loadCliSession, releaseCliSessions, saveCliSession } from './cli-session-store';
import { canResume, CLI_RESUME } from '@/shared/cli-capabilities';
import { startCliToolBridge, type BridgeResult } from './cli-tool-bridge';
import { ToolExecutor } from './tool-executor';
import { answerCliPermissionRequest } from './cli-permissions';
import { getPermissionManager } from '@/security/permissions';
import { observeFlow } from '@/security/flow-guard';
import { workPlanRepository } from '@/db/repositories/work-plan-repository';
import { formatWorkPlanContext } from './agent/work-plan-context';
import { ClassifiedError, FailoverReason, RecoveryAction } from './errors/classification';
import { isPlanMode } from './agent/plan-mode';
import { emptyCounters, mergeCounters, type SideEffectCounters } from './swarm/receipt';
import { BudgetExceededError } from './swarm/errors';
import { DetachedChildManager } from './agent-worker/detached-child-manager';
import { formatCollectedResults } from './swarm/collect-tool';
import { swarmNodeRepository } from './swarm/node-repository';
import { worktreeCwdOverride } from './swarm/worktree';
import type { ChildResult, PendingChild } from './swarm/types';
import { getCLIToolConfig, resolveCliModelEntry } from './cli-agent-factory';
import { getSkillRegistry } from '@/skills/registry';
import { fetchActiveSkillIdsForTopic } from '@/skills/discovery';
import { buildChildEnv } from './cli-child-env';
import { getConfig } from '@/config';
import { isRootAgent } from './types';
import type { AgentContext, AgentMessage } from './types';
import { readSessionHistory, roomRequestOf, toContextMessage, withSessionConversation } from './session-history';
import { isRoomSession } from '@/db/repositories/session-kind';
import { VOLATILE_MARKER } from '@/models/providers/prompt-cache';
import { isLongTailHandler, TOOL_DISCOVERY_TOOL_ID } from './agent/tool-split';
import { canActInSession } from '@/core/rooms/access';

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
/** Skill index per (user, role, CLI family): assignments change rarely, and the lookup must not delay a spawn. */
const SKILL_INDEX_TTL_MS = 60_000;
const skillIndexCache = new Map<string, { at: number; value?: string; ready: Promise<void> }>();

/** Octipus tools reached over the run-local MCP bridge, as the vendor CLIs name them. */
const CLI_BRIDGED_TOOL_RE = /^mcp__octipus__|^octipus[_.]|^octipus_run_[a-f0-9]+\./;

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
  /**
   * True once THIS run is confirmed to resume a vendor session (Task 6) — the
   * vendor already holds every earlier turn, so buildPrompt() sends only the
   * run-context block and the newest user turn instead of re-flattening
   * `this.messages`.
   */
  private resuming = false;
  private generation = '';
  private commentaryDelivery: Promise<void> = Promise.resolve();
  private clearedAt?: string;
  private userCursor?: { id: string; createdAt: string };
  private resumeDelta: string[] = [];
  /**
   * Detached subagents not yet collected — the same manager the native worker
   * uses, so `spawn_child` can detach and `collect_children` works for a CLI.
   * Child-wait time is already excluded from the active clock by the
   * delegation pause around every collect (bridged or auto), so the manager's
   * own credit is a no-op here — crediting both would count the wait twice.
   */
  private detached = new DetachedChildManager(this.context.id, () => this.config.timeout, () => {});
  registerPendingChild(pc: PendingChild): void { this.detached.registerPendingChild(pc); }
  pendingDetachedCount(): number { return this.detached.count(); }
  listPendingDetached(): PendingChild[] { return this.detached.list(); }
  collectDetached(childId: string, timeoutMs: number): Promise<ChildResult | null> { return this.detached.collect(childId, timeoutMs); }
  collectAllDetached(timeoutMs: number): Promise<ChildResult[]> { return this.detached.collectAll(timeoutMs); }

  /** Guidance is delivered at the next Octipus tool response or a follow-up CLI turn. */
  steer(message: AgentMessage): void {
    this.steeringQueue.push(message);
    this.emit('thought', { type: 'steering_queued', delivery: 'next Octipus tool response or follow-up turn' });
  }

  /**
   * The skills assigned to this agent's role (skill_topic_assignments) as an
   * index (name + one line; bodies via get_skill). A CLI applies only the
   * skills it loads natively, so without this it never looked at Octipus ones.
   * Spawned children already carry the spawner's index; skills the CLI loads
   * itself are left out.
   * Optional context: it never holds the spawn back more than 300 ms; a cold
   * registry (a first scan of the skill dirs took ~10 s) serves the next run.
   */
  private async cliSkillIndex(): Promise<string> {
    if (this.systemMessages.some(message => message.includes('Available skills (call `get_skill`'))) return '';
    const tool = getCLIToolConfig(this.context.model);
    const adapter = tool?.adapter ?? tool?.name;
    const native = adapter === 'Claude Code' ? 'external:claude-user:' : adapter === 'Codex CLI' ? 'external:codex-' : null;
    const role = this.context.role;
    const key = `${this.context.userId}|${role}|${native}`;
    let entry = skillIndexCache.get(key);
    if (!entry || Date.now() - entry.at > SKILL_INDEX_TTL_MS) {
      const pending: { at: number; value?: string; ready: Promise<void> } = { at: Date.now(), ready: Promise.resolve() };
      pending.ready = (async () => {
        const registry = getSkillRegistry();
        const ids = [...new Set(await fetchActiveSkillIdsForTopic(role))].filter(id => !native || !id.startsWith(native));
        const index = await registry.buildPromptSummary(ids, this.context.userId);
        pending.value = index && `${index}
When a task matches one of these skills, load it with get_skill before starting and follow it.`;
      })().catch(err => {
        pending.value = '';
        agentLogger.debug({ err, agentId: this.context.id }, 'CLI skill index unavailable');
      });
      // A stale value keeps serving until the refresh lands.
      if (entry?.value !== undefined && pending.value === undefined) void pending.ready.then(() => skillIndexCache.set(key, pending));
      else skillIndexCache.set(key, pending);
      entry = entry?.value !== undefined ? entry : pending;
    }
    if (entry.value === undefined) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([entry.ready, new Promise<void>(resolve => { timer = setTimeout(resolve, 300); })]);
      clearTimeout(timer);
    }
    return entry.value ?? '';
  }

  private async controlContext(): Promise<string> {
    const state = await workPlanRepository.read(this.context.sessionId, this.context.userId);
    const guidance = this.steeringQueue.splice(0);
    this.messages.push(...guidance);
    return JSON.stringify({
      agentId: this.context.id, sessionId: this.context.sessionId,
      workspaceId: this.context.workspaceId, planMode: this.connection?.planMode ?? false,
      workPlan: formatWorkPlanContext(state), guidance: guidance.map(m => m.content),
      ...(this.detached.count() > 0 ? {
        detachedChildren: this.detached.list().map(pc => ({ childId: pc.childId, topic: pc.topic, runningMs: Date.now() - pc.startedAt })),
        detachedChildrenNote: 'Call collect_children before your final answer to receive their results; otherwise the run collects them for you.',
      } : {}),
      guidanceDelivery: 'Review this guidance before further affected work. Pending feedback must be acknowledged through update_work_plan.',
    });
  }

  private availableBridgeTools(): ToolHandler[] {
    return [...this.toolExecutor.getTools().values()].filter(tool =>
      !this.toolExecutor.toolsDisabled || tool.name === 'get_work_plan' || tool.name === 'update_work_plan' || tool.name === 'get_cli_run_context');
  }

  private async executeBridgedTool(name: string, args: Record<string, unknown>): Promise<BridgeResult> {
    const id = randomUUID();
    const delegation = name === 'spawn_child' || name === 'escalate_to_other_lane' || name === 'collect_children' || this.toolExecutor.getTools().get(name)?.final === true;
    if (delegation) this.setPause('delegation', true);
    // A collect answer can be lost without the bridge noticing: a CLI that
    // timed the call out may drop it without closing the socket, so the write
    // succeeds and `undelivered` never fires. With nothing pending, re-send the
    // last settled batch once instead of reporting nothing to collect.
    const resent = name === 'collect_children' && this.detached.count() === 0 ? this.detached.redeliverLast() : 0;
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
        ...(resent ? [{ type: 'text' as const, text: `[Octipus] Nothing was pending, so these ${resent} result(s) are from your previous collect_children call, re-sent in case its response did not reach you.` }] : []),
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
  /** Spend proxy: fresh input + paid cache writes + output; cache reads excluded. See `getBillableTokens`. */
  private billableTokensUsed = 0;
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
    }, undefined, this.abortController.signal);
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

  /** Spend proxy: fresh input + paid cache writes + output. Budget gates compare this, not `getTotalTokens`. */
  override getBillableTokens(): number {
    return this.billableTokensUsed;
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

  /** Active run time, so `AgentManager.list()` shows a duration while a CLI runs. */
  override getElapsedMs(): number { return this.runStartedAt ? this.elapsed() : 0; }

  addSystemMessage(content: string): void {
    this.systemMessages.push(content);
    this.messages.push({ role: 'system', content, timestamp: new Date() });
  }

  async addUserMessage(content: string): Promise<void> {
    this.messages.push({ role: 'user', content, timestamp: new Date() });
    // Only persist for the root agent — sub-workers use handleMessage for
    // persistence — and never in a room, where the member's post is the
    // request's one user row (§6.3).
    if (isRootAgent(this.context) && !(await isRoomSession(this.context.sessionId))) {
      const row = await messageRepository.create({
        sessionId: this.context.sessionId,
        role: 'user',
        content,
        agentId: this.context.id,
      }, this.generation);
      this.userCursor = row.id ? { id: row.id, createdAt: row.createdAt.toISOString() } : undefined;
      await sessionRepository.incrementMessageCount(this.context.sessionId);
    }
  }

  private async fetchHistory(): Promise<AgentMessage[]> {
    if (!isRootAgent(this.context)) return [];
    const history = await readSessionHistory(this.context.sessionId, { room: roomRequestOf(this.context) });
    this.generation = history.generation;
    this.clearedAt = history.session?.context?.clearedAt;
    return history.messages;
  }

  async loadHistory(): Promise<void> {
    this.messages = await this.fetchHistory();
    agentLogger.debug(
      { agentId: this.context.id, messageCount: this.messages.length },
      'CLI agent history loaded',
    );
  }

  override isSettling(): boolean {
    return super.isSettling() || this.toolExecutor.isExecuting();
  }

  async run(userMessage?: string): Promise<string> {
    this.activeRuns++;
    try {
      return await (isRootAgent(this.context)
        ? withSessionConversation(this.context.sessionId, async () => {
          const system = this.messages.filter(m => m.role === 'system');
          this.messages = [...await this.fetchHistory(), ...system];
          return this.runInternal(userMessage);
        })
        : this.runInternal(userMessage));
    } finally {
      this.activeRuns--;
      if (this.activeRuns === 0) releaseCliSessions(this.context.id);
    }
  }

  private async runInternal(userMessage?: string): Promise<string> {
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
      if (!session || !(await canActInSession(session, this.context.userId, 'requester'))) throw new Error('CLI session ownership mismatch');
      // A child never loads root history, so it takes the generation once per
      // run, here: its cold retries and merge turns reuse it, and a /clear
      // mid-run then rejects its save like any stale root write.
      if (!isRootAgent(this.context)) this.generation = sessionGeneration(session.context as SessionContext | undefined);
      this.bridge = await startCliToolBridge({
        tools: () => this.availableBridgeTools(),
        blocked: name => this.toolExecutor.isToolBlocked(name),
        advertisedTools: () => {
          const tools = this.availableBridgeTools();
          const advertisement = this.config.toolAdvertisement;
          return advertisement?.mode === 'lazy' ? tools.filter(t => !isLongTailHandler(t, advertisement.coreToolIds)) : tools;
        },
        active: () => this.context.status === 'running' && !this.aborted,
        execute: (name, args) => this.executeBridgedTool(name, args),
        unqueued: new Set(['get_cli_run_context', 'get_work_plan']),
        undelivered: name => {
          if (name !== 'collect_children') return;
          const restored = this.detached.redeliverLast();
          if (restored) agentLogger.warn({ agentId: this.context.id, restored }, 'collect_children response undelivered; results kept for the next collect');
        },
      });
      if (this.aborted) throw new Error('Agent was aborted during bridge startup');
      this.connection = { url: this.bridge.url, key: this.bridge.key,
        conversationId: isRootAgent(this.context) ? this.context.sessionId : this.context.id,
        planMode: isPlanMode(session.context as { planMode?: boolean }), maxIterations: this.config.maxIterations };
      const helper = resolveCliMcpEntry().replace(/index\.js$/, 'agent-bridge-client.js');
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      // Custom CLI prompts may bypass role composition; give them the same vault workflow.
      if (!this.systemMessages.some(message => message.includes(VAULT_USAGE_GUIDANCE))) {
        this.addSystemMessage(VAULT_USAGE_GUIDANCE);
      }
      this.addSystemMessage(`You are connected to your Octipus run through the octipus MCP server. Its tools are your actual registered Octipus tools, including skills, plans and delegation when allowed. Use these tools for Octipus work.
` +
        `Communication: work quietly. Public intermediate text from the root agent is shown in the user's chat. Write only when there is a meaningful finding, blocker or change of direction; skip routine narration, heartbeats and tool-by-tool summaries. Do not repeat the same update in text and send_status_update. Use request_user_approval when a user decision is required, and give a concise final answer when finished.
` +
        `Tool selection: use available dedicated tools before shell equivalents. For reading, searching and editing files, use your CLI's native file tools or the corresponding Octipus tools; do not substitute shell commands or Python scripts when a suitable tool is available. Use the shell for builds, tests, git and system commands that need it. Explicit user instructions take precedence.
` +
        `Public unauthenticated curl GET/HEAD reads and package installation (including pip inside test containers) may run directly. For other external service or MCP access, use list_tools and describe_tool to find a suitable registered integration, then call_discovered_tool with its name and arguments. Do not create or reuse curl, Python or other shell clients when a suitable integration tool is available. Tools omitted from the initial tool list may still be discoverable. If no suitable tool exists or it is technically unavailable, use an allowed fallback and briefly state the reason; a permission denial is not technical unavailability.
` +
        `Call get_cli_run_context before working and before the final answer. Every Octipus tool response also includes fresh plan feedback and queued user guidance. Respect permissions and do not bypass a refused Octipus tool through vendor tools.
` +
        `Use native MCP calls when supported. Only if your CLI lacks MCP support or loading this MCP server actually fails, use its terminal tool to run the bridge helper: ${quote(process.execPath)} ${quote(helper)} tools; or ${quote(process.execPath)} ${quote(helper)} call <tool-name> '<JSON arguments>'. Quote arguments safely. Credentials are supplied by the parent environment; never print them.
` +
        `Use list_tools and describe_tool to discover additional tools, then call_discovered_tool with their name and arguments.
` +
        `Delegate only through Octipus spawn_child and collect_children. Your CLI's native subagents are disabled: they live inside this CLI process, and background work is lost when the process exits.`);
      const skillIndex = await this.cliSkillIndex();
      if (skillIndex) this.addSystemMessage(skillIndex);
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

      if (!this.aborted && this.detached.count() > 0) result = await this.settleDetachedChildren(result, buffered);

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
        totalTokens: this.totalTokens,
        billableTokens: this.billableTokensUsed,
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
      // Mirror the native worker: abort the cascade, then clear the pending map.
      this.abortController.abort((error as Error).message || 'parent failed');
      this.detached.cancelAll((error as Error).message || 'parent failed');
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
        billableTokens: this.billableTokensUsed,
        error: wasStopped ? undefined : (error as Error).message,
      }).catch(err => agentLogger.error({ err, agentId: this.context.id }, 'Failed to persist CLI terminal status'));

      throw error;
    } finally {
      await this.commentaryDelivery;
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
    // A resume key is freed once the vendor process has EXITED (its 'exit'
    // handler), never while it may still be writing the session through the
    // SIGTERM grace period. With no live process, nothing can still write it.
    if (!this.process || this.processExited) releaseCliSessions(this.context.id);
    this.abortController.abort('CLI agent stopped');
    this.detached.cancelAll('CLI agent stopped');
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
        killProcessTree(pid, proc);
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
   * Same safety net as the native worker: a CLI that finished without
   * collect_children still gets its children's results. One bounded merge
   * turn when the adapter streams and there is ample budget left (a merge
   * that tripped the shared iteration or wall limit would call stop() and
   * turn a fully collected answer into a failed run); otherwise the
   * formatted results are appended. Children still pending afterwards are
   * cancelled.
   */
  private async settleDetachedChildren(result: string, buffered: boolean): Promise<string> {
    const autoTimeoutMs = this.detached.computeAutoCollectTimeoutMs();
    agentLogger.warn({ agentId: this.context.id, pending: this.detached.count(), autoTimeoutMs }, 'Auto-collecting detached children left by the CLI before finalizing');
    this.setPause('delegation', true);
    let collected: ChildResult[] = [];
    try { collected = await this.collectAllDetached(autoTimeoutMs); } finally { this.setPause('delegation', false); }
    for (const r of collected) if (r.status !== 'timeout') swarmNodeRepository.markCollected(r.nodeId).catch(() => { /* reaper safety net */ });
    if (collected.length > 0) {
      const block = formatCollectedResults(collected);
      const remainingMs = this.config.timeout - this.elapsed();
      const canMerge = !this.aborted && !buffered && this.iteration + 1 < this.config.maxIterations
        && remainingMs > Math.max(60_000, this.config.timeout * 0.2);
      let merged = '';
      if (canMerge) {
        this.messages.push({ role: 'assistant', content: result, timestamp: new Date() });
        this.messages.push({ role: 'user', content: `Your detached subagents reported. Write ONE unified final answer for the user that merges these results — deduplicate, do not label per child, and say so if they disagree. An entry marked running has not finished: say that rather than inventing its conclusion.\n${block}`, timestamp: new Date() });
        try { merged = await this.executeCLI(); }
        catch (err) { agentLogger.warn({ err, agentId: this.context.id }, 'Merge turn for detached results failed; appending them instead'); }
      }
      result = merged.trim() ? merged : `${result}\n\n[Octipus] ${collected.length} detached subagent${collected.length === 1 ? '' : 's'} reported after this CLI's last Octipus tool call; the results were not merged into the answer above:\n${block}`;
    }
    if (this.detached.count() > 0) {
      agentLogger.warn({ agentId: this.context.id, pending: this.detached.count() }, 'Cancelling detached children still pending at CLI completion');
      this.detached.cancelAll('parent completed without collecting all children');
    }
    return result;
  }

  /**
   * Build the conversation prompt (user + assistant messages only).
   * System messages are handled separately via buildSystemPrompt().
   */
  private buildPrompt(): string {
    // The vendor session already holds every earlier turn. Re-sending them
    // would pay for the same history twice — once in our prompt and again in
    // the vendor's own replay — which is the whole cost this change removes.
    if (this.resuming) {
      const runContextBlock = this.messages.find(m => m.role === 'user' && m.content.startsWith('Octipus run context:'))?.content;
      const currentUserMessage = [...this.messages].reverse().find(m => m.role === 'user' && !m.content.startsWith('Octipus run context:'))?.content;
      return [...this.resumeDelta, runContextBlock, currentUserMessage].filter(Boolean).join('\n\n');
    }

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
    const model = await resolveCliModelEntry(this.context.model);
    this.accountingModelName = model?.name;
    return model?.metadata?.cliAgent || {};
  }

  private async executeCLI(opts?: { forceCold?: boolean }): Promise<string> {
    const toolConfig = getCLIToolConfig(this.context.model);
    if (!toolConfig) {
      throw new Error(`No CLI tool config found for model: ${this.context.model}`);
    }

    // Check quota
    const quotaTracker = getQuotaTracker();
    const quota = await quotaTracker.getStatus(toolConfig.quotaProvider);
    if (quota.exhausted) {
      throw new ClassifiedError({ reason: FailoverReason.QUOTA_EXHAUSTED, recovery: RecoveryAction.FALLBACK_PROVIDER,
        providerHint: toolConfig.quotaProvider,
        message: `Quota exhausted for ${toolConfig.name}. Resets at ${quota.resetsAt?.toISOString() || 'unknown'}` });
    }
    // Dollar spend budgets, before the CLI process starts. Subscription CLIs
    // log zero or estimated cost, so they rarely move the needle themselves,
    // but a budget paused by API spend must stop them too. A failing check
    // (DB hiccup) does not block the run, as in agent-worker.
    try {
      const { checkSpend } = await import('@/security/spend-budgets');
      await checkSpend({ userId: this.context.userId, role: this.context.role, workspaceId: this.context.workspaceId, sessionId: this.context.sessionId });
    } catch (err) {
      if (err instanceof Error && err.name === 'SpendBudgetExceededError') throw err;
      agentLogger.debug({ err }, 'spend budget check unavailable (not blocking)');
    }

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
    // Swarm worktree isolation: the spawner created this child a git worktree
    // of the project (see `swarm/worktree.ts`). Resolved AFTER the session
    // checks above so a vanished project still fails loud, and accepted only
    // when it names an existing directory under the worktrees root.
    const worktreeCwd = worktreeCwdOverride(this.context.metadata as Record<string, unknown> | undefined);
    if (worktreeCwd) {
      workspaceCwd = worktreeCwd;
    } else if (this.context.metadata?.worktreePath !== undefined) {
      agentLogger.warn(
        { agentId: this.context.id, worktreePath: this.context.metadata.worktreePath },
        'CLI agent: ignoring worktreePath outside the worktrees root — using the shared tree',
      );
    }

    // Vendor CLI session reuse — always on for adapters the shared
    // capability table marks resumable (never a hardcoded adapter check
    // here). `forceCold` is the cold-retry's own flag: it skips this whole
    // block so the retry can never itself trigger another retry (no
    // `resume` => the close handler's dead-session branch below cannot fire
    // for it).
    const providerEnv = await toolConfig.buildEnv?.();
    // Roots continue one vendor session per octipus session. A child only
    // resumes when its spawner gave it an explicit `resumeKey` (parent scope,
    // role, task), and never while another live agent holds the same key —
    // that one starts cold rather than share a vendor conversation.
    const root = isRootAgent(this.context);
    let storeKey: string | undefined;
    // Never in a room (§6.4): a vendor session would carry one requester's
    // conversation into the next requester's turn; each room turn starts
    // cold from the fenced transcript.
    if (canResume(adapterKey) && !(await isRoomSession(this.context.sessionId))) {
      const childResumeKey = root ? undefined : this.context.metadata?.resumeKey;
      if (root) storeKey = adapterKey;
      else if (typeof childResumeKey === 'string' && childResumeKey) {
        const key = childCliSessionKey(adapterKey, childResumeKey);
        if (claimCliSession(this.context.sessionId, key, this.context.id)) storeKey = key;
        else agentLogger.info({ agentId: this.context.id, resumeKey: childResumeKey }, 'CLI resume key held by a running agent — starting cold');
      }
    }
    const reuseSessions = !!storeKey;
    // A stopped child has released its key (see stop()), and a retry may
    // already hold it: its late save must not overwrite the new holder's.
    const ownsStoreKey = () => {
      if (!reuseSessions) return false;
      if (root) return true;
      // Released on exit when stopped, so a turn-limit/budget/timeout stop still
      // records its id and cursor — unless a retry has taken the key since.
      const holder = cliSessionHolder(this.context.sessionId, storeKey!);
      return holder === undefined || holder === this.context.id;
    };
    let resume: { id: string; isFirstRun: boolean } | undefined;
    let fingerprint: string | undefined;
    if (reuseSessions) {
      const model = (adapterKey === 'Claude Code' ? process.env.CLAUDE_MODEL : adapterKey === 'Codex CLI' ? process.env.CODEX_MODEL : undefined) || settings.model;
      const run = { model, permissionMode: settings.permissionMode, planMode: this.connection?.planMode, workingDirectory: workspaceCwd };
      const tools = [...this.toolExecutor.getTools().values()];
      // Everything before VOLATILE_MARKER. For a keyed child that is its role
      // prompt, critical rules and guidance (the spawner puts the brief- and
      // session-selected skills after the marker), plus the stable worker
      // guidance; a resumed run re-sends the tail, as for roots.
      const instructions = this.systemMessages.map(part => part.split(VOLATILE_MARKER)[0]).join('\n\n');
      // A child's lazy core set and its discovery tools follow its brief, so it
      // is fingerprinted by tool ids without them rather than full schemas.
      const toolIdentity = root
        ? tools.map(tool => [tool.name, tool.description, tool.parameters]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        : [this.context.role, [...new Set(tools.filter(tool => tool.toolId !== TOOL_DISCOVERY_TOOL_ID).map(tool => tool.toolId ?? tool.name))].sort()];
      fingerprint = fingerprintRun({ ...run, providerIdentity: JSON.stringify([this.context.model, toolConfig.name, settings.extraArgs, providerEnv, toolIdentity]), instructions });
      const existing = opts?.forceCold ? null : await loadCliSession(this.context.sessionId, storeKey!, fingerprint);
      this.resumeDelta = existing?.acknowledged
        ? (await messageRepository.findContextMessages(this.context.sessionId, this.clearedAt, existing.acknowledged, this.generation))
          .filter(row => row.id !== this.userCursor?.id)
          .map(row => `[${row.role}] ${toContextMessage(row).content}`)
        : [];
      // Style comes from the shared table, never an adapter-name comparison —
      // a future caller-minted adapter must fall into the minted branch
      // automatically, not silently land in the captured one and never resume.
      if (CLI_RESUME[adapterKey].style === 'caller-minted') {
        // The caller mints the id itself, so the first run declares it too —
        // no window in which a resumable run has no id.
        resume = { id: existing?.id ?? randomUUID(), isFirstRun: !existing };
      } else {
        // Captured style: the id comes from the CLI's own output
        // (onVendorSession below). The first run still participates in
        // reuse — an empty id with isFirstRun=true tells the arg builder to
        // drop --ephemeral so THIS run can be resumed later — it just has
        // nothing to resume yet.
        resume = { id: existing?.id ?? '', isFirstRun: !existing };
      }
    }

    // Recovery opens a new persistent conversation and cannot retry recursively.
    this.resuming = !!resume && !resume.isFirstRun;
    const prompt = this.buildPrompt();
    // A resumed keyed child re-sends only the volatile tail of its marker
    // message: the stable guidance appended after it (vault, bridge) is in the
    // vendor's first-run snapshot and fingerprinted. Roots are unchanged.
    const resumedChildSystem = this.resuming && !root ? this.systemMessages.filter(part => VOLATILE_MARKER.test(part)) : undefined;

    this.launchCleanup?.();
    this.launchCleanup = undefined;
    // Async vendor discovery stays out of the synchronous arg builder (event-loop safe).
    // A space run needs the bridge: its adapter's space mode routes native
    // tools through Octipus's decision path over it (CLI_SPACE_MODES).
    if (this.context.space && !this.connection) throw new Error('A CLI model in a shared space needs the Octipus bridge, which did not start');
    const codexMcpServers = this.connection && adapterKey === 'Codex CLI' ? await discoverCodexMcpServers(workspaceCwd) : undefined;
    const built = this.argBuilder.build(adapterKey, toolConfig.name === 'Mistral Vibe' && systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt, settings, resumedChildSystem ?? this.systemMessages, resumedChildSystem ? resumedChildSystem.join('\n\n') : systemPrompt, Math.max(0, this.config.maxTokenBudget - this.billableTokensUsed), this.context.id, this.connection ? { ...this.connection, workingDirectory: workspaceCwd, codexMcpServers, shellGuard: getConfig().agent?.cliShellGuard !== false, maxIterations: Math.max(1, this.config.maxIterations - this.iteration), space: !!this.context.space } : undefined, resume);
    const { binary, args, stdinPrompt, useShell } = built;
    this.launchCleanup = () => {
      const configIndex = args.indexOf('--mcp-config');
      // Windows writes the system prompt to a temp file (command-line length cap).
      const sysFileIndex = args.indexOf('--append-system-prompt-file');
      const paths = [built.env?.VIBE_HOME, ...(this.connection && configIndex >= 0 ? [args[configIndex + 1]] : []), ...(sysFileIndex >= 0 ? [args[sysFileIndex + 1]] : [])];
      for (const path of paths) if (path) {
        try { rmSync(path, { recursive: true, force: true }); }
        catch (err) { agentLogger.warn({ err, path }, 'CLI temporary configuration cleanup failed'); }
      }
    };
    // Vendor CLIs that reuse the `claude` binary (z.ai GLM / Moonshot Kimi) inject
    // ANTHROPIC_BASE_URL + auth token via buildEnv — merge it over the adapter's env.
    const toolEnv = { ...built.env, ...providerEnv };


    const previousCounters = this.parser?.getSideEffectCounters();
    if (previousCounters) this.pastParserCounters = mergeCounters(this.pastParserCounters ?? emptyCounters(), previousCounters);
    const invocationStartIteration = this.iteration;
    let invocationUsage: import('@/models/litellm-client').CompletionResult['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false };
    let capturedVendorId: string | undefined;
    let vendorSessionStarted = false;
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
        // Native tool uses feed the flow label (security/flow-guard.ts); bridged
        // Octipus tools are observed by ToolExecutor instead.
        const use = data as { type?: string; toolName?: string; args?: Record<string, unknown> } | null;
        if (type === 'action' && use?.type === 'cli_tool_use' && use.toolName && !CLI_BRIDGED_TOOL_RE.test(use.toolName)) {
          observeFlow(this.context.sessionId, { toolId: `cli-native:${use.toolName}`, action: use.toolName, args: use.args });
        }
        this.emit(type, data);
      },
      {
        onCommentary: text => {
          if (!isRootAgent(this.context) || this.aborted) return;
          const generation = this.generation;
          this.commentaryDelivery = this.commentaryDelivery.then(async () => {
            const { getAgentService } = await import('./agent/service');
            await getAgentService().sendStatusUpdate(text, this.context, 'commentary', undefined, generation);
          }).catch(err => agentLogger.warn({ err, agentId: this.context.id }, 'CLI commentary delivery failed'));
        },
        isBridgedTool: name => CLI_BRIDGED_TOOL_RE.test(name),
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
          // Spend proxy: fresh input + paid cache writes + output; cache reads excluded
          // (Plan 1's split, `billableTokens`) — a resumed session replaying
          // its whole context as cache reads must not look expensive, and a
          // well-cached session must not SIGKILL against a budget its fresh
          // tokens are nowhere near.
          this.billableTokensUsed += billableTokens({
            inputTokens: tokens.input, outputTokens: tokens.output, totalTokens: tokens.total,
            cacheReadTokens: tokens.cacheRead ?? 0, cacheCreationTokens: tokens.cacheCreation ?? 0,
            available: true,
          });
          const cap = this.config.maxTokenBudget;
          if (!this.budgetExceeded && cap > 0 && this.billableTokensUsed >= cap) {
            this.budgetExceeded = true;
            agentLogger.warn(
              { agentId: this.context.id, used: this.billableTokensUsed, cap },
              'CLI sub-agent exceeded token budget — killing subprocess',
            );
            this.stop();
          }
        },
        onSessionInit: () => { vendorSessionStarted = true; },
        onRunError: (reason) => {
          // Record the first CLI-reported failure; the close handler rejects
          // with it so the run surfaces as failed, not (no response) success.
          if (!this.runError) this.runError = reason;
        },
        // Codex assigns its own thread id (thread.started); this fires once
        // per run and is Codex's early write point. Claude's id is
        // caller-minted, so there is nothing to capture: the close handler
        // records it (on a clean close, or when a keyed child is stopped).
        onVendorSession: (id) => {
          capturedVendorId = id;
          // Write it as soon as the vendor announces it, not only on a clean
          // close. A timeout, a kill or a crash after this point would
          // otherwise orphan the vendor thread — it exists on disk, we just
          // forgot its id, and the next turn pays a cold launch for nothing.
          // The close handler rewrites the record with the acknowledged
          // cursor; this early row carries no cursor, so a resume off it
          // re-sends the turn rather than skipping it.
          if (!ownsStoreKey()) return;
          void saveCliSession(this.context.sessionId, storeKey!, {
            id, fingerprint: fingerprint!, lastUsedAt: new Date().toISOString(),
            generation: this.generation, ownerAgentId: this.context.id,
          }).catch(err => agentLogger.warn({ err, agentId: this.context.id }, 'Failed to store CLI session id'));
        },
      },
      workspaceCwd,
    );

    agentLogger.info(
      { tool: toolConfig.name, hasSystemPrompt: !!systemPrompt, cwd: workspaceCwd },
      'CLI agent context',
    );

    if (getConfig().agent?.promptDumps !== false) try {
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
      try { assertWindowsCmdLineFits(binary, args, process.platform, useShellForSpawn); } catch (err) { cleanupContextFiles(); reject(err); return; }
      this.processExited = false;
      // `shell: true` hands the command line to cmd.exe, and Node joins
      // `[command, ...args]` with plain spaces, quoting nothing. An unquoted
      // `C:\Program Files\…` therefore arrives as the command `C:\Program` plus
      // two stray arguments — which is how every CLI installed under Program
      // Files (and `process.execPath` itself) failed with "Der Befehl ... ist
      // entweder falsch geschrieben".
      //
      // Arguments split the same way, and they are likelier to carry a space
      // than the binary is: `--add-dir C:\Users\John Doe\repo` is an ordinary
      // workspace. cmd.exe's `/s` strips only the outer pair Node adds, so the
      // inner quotes survive on both. Shared with `execCli` (cli-provider.ts)
      // — same shell:true quoting rule, one place: escapes embedded quotes
      // and doubles a trailing backslash run before the closing quote rather
      // than leaving a quote-bearing or backslash-terminated value unquoted.
      const shellQuote = (value: string): string => (useShellForSpawn ? windowsShellQuote(value) : value);
      const quoteArg = windowsShellQuoter(binary);
      const proc = spawn(shellQuote(binary), useShellForSpawn ? args.map(quoteArg) : args, {
        env,
        cwd: workspaceCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // No spawn-option `timeout` — the single timeout source is the
        // hardTimeout below, which stamps abortReason='timeout' so a timeout
        // always surfaces as a timeout, not "exited with code null" (C8).
        shell: useShellForSpawn,
        windowsHide: true,
      });
      // 'exit' fires when the process terminates (before streams flush).
      proc.once('exit', () => {
        this.processExited = true;
        // Stopped (cancel, timeout, kill): the vendor session is safe to hand
        // to a retry now, without waiting for the run promise to settle.
        if (this.aborted) releaseCliSessions(this.context.id);
      });

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

      // A caller-minted id (Claude: --session-id / --resume) is known before
      // the process even starts, so unlike a captured id there is nothing to
      // wait for — write it as soon as the process starts. One write per
      // run, here and only here.

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
              void answerCliPermissionRequest(event, this.context, (type, data) => this.emit(type, data), this.abortController.signal,
                this.bridge ? () => this.availableBridgeTools() : undefined,
              ).then(response => {
                if (!this.aborted && proc.stdin?.writable) proc.stdin.write(JSON.stringify(response) + '\n');
              }).catch((err: unknown) => {
                if (this.aborted || this.abortController.signal.aborted) return;
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

      proc.on('close', async (code, signal) => {
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
                // No cache breakdown from buffer-at-end tools — billable = total.
                this.billableTokensUsed += billableTokens(parsed.usage);
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

          // Background work the CLI started and never reported finished died
          // with the process. Nothing can keep it alive; say so loudly.
          const lostBackground = parser.getOpenBackgroundTasks();
          if (lostBackground.length) {
            const note = `CLI exited with ${lostBackground.length} background task(s) still running: ${lostBackground.join('; ')} — their work was lost`;
            agentLogger.warn({ agentId: this.context.id, lostBackground }, 'CLI exited with open background tasks');
            this.emit('observation', { type: 'warning', message: note });
            accumulatedText = `${accumulatedText}${accumulatedText ? '\n\n' : ''}⚠ ${note}`;
          }

          if (!invocationUsage.available) {
            // Buffered adapters (Vibe, Antigravity) report no usage. Estimate
            // from characters so token budgets and pipeline pools stop treating
            // these runs as free; the row is marked as an estimate.
            const est = (s: string | null | undefined) => Math.ceil((s?.length ?? 0) / 4);
            const inputTokens = est(systemPrompt) + est(prompt) + est(stdinPrompt);
            const outputTokens = est(accumulatedText);
            invocationUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, available: true, estimated: true };
            this.totalTokens += invocationUsage.totalTokens;
            this.billableTokensUsed += billableTokens(invocationUsage);
          }
          await recordProviderUsage({ model: this.context.model, modelConfigName: this.accountingModelName, messages: [], ...usageContextOf(this.context), requestType: 'cli' }, 'cli', { model: this.context.model, usage: invocationUsage }, code !== 0 || this.aborted || !!this.runError);

          // A keyed child stopped by a turn limit (ours, or Claude's
          // error_max_turns), a timeout or a cancel still records its vendor
          // session (without a cursor) so its next run on the task resumes —
          // only if the vendor confirmed the session this run, and unless a
          // retry already holds the key. Over budget, it is dropped instead:
          // the next run starts cold rather than inherit the spent context.
          if (!root && ownsStoreKey()) {
            const confirmedId = capturedVendorId || (vendorSessionStarted ? resume?.id : undefined);
            const hitTurnLimit = /max-turns limit/.test(this.runError ?? '');
            if (this.budgetExceeded) {
              await dropCliSession(this.context.sessionId, storeKey!)
                .catch(err => agentLogger.warn({ err, agentId: this.context.id }, 'Failed to drop over-budget CLI session id'));
            } else if ((this.aborted || hitTurnLimit) && confirmedId) {
              await saveCliSession(this.context.sessionId, storeKey!, {
                id: confirmedId, fingerprint: fingerprint!, lastUsedAt: new Date().toISOString(),
                generation: this.generation, ownerAgentId: this.context.id,
              }).catch(err => agentLogger.warn({ err, agentId: this.context.id }, 'Failed to store stopped CLI session id'));
            }
          }

          if (this.budgetExceeded) {
            reject(new BudgetExceededError({
              agentId: this.context.id,
              // The gate that set `budgetExceeded` compared the billable
              // figure; reporting the grand total made the error say a number
              // that was never checked against the cap.
              used: this.billableTokensUsed,
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

          // Only a FAILED run can be a quota failure. Matching a clean run's
          // answer text rejected any answer that merely mentioned "quota" or
          // "exceeded", and marked the provider exhausted for an hour.
          // Match only the vendor's error channels (stderr, the reported run
          // error), never the agent's own answer text: a run failing on e.g.
          // max-turns whose answer quoted a quota error re-armed the block.
          const failed = code !== 0 || !!signal || !!this.runError;
          if (failed && toolConfig.isQuotaError(`${stderr}\n${this.runError ?? ''}`)) {
            await quotaTracker.markExhausted(toolConfig.quotaProvider);
            reject(new ClassifiedError({ reason: FailoverReason.QUOTA_EXHAUSTED, recovery: RecoveryAction.FALLBACK_PROVIDER,
              providerHint: toolConfig.quotaProvider, message: `Quota exhausted for ${toolConfig.name}` }));
            return;
          }

          // A resumed vendor session can be gone (Claude: "No conversation
          // found with session ID: <id>"; Codex resume errors out rather than
          // silently starting a new thread) — drop the stale id and retry
          // once, cold, with the full prompt, so the turn is not lost.
          // `resume` is undefined on a forceCold retry (computed above), so
          // this can never recurse.
          //
          // This MUST come before the `runError` rejection below. Claude handed
          // a stale id emits a `result` with `is_error: true` AND exits
          // non-zero, so `runError` is set — rejecting on it first made the
          // recovery unreachable, the stale id was never dropped, and every
          // later turn failed identically. Permanent, not a one-off. The vendor
          // says so on both channels, so match both.
          const deadSessionEvidence = `${stderr}\n${this.runError ?? ''}`;
          if (!opts?.forceCold && resume && (this.runError || (code !== 0 && code !== null)) && /no conversation found|session not found/i.test(deadSessionEvidence)) {
            await dropCliSession(this.context.sessionId, storeKey!);
            agentLogger.warn({ agentId: this.context.id, adapterKey, id: resume.id }, 'Vendor CLI session is gone — retrying cold with the full prompt');
            // The dead attempt's error must not outlive it: `runError` is a
            // worker field, and a leftover value makes the cold retry reject on
            // the failure it was spawned to recover from — and marks a
            // successful retry 'failed' in the terminal bookkeeping.
            this.runError = null;
            resolve(this.executeCLI({ forceCold: true }));
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
          if (code !== 0 || signal) {
            const diagnostic = stderr.split('\n')
              .filter(line => !isCodexHookTrustWarning(line))
              .join('\n').trim().slice(-1000);
            const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
            const message = `CLI ${binary} exited with ${reason}: ${diagnostic || 'no failure diagnostic reported'}`;
            agentLogger.error({ agentId: this.context.id, exitCode: code, signal, stderrTail: stderr.slice(-4000) }, message);
            reject(new Error(message));
            return;
          }

          // The assistant reply is persisted once, by AgentService after the
          // output guard — this worker used to write a second, unguarded row.

          agentLogger.info(
            { agentId: this.context.id, tool: toolConfig.name, durationMs: Date.now() - startTime, iterations: this.iteration },
            'CLI sub-agent completed',
          );

          const vendorId = capturedVendorId || resume?.id;
          if (ownsStoreKey() && vendorId) await saveCliSession(this.context.sessionId, storeKey!, {
            id: vendorId, fingerprint: fingerprint!, lastUsedAt: new Date().toISOString(),
            generation: this.generation, ownerAgentId: this.context.id, acknowledged: this.userCursor,
          });
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

export { buildChildEnv } from './cli-child-env';
