import { mkdirSync, writeFileSync } from 'fs';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { homedir } from 'os';
import { join as joinPath } from 'path';
import { recordAgentCompletion } from '@/core/agent-task-recorder';
import { agentRepository } from '@/db/repositories/agent-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { getCostTracker } from '@/models/cost-tracker';
import { type CompletionResult, getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { type ToolShimSchema, translateToToolCall } from '@/models/toolshim';
import { applyTopicParamOverrides, getTopicConfig } from '@/models/topic-config';
import { getConfig } from '@/config';
import type { ModelConfigEntry } from '@/db/schema/models';
import { compactMessagesWithSummary, CONTEXT_OVERFLOW_TRUNCATED_MARKER, DEFAULT_TOOL_OUTPUT_SOFT_CAP, truncateOldestToolOutputs } from '@/utils/context-compaction';
import { agentLogger, coreLogger } from '@/utils/logger';
import { BaseAgentWorker } from './agent-base';
import type { ToolHandler } from './agent-base';
import { isLongTailHandler } from './orchestrator/tool-split';
import { ClassifiedError } from './errors/classification';
import {
  BudgetExceededError,
  CascadedCancellationError,
  ChildTimeoutError,
} from './swarm/errors';
import type { ChildResult, PendingChild } from './swarm/types';
import { ToolExecutor } from './tool-executor';
import type { AgentMessage, ToolCall } from './types';

// Re-export types for backward compatibility
export type { AgentEvent, AgentEventHandler, AgentWorkerConfig, ToolHandler } from './agent-base';

export class AgentWorker extends BaseAgentWorker {
  private toolExecutor: ToolExecutor;
  private abortController: AbortController;
  private totalTokensUsed: number = 0;
  private startTime: number = 0;
  private emptyRetries: number = 0;
  private llmRetries: number = 0;
  /** Iteration index at which toolshim last ran — caps it to once per iteration. */
  private toolShimAttemptedIteration: number = -1;
  /** Log the unbound-translator skip only once per agent. */
  private toolShimUnboundLogged: boolean = false;
  /** Track consecutive identical tool calls (same name + args) to detect loops */
  private lastToolCallSignature: string = '';
  private consecutiveRepeatCount: number = 0;
  private static MAX_CONSECUTIVE_REPEATS = 3;

  /** Track consecutive same-tool-name calls regardless of args — catches chatty LLMs looping on send_status_update with slightly different messages */
  private lastToolNames: string = '';
  private consecutiveSameNameCount: number = 0;
  /**
   * After this many consecutive iterations on the same tool-name signature,
   * tools get disabled and the model is forced to a plain-text reply. The
   * threshold has to be high enough to survive normal doer workflows
   * (read 8 files → write 5 files often hits the same name pattern across
   * 3-4 iterations) and low enough to still catch genuine spam loops on
   * status/notification tools. 5 is the empirical sweet spot.
   */
  private static MAX_SAME_NAME_REPEATS = 5;
  /**
   * Tools that are LEGITIMATELY called many times in a row. The same-tool-
   * name guard is meant to catch chatty status-report / notification loops
   * (`send_status_update` spinning with slightly different progress
   * messages), NOT productive work like reading or writing files. Anything
   * that produces real side effects / new state belongs here.
   *
   * Matching is exact-name AND by namespace prefix (`filesystem__`,
   * `shell__`, `git__`, `web_`, `code__`) — see callsAllowList below.
   * Status / notification tools stay off this list so the guard still
   * catches them.
   */
  private static REPEAT_ALLOWED_TOOLS = new Set<string>([
    'spawn_child',
    'collect_children',
    'create_pipeline',
    'list_pipeline_templates',
    'request_user_approval',
  ]);
  /**
   * Namespace prefixes (matched via tc.name.startsWith) for tools that
   * always count as productive work — file I/O, shell, git, web fetches,
   * code edits. The doer roles (coding, design, devops) routinely chain
   * many of these in sequence and tripping the same-name guard wastes
   * their progress.
   */
  private static REPEAT_ALLOWED_PREFIXES = ['filesystem__', 'shell__', 'git__', 'web_', 'code__', 'search_'];

  /** Queue for steering messages injected mid-run */
  private steeringQueue: AgentMessage[] = [];

  /**
   * Count of nudge-retries triggered when the model bails on tool use and
   * dumps file contents as inline text. Limited to one retry per agent
   * lifetime — if the model keeps refusing tools after a direct nudge,
   * accept the text reply rather than spinning forever.
   */
  private toolBailoutRetries: number = 0;

  /** Inject a message into the agent's context mid-run. */
  steer(message: AgentMessage): void {
    this.steeringQueue.push(message);
    // Grant one iteration of headroom so a steer arriving as the loop is about
    // to finish (e.g. during the final synthesis turn) is still processed
    // rather than silently dropped when the iteration budget is exhausted.
    this.config.maxIterations += 1;
  }

  /**
   * Wall-clock time spent blocked on synchronous child spawns. Subtracted
   * from `elapsed()` so parent's timeout does NOT tick down while it's
   * awaiting a subagent. User spec: "waiting time should not go into the
   * timeout calculation."
   */
  private pausedMs: number = 0;

  /** Increment the paused counter by `durationMs`. Called by ToolExecutor around `spawn_child`. */
  addPausedMs(durationMs: number): void {
    if (durationMs > 0) this.pausedMs += durationMs;
  }

  /**
   * Detached subagents spawned by this worker that have not yet been
   * picked up via `collect_children` (or auto-collect). Key is the
   * childHandle issued by `createSpawnChildTool`.
   */
  private pendingDetached: Map<string, PendingChild> = new Map();
  private collectedDetached: Map<string, ChildResult> = new Map();

  registerPendingChild(pc: PendingChild): void {
    this.pendingDetached.set(pc.childId, pc);
    // Settle eagerly into collectedDetached so auto-collect and ad-hoc
    // collect_children calls can both find results without racing on the
    // shared promise. We keep the entry in pendingDetached until the LLM
    // (or framework) explicitly collects — that's what drives the cap.
    pc.promise.then(
      (result) => { this.collectedDetached.set(pc.childId, result); },
      (err) => {
        const failMsg = (err as Error)?.message || 'detached spawn threw';
        this.collectedDetached.set(pc.childId, {
          nodeId: pc.childId,
          kind: 'subagent',
          status: 'tool_error',
          output: null,
          usedTokens: 0,
          durationMs: Date.now() - pc.startedAt,
          spawnedChildren: [],
          notes: failMsg,
        });
      },
    );
  }

  pendingDetachedCount(): number {
    return this.pendingDetached.size;
  }

  listPendingDetached(): PendingChild[] {
    return [...this.pendingDetached.values()];
  }

  /** Mark a pending child as collected. Returns its result (awaiting if needed). */
  async collectDetached(childId: string, timeoutMs: number): Promise<ChildResult | null> {
    const pc = this.pendingDetached.get(childId);
    if (!pc) return null;
    const settled = this.collectedDetached.get(childId);
    if (settled) {
      this.pendingDetached.delete(childId);
      return settled;
    }
    try {
      const result = await Promise.race([
        pc.promise,
        new Promise<ChildResult>((_, reject) =>
          setTimeout(() => reject(new Error(`collect_children timeout after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
      this.pendingDetached.delete(childId);
      return result;
    } catch (err) {
      // Leave it in pending for a later retry; surface failure as a result
      // object so the LLM keeps going instead of throwing.
      return {
        nodeId: childId,
        kind: 'subagent',
        status: 'timeout',
        output: null,
        usedTokens: 0,
        durationMs: Date.now() - pc.startedAt,
        spawnedChildren: [],
        notes: (err as Error).message,
      };
    }
  }

  /**
   * Timeout for the final auto-collect — reserve the last ~20% of the
   * worker's configured wall-clock so the merge-turn has budget to run.
   */
  private computeAutoCollectTimeoutMs(): number {
    const wall = this.config.timeout ?? 240_000;
    return Math.min(60_000, Math.max(10_000, Math.floor(wall * 0.2)));
  }

  /** Cancel all pending detached children. Fire-and-forget — call on worker fail/abort. */
  private cancelAllDetached(reason: string): void {
    if (this.pendingDetached.size === 0) return;
    agentLogger.warn(
      { agentId: this.context.id, pending: this.pendingDetached.size, reason },
      'Cancelling pending detached children (parent worker terminating)',
    );
    for (const [, pc] of this.pendingDetached) {
      // The detached promise is already in flight inside the spawner; we
      // don't have a direct AbortController handle for each child. The
      // parent's AbortController (this.abortController) has already been
      // aborted by the fail/abort path — children that listen to the
      // parent signal (set in spawner.ts parentSignal) will tear down.
      // Emit a breadcrumb so ops can see the cascade in logs.
      coreLogger.info({ childId: pc.childId, startedAt: pc.startedAt }, 'detached child cancel-cascade');
    }
    this.pendingDetached.clear();
  }

  /** Collect every still-pending detached child. Used by collect_children and auto-collect. */
  async collectAllDetached(timeoutMs: number): Promise<ChildResult[]> {
    const entries = [...this.pendingDetached.entries()];
    if (entries.length === 0) return [];
    const results = await Promise.all(
      entries.map(async ([childId]) => {
        const r = await this.collectDetached(childId, timeoutMs);
        return r;
      }),
    );
    return results.filter((r): r is ChildResult => r !== null);
  }

  /** Milliseconds of *active* work since agent start (excludes child-wait time). */
  private elapsed(): number {
    return Math.max(0, Date.now() - this.startTime - this.pausedMs);
  }

  /** Public elapsed time for status reporting (active only). */
  override getElapsedMs(): number {
    return this.startTime > 0 ? this.elapsed() : 0;
  }

  /** Optional parent AbortSignal — chained so that parent abort cascades down. */
  private parentSignalCleanup: (() => void) | null = null;

  constructor(
    context: import('./types').AgentContext,
    config: import('./agent-base').AgentWorkerConfig,
    opts?: { parentSignal?: AbortSignal },
  ) {
    super(context, config);
    this.abortController = new AbortController();
    this.toolExecutor = new ToolExecutor(
      context,
      (type, data) => this.emit(type, data),
      (ms) => this.addPausedMs(ms),
    );

    // Swarm Phase 2: chain parent AbortSignal → this worker's controller.
    // Any ancestor cancellation flows down. The `once` listener is cleaned up
    // on this.stop() to avoid leaks when the parent signal outlives the child.
    if (opts?.parentSignal) {
      const parent = opts.parentSignal;
      if (parent.aborted) {
        // Already aborted at construction — fire immediately on next tick so
        // the caller has a chance to wire onEvent handlers first.
        queueMicrotask(() => this.abortController.abort(parent.reason));
      } else {
        const onAbort = () => this.abortController.abort(parent.reason);
        parent.addEventListener('abort', onAbort, { once: true });
        this.parentSignalCleanup = () => parent.removeEventListener('abort', onAbort);
      }
    }
  }

  /** Public access so the spawner can plumb token deltas into the swarm node bookkeeping. */
  getAbortSignal(): AbortSignal {
    return this.abortController.signal;
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
      const dumpDir = joinPath(homedir(), '.octipus', 'prompts');
      mkdirSync(dumpDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dumpPath = joinPath(dumpDir, `${ts}_${this.context.id}_${this.context.role}.md`);
      const body = [
        `# Agent ${this.context.id}`,
        `role: ${this.context.role}`,
        `topic: ${this.context.topic || ''}`,
        `model: ${this.context.model}`,
        `sessionId: ${this.context.sessionId}`,
        '',
        ...this.messages.map((m, i) => `## [${i}] ${m.role}\n${m.content || ''}`),
      ].join('\n');
      writeFileSync(dumpPath, body, 'utf-8');
      agentLogger.info({ agentId: this.context.id, path: dumpPath }, 'Dumped agent prompt');
    } catch (err) {
      agentLogger.debug({ err, agentId: this.context.id }, 'Failed to dump agent prompt');
    }

    try {
      const result = await this.loop();

      // Auto-collect any still-pending detached children before finalizing.
      // The LLM should have called `collect_children` explicitly; this is
      // the forget-to-collect safety net. We inject the results as a
      // system message and re-enter the loop ONCE more so the parent can
      // synthesize with them. If that synthesis turn doesn't produce a
      // meaningful output we fall back to `result`.
      let finalResult = result;
      if (this.pendingDetached.size > 0) {
        const autoTimeoutMs = this.computeAutoCollectTimeoutMs();
        agentLogger.warn(
          { agentId: this.context.id, pending: this.pendingDetached.size, autoTimeoutMs },
          'Auto-collecting forgotten detached children before finalizing',
        );
        const collected = await this.collectAllDetached(autoTimeoutMs);
        if (collected.length > 0) {
          const summary = collected
            .map((r) => {
              const out = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
              return `- [${r.status}] node ${r.nodeId}: ${out.slice(0, 500)}${(r.notes ? ` (${r.notes})` : '')}`;
            })
            .join('\n');
          this.addSystemMessage(
            `SYSTEM: You had ${collected.length} detached subagent${collected.length > 1 ? 's' : ''} ` +
              `you did not collect before finalizing. Results auto-collected:\n${summary}\n\n` +
              `Synthesize these into your final answer now.`,
          );
          try {
            const withMerge = await this.loop();
            if (typeof withMerge === 'string' && withMerge.trim().length > 0) {
              finalResult = withMerge;
            }
          } catch (mergeErr) {
            agentLogger.error(
              { err: mergeErr, agentId: this.context.id },
              'Auto-collect synthesis turn failed; returning pre-merge result',
            );
          }
        }
      }

      this.context.status = 'completed';
      this.context.completedAt = new Date();
      this.emit('status_change', { status: 'completed' });
      this.emit('complete', { result: finalResult });

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

      // Record completion to task_state so siblings can discover it
      // via typed lookup (Phase B of `.octipus/memory-redesign.md`).
      // Fire-and-forget — never block on recording failures.
      //
      // `swarmNodeId` is the agent id: `swarm_nodes.id` is 1:1 with
      // `agents.id` (see `swarm-design.md`). `workspaceId` is
      // inherited from the agent context, which the orchestrator
      // threads in at spawn time.
      recordAgentCompletion({
        agentId: this.context.id,
        sessionId: this.context.sessionId,
        userId: this.context.userId,
        workspaceId: this.context.workspaceId ?? null,
        swarmNodeId: this.context.id,
        role: this.context.role,
        topic: this.context.topic,
        output: typeof finalResult === 'string' ? finalResult : JSON.stringify(finalResult),
      }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in agent-worker'));

      // Auto-update project summary for roles that work on projects
      const summaryRoles = ['coding', 'research', 'review', 'general', 'qa', 'devops', 'design', 'security', 'data', 'ai'];
      if (summaryRoles.includes(this.context.role) && typeof finalResult === 'string' && finalResult.length > 50) {
        import('@/core/orchestrator/project-summary').then(({ autoUpdateProjectSummary }) => {
          const title = `${this.context.role} — ${this.context.topic || 'task'}`;
          autoUpdateProjectSummary(this.context, title, finalResult).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in agent-worker'));
        }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in agent-worker'));
      }

      // Close any browser tabs the agent opened via browser-ext.new_tab
      import('@/tools/browser-ext').then(({ closeAgentTabs }) => {
        closeAgentTabs(this.context.id).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in agent-worker'));
      }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in agent-worker'));

      return finalResult;
    } catch (error) {
      // Distinguish clean cancellation from a real failure. Both the
      // user-initiated stop() and parent-cascade abort flip
      // `abortController.signal.aborted` before the loop unwinds, and any
      // cascaded cancellation surfaces as CascadedCancellationError.
      // Either way the agent should land in 'stopped', not 'failed', so the
      // UI doesn't show a red "failed" after a deliberate cancel.
      const wasStopped =
        error instanceof CascadedCancellationError ||
        this.abortController.signal.aborted;
      const terminalStatus: 'stopped' | 'failed' = wasStopped ? 'stopped' : 'failed';

      this.context.status = terminalStatus;
      this.context.completedAt = new Date();
      // stop() already emitted status_change:stopped; don't double-fire.
      if (!wasStopped) {
        this.emit('status_change', { status: 'failed' });
        this.emit('error', { error: (error as Error).message });
      }

      // Cancel-cascade: detached children never see a collect, and their
      // parent AbortSignal is already aborted (this.abortController). We
      // clear the pending map so the Promise references drop and the
      // orphan reaper can flip any `running` rows to `cancelled`.
      this.abortController.abort((error as Error).message || 'parent failed');
      this.cancelAllDetached((error as Error).message || 'parent failed');

      const failDurationMs = Date.now() - this.startTime;
      const logFn = wasStopped ? agentLogger.info : agentLogger.error;
      logFn.call(agentLogger, {
        agentId: this.context.id, sessionId: this.context.sessionId,
        iteration: this.iteration, elapsedMs: failDurationMs,
        totalTokensUsed: this.totalTokensUsed,
        model: this.context.model, role: this.context.role,
        error: (error as Error).message,
      }, wasStopped ? 'Agent stopped' : 'Agent failed');

      // Audit log only for real failures — a stop is not a failure.
      if (!wasStopped) {
        auditRepository.logAgentFailed(
          this.context.userId, this.context.sessionId, this.context.id,
          { error: (error as Error).message, iteration: this.iteration, elapsedMs: failDurationMs, totalTokensUsed: this.totalTokensUsed, model: this.context.model, role: this.context.role },
        ).catch(err => agentLogger.error({ err, agentId: this.context.id }, 'Failed to persist agent failure audit'));
      }

      // Persist final state to DB
      agentRepository.updateStatus(this.context.id, {
        status: terminalStatus,
        iterations: this.iteration,
        totalTokens: this.totalTokensUsed,
        durationMs: failDurationMs,
        error: wasStopped ? undefined : (error as Error).message,
      }).catch(err => agentLogger.error({ err, agentId: this.context.id }, 'Failed to persist agent terminal status'));

      // Close any browser tabs the agent opened via browser-ext.new_tab
      import('@/tools/browser-ext').then(({ closeAgentTabs }) => {
        closeAgentTabs(this.context.id).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in agent-worker'));
      }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in agent-worker'));

      throw error;
    }
  }

  /**
   * Race a promise against the agent timeout.
   */
  private async raceTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
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
    // Clear the timer when the inner promise wins; otherwise every raceTimeout
    // call in the loop leaks a setTimeout that fires at the absolute deadline
    // and emits a duplicate "Agent timeout exceeded" log. With N iterations ×
    // M race sites this produces N×M identical errors in the same millisecond.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const msg = `Agent timeout exceeded (${Math.round(this.elapsed() / 1000)}s / ${Math.round(this.config.timeout / 1000)}s) during ${label}`;
        agentLogger.error({
          agentId: this.context.id, sessionId: this.context.sessionId,
          iteration: this.iteration, elapsedMs: this.elapsed(),
          phase: label, timeoutMs: this.config.timeout,
        }, msg);
        reject(new Error(msg));
      }, remaining);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async loop(): Promise<string> {
    while (this.iteration < this.config.maxIterations) {
      // Abort from parent (cascade) or explicit stop(). Swarm Phase 2: surface
      // as a structured `CascadedCancellationError` instead of a string.
      if (this.abortController.signal.aborted) {
        const reason = this.abortController.signal.reason;
        throw new CascadedCancellationError({
          agentId: this.context.id,
          reason: typeof reason === 'string' ? reason : reason?.message,
        });
      }

      this.iteration++;
      agentLogger.info({
        agentId: this.context.id, sessionId: this.context.sessionId,
        iteration: this.iteration, elapsedMs: this.elapsed(),
        role: this.context.role, model: this.context.model,
      }, 'Agent loop iteration');

      // ── Periodic nudge for uncollected detached children ────────────
      // If the LLM spawned detached subagents and keeps working for many
      // turns without calling collect_children, inject a reminder. Cheap
      // way to prevent the 22h-shell anti-pattern: agents forgetting the
      // side tasks they kicked off.
      if (this.pendingDetached.size > 0 && this.iteration > 0 && this.iteration % 5 === 0) {
        const list = [...this.pendingDetached.values()]
          .map((pc) => `${pc.childId} (topic: ${pc.topic}${pc.subtopic ? '/' + pc.subtopic : ''}, running ${Math.round((Date.now() - pc.startedAt) / 1000)}s)`)
          .join('; ');
        this.addSystemMessage(
          `Reminder: ${this.pendingDetached.size} detached subagent${this.pendingDetached.size > 1 ? 's are' : ' is'} still running — ${list}. ` +
            `Call \`collect_children\` before your final answer so you can synthesize with their results.`,
        );
      }

      // ── Pre-LLM-call budget enforcement (Swarm Phase 2) ─────────────
      // Per design §Budget Envelope: hard cap, fires abort, status='budget'.
      if (this.config.maxTokenBudget > 0 && this.totalTokensUsed >= this.config.maxTokenBudget) {
        this.abortController.abort(`budget_exceeded:${this.totalTokensUsed}/${this.config.maxTokenBudget}`);
        throw new BudgetExceededError({
          agentId: this.context.id,
          used: this.totalTokensUsed,
          cap: this.config.maxTokenBudget,
        });
      }

      // ── Per-user daily token quota (Phase 3c-2) ─────────────────────
      // Aggregate across this user's running + completed agents for the
      // current UTC day. Distinct from the per-agent maxTokenBudget
      // above: throws QuotaExceededError so callers can distinguish a
      // user-cap hit from an agent-cap hit. Only fires for a real userId
      // (not the 'system'/'local' sentinel).
      try {
        if (
          this.context.userId
          && this.context.userId !== 'system'
          && this.context.userId !== 'local'
        ) {
          const { getQuotaManager } = await import('@/security/quotas');
          // Pre-call check uses delta=0 — we're asking "would we
          // already be over before this LLM call?" The next call's
          // tokens are credited after the response by the post-call
          // bookkeeping; so this gate fires once you cross the line,
          // not preemptively.
          const check = await getQuotaManager().willExceed(this.context.userId, 'tokensPerDay', 0);
          if (!check.allowed) {
            this.abortController.abort(`user_quota_exceeded:tokensPerDay`);
            const { QuotaExceededError } = await import('@/security/quota-error');
            throw new QuotaExceededError({ ...check.reason, userId: this.context.userId });
          }
        }
      } catch (err) {
        // Don't swallow QuotaExceededError — re-throw it.
        if (err instanceof Error && err.name === 'QuotaExceededError') throw err;
        // Any other error inside the quota check (DB hiccup) is logged
        // but doesn't abort the agent — the per-agent budget above is
        // the existing safety net.
      }

      // Wall-clock cap — skip if a final/delegation tool already completed
      // (tools are disabled after delegation; we just need one more LLM call for the summary).
      if (this.config.timeout > 0 && this.elapsed() > this.config.timeout && !this.toolExecutor.toolsDisabled) {
        this.abortController.abort(`timeout:${this.elapsed()}ms`);
        throw new ChildTimeoutError({
          agentId: this.context.id,
          elapsedMs: this.elapsed(),
          capMs: this.config.timeout,
        });
      }

      // Incremental tool-output compaction: once there are more than the soft
      // cap of tool results in context, truncate the OLDEST ones (recent ones
      // stay full). Cheaper + less destructive than whole-history compaction
      // and triggers earlier, so context-overflow errors are rarer. Lives next
      // to the token-threshold proactive path below so both run together.
      // Effective cap: per-worker config wins, else the runtime `agent` config
      // knob (config schema field), else the hardcoded default. This makes the
      // soft cap tunable via config without editing agent construction sites.
      const effectiveSoftCap =
        this.config.toolOutputSoftCap ?? getConfig().agent?.toolOutputSoftCap ?? DEFAULT_TOOL_OUTPUT_SOFT_CAP;
      const { messages: toolCompacted, truncated: toolOutputsTruncated } = truncateOldestToolOutputs(
        this.messages,
        { softCap: effectiveSoftCap },
      );
      if (toolOutputsTruncated > 0) {
        this.messages = toolCompacted;
        agentLogger.info({
          agentId: this.context.id, iteration: this.iteration,
          toolOutputsTruncated, messageCount: this.messages.length,
        }, 'Incremental tool-output compaction (soft cap)');
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
          userId: this.context.userId,
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
        userId: this.context.userId,
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

        // Connection failures to upstream model providers (DNS, refused, unreachable host)
        // are not transient — they indicate a dead container or misconfigured endpoint.
        // Surface to the user immediately so they can react (start container, change model)
        // instead of spinning through 14s of retries that will all fail the same way.
        const isConnectionError = errMsg.includes('APIConnectionError')
          || errMsg.includes('Cannot connect to host')
          || errMsg.includes('ECONNREFUSED')
          || errMsg.includes('Name or service not known')
          || errMsg.includes('ENOTFOUND')
          || errMsg.includes('getaddrinfo');
        if (isConnectionError) {
          this.emit('error', {
            error: `Model "${this.context.model}" unreachable: ${errMsg}`,
            recoverable: false,
          });
          throw err;
        }

        // Handle context window overflow — aggressively compact and retry
        if (errMsg.includes('ContextWindowExceeded') || errMsg.includes('context_length_exceeded') || errMsg.includes('maximum context length')) {
          agentLogger.warn({
            agentId: this.context.id, iteration: this.iteration,
            messageCount: this.messages.length,
          }, 'Context window exceeded, compacting aggressively and retrying');

          for (const msg of this.messages) {
            if (msg.role === 'tool' && msg.content.length > 2000) {
              msg.content = msg.content.slice(0, 2000) + CONTEXT_OVERFLOW_TRUNCATED_MARKER;
            }
          }

          const { messages: compacted } = await compactMessagesWithSummary(this.messages, {
            maxTokens: Math.floor(this.config.contextWindowSize * 0.5),
            preserveSystemMessages: true,
            preserveRecentCount: 6,
            summaryModel: this.context.model,
            userId: this.context.userId,
          });
          this.messages = compacted;
          continue;
        }

        // Retry transient LLM failures (JSON parse, rate limit, server errors).
        // ClassifiedError already encodes recoverability — trust it first so
        // wrapped malformed-tool-call errors (e.g. Ollama's "Value looks like
        // object, but can't find closing '}' symbol") are retried instead of
        // surfacing as raw JSON to the user.
        const isTransient = (err instanceof ClassifiedError && err.isRetryable)
          || errMsg.includes('JSON') || errMsg.includes('parse')
          || errMsg.includes('Unterminated') || errMsg.includes('500')
          || errMsg.includes('502') || errMsg.includes('503')
          || errMsg.includes('rate_limit') || errMsg.includes('overloaded')
          || /Value looks like object|find closing '\}' symbol/.test(errMsg);

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
        // Recover near-miss tool names (bare sub-name / typo) up front so every
        // downstream read — loop-detection signatures, logs, the tool_call
        // events, and the toolId lookup — reflects the tool that will actually
        // run, not the model's mistyped name.
        this.toolExecutor.normalizeToolCallNames(completion.toolCalls);
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
            // Pair the dangling assistant tool_calls with synthetic tool
            // responses so persisted/replayed history stays OpenAI-spec valid
            // (DeepSeek 400's otherwise on 'insufficient tool messages').
            this.appendSyntheticToolResults(completion.toolCalls, '[intercepted: treated as final response]');
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
            // Close out the dangling assistant tool_calls with synthetic tool
            // responses — strict providers (DeepSeek) 400 on orphan tool_calls.
            this.appendSyntheticToolResults(completion.toolCalls, '[loop detected: tools not executed]');
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

        // Detect same-tool-name spam (different args each time, same name).
        // Catches chatty LLMs that spin on send_status_update with varying
        // messages — the per-signature loop above misses them because args
        // differ every call.
        const toolNameSignature = [...completion.toolCalls].map(tc => tc.name).sort().join(',');
        // Skip the guard entirely when every tool call this iteration is
        // productive work (orchestrator meta-tools, filesystem/shell/git/web/
        // code namespaces). Reading 8 files in sequence then writing 5 is a
        // designer/coder doing their job — the guard is meant for notification
        // spam (send_status_update with slightly varying progress text), not
        // genuine file I/O bursts.
        const callsAllowList = completion.toolCalls.every(tc =>
          AgentWorker.REPEAT_ALLOWED_TOOLS.has(tc.name)
          || AgentWorker.REPEAT_ALLOWED_PREFIXES.some(p => tc.name.startsWith(p)),
        );
        if (!callsAllowList && toolNameSignature === this.lastToolNames) {
          this.consecutiveSameNameCount++;
          if (this.consecutiveSameNameCount >= AgentWorker.MAX_SAME_NAME_REPEATS) {
            agentLogger.warn({
              agentId: this.context.id, toolNames: toolNameSignature,
              repeats: this.consecutiveSameNameCount,
            }, 'Same tool name called repeatedly — disabling tools, forcing plain-text reply');
            this.toolExecutor.disableTools();
            // Close out the dangling assistant tool_calls with synthetic tool
            // responses — strict providers (DeepSeek) 400 on orphan tool_calls.
            this.appendSyntheticToolResults(completion.toolCalls, '[spam detected: tools disabled]');
            this.messages.push({
              role: 'user' as const,
              content:
                `[SYSTEM] You have called \`${toolNameSignature}\` multiple times. ` +
                `Tools are now disabled. Respond to the user with plain text using the information you already have.`,
              timestamp: new Date(),
            });
            continue;
          }
        } else {
          this.lastToolNames = toolNameSignature;
          this.consecutiveSameNameCount = 1;
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
        // Final/delegation tools (spawn_child, create_pipeline) manage their own timeouts.
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

        // Drain steering queue before next LLM call
        this.drainSteeringQueue();
        continue;
      }

      // Some models (e.g. Gemma4 via LiteLLM) emit tool calls as JSON text instead of structured tool_calls.
      // Detect and parse these so they execute properly.
      if (completion.content && !completion.toolCalls?.length) {
        const textToolCalls = this.parseTextToolCalls(completion.content);
        if (textToolCalls.length > 0) {
          await this.executeRecoveredToolCalls(textToolCalls, 'text output');
          continue;
        }

        // Toolshim — last resort: ask a bound translator model to convert the
        // prose into a tool call. Only after the cheap text/JSON/XML fallbacks
        // above failed; gated + capped once per iteration inside tryToolShim.
        const shimToolCalls = await this.tryToolShim(completion.content);
        if (shimToolCalls && shimToolCalls.length > 0) {
          await this.executeRecoveredToolCalls(shimToolCalls, 'toolshim');
          continue;
        }
      }

      // Tool-bailout detection: doer roles (coding/design/devops/etc) that
      // emit no tool calls but dump file contents as inline markdown have
      // almost always given up on tool use mid-task. Common DeepSeek pattern
      // after a single ENOENT or transient tool error: model decides tools
      // are "unavailable" and writes everything as text. Pipeline then marks
      // the stage completed even though nothing was actually written to
      // disk. Nudge once with an explicit "tools ARE working" message;
      // accept the text reply only if the model refuses a second time.
      if (this.shouldRetryToolBailout(completion.content)) {
        this.toolBailoutRetries++;
        if (this.toolBailoutRetries <= 1) {
          agentLogger.warn({
            agentId: this.context.id, role: this.context.role,
            contentLength: completion.content?.length ?? 0,
          }, 'Tool-bailout detected — nudging agent to actually call tools');
          this.messages.push({
            role: 'user' as const,
            content:
              '[SYSTEM] You appear to have stopped calling tools mid-task. ' +
              'No rate limit, sandbox, or filter is blocking your tool calls — those constraints do not exist in this environment. ' +
              'A single tool error earlier (ENOENT, metacharacter rejection on a shell heredoc, etc.) does NOT mean tools are disabled. ' +
              'Use `filesystem__write_file` to write files directly with absolute paths — do NOT fall back to `cat << EOF` heredocs (those need `useShell: true` and are rejected for safety). ' +
              'Resume the work: call the tools needed to actually create the files you described.',
            timestamp: new Date(),
          });
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

      // A steer may have arrived while this (final, no-tool) iteration was
      // producing text — the mid-iteration drains only run after tool calls.
      // Honor it instead of returning so a late mid-run user message is never
      // silently dropped. steer() granted the extra iteration this `continue`
      // needs.
      if (this.steeringQueue.length > 0) {
        agentLogger.info({ agentId: this.context.id }, 'Draining steer before finalizing — continuing loop');
        this.drainSteeringQueue();
        continue;
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
   * Heuristic: did the model "give up" on tools and dump file contents as
   * inline text instead of using filesystem__write_file? Fires for doer
   * roles when the reply looks like a multi-file dump *and* the model
   * either claimed tools were unavailable or used clear "providing inline"
   * phrasing. Conservative on purpose — false positives waste one LLM call
   * each, false negatives lose the entire stage's output.
   */
  private shouldRetryToolBailout(content?: string): boolean {
    if (!content) return false;
    if (this.toolExecutor.toolsDisabled) return false;
    // Only roles that actually WRITE files. qa/writing/data legitimately
    // produce long markdown reports with code blocks as their deliverable
    // and would false-positive on the inline-dump branch.
    const FILE_WRITING_ROLES = new Set(['coding', 'design', 'devops']);
    if (!FILE_WRITING_ROLES.has(this.context.role as string)) return false;

    // Short-form bailout: model announces it stopped, no tool calls.
    // Length-gated branches below skip these, so catch them up front.
    const SHORT_BAILOUT_PHRASES = [
      /^\s*I(?:'|'?ll)?\s+stop\s+here\.?\s*$/i,
      /^\s*Done\.?\s*$/i,
      /^\s*(?:Read[-\s]?only|read[-\s]?only\s+confirmed)\.?\s*$/i,
    ];
    if (SHORT_BAILOUT_PHRASES.some(rx => rx.test(content))) return true;

    if (content.length < 80) return false;

    // Inline-dump phrases — model decided to write everything as text
    // instead of using tools. Needs corroborating code-block dump.
    const INLINE_DUMP_PHRASES = [
      /tools?\s+(?:are|were)\s+(?:temporarily\s+)?(?:unavailable|disabled|down|broken)/i,
      /(?:since|because|as)\s+(?:I\s+)?(?:can(?:no|')t|am\s+unable\s+to)\s+(?:use\s+tools|write|access|create)/i,
      /(?:I'?ll|let\s+me)\s+provide\s+(?:the\s+)?(?:complete|full)?\s*(?:implementation|code|solution|files?)\s+(?:below|inline|as\s+text|as\s+structured\s+code|in\s+this\s+(?:reply|response|message))/i,
      /provid(?:e|ing)\s+(?:the\s+)?(?:code|files?)\s+(?:as\s+structured\s+code|inline|below|in\s+this\s+response)/i,
      /unable\s+to\s+(?:write|create|save)\s+files?/i,
      // Grok "tools disabled / re-enabled" framing — saw in audit log where
      // Grok wrapped up with "(Read-Only Confirmed) Continue ... once tools
      // are re-enabled" instead of doing the work. Pipeline accepted it.
      /once\s+tools?\s+(?:are\s+)?re[-\s]?enabled/i,
      /\bread[-\s]?only\s+confirmed\b/i,
    ];

    // Excuse-and-give-up patterns — model hallucinates a constraint that
    // doesn't exist. Saw DeepSeek invent "rate-limited on shell calls",
    // "tool is sandboxed", "blocked by the metacharacter filter".
    const EXCUSE_PHRASES = [
      /(?:I\s+(?:was|am)|got)\s+rate[-\s]?limited/i,
      /(?:tool|filesystem|shell)\s+(?:is|was)\s+sandboxed/i,
      /blocked\s+by\s+the\s+metacharacter\s+filter/i,
    ];

    const fenceCount = (content.match(/```/g) || []).length;
    const filePathHeadingCount = (content.match(/^#{2,4}\s+`[^`\n]*\/[^`\n]+`/gm) || []).length;

    if (EXCUSE_PHRASES.some(rx => rx.test(content))) return true;
    if (INLINE_DUMP_PHRASES.some(rx => rx.test(content)) && fenceCount >= 2) return true;
    // Implicit bailout: file-writing role dumping ≥2 file headings + ≥4 fences with no tool calls.
    if (filePathHeadingCount >= 2 && fenceCount >= 4) return true;

    return false;
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

    // XML-style tool calls: <tool_call><function=tool_name><parameter=key>value</parameter>...</function></tool_call>
    // Some models (e.g. OpenRouter free models) emit this format
    if (results.length === 0) {
      const xmlPattern = /<(?:tool_call|function_call)>\s*<function=([^>]+)>([\s\S]*?)<\/function>\s*<\/(?:tool_call|function_call)>/g;
      let xmlMatch;
      while ((xmlMatch = xmlPattern.exec(content)) !== null) {
        const toolName = xmlMatch[1].trim();
        const paramBlock = xmlMatch[2];

        if (!registeredTools.has(toolName)) continue;

        const args: Record<string, unknown> = {};
        const paramPattern = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
        let paramMatch;
        while ((paramMatch = paramPattern.exec(paramBlock)) !== null) {
          const key = paramMatch[1].trim();
          const value = paramMatch[2].trim();
          // Try to parse as JSON, fall back to string
          try { args[key] = JSON.parse(value); } catch { args[key] = value; }
        }

        results.push({
          id: `call_xml_${Date.now()}_${results.length}`,
          name: toolName,
          arguments: args,
        });
      }
    }

    return results;
  }

  /**
   * Tool handlers advertised to the model this turn. Lazy mode (set by the
   * spawner) trims long-tail handlers from the advertised schema array; they
   * stay registered and callable by name. `full` (the default) is unchanged.
   * Shared by the completion call and toolshim so both see the same tool set.
   */
  private getAdvertisedToolHandlers(): ToolHandler[] {
    const advertisement = this.config.toolAdvertisement ?? { mode: 'full' };
    const registeredTools = Array.from(this.toolExecutor.getTools().values());
    return advertisement.mode === 'lazy'
      ? registeredTools.filter((tool) => !isLongTailHandler(tool, advertisement.coreToolIds))
      : registeredTools;
  }

  /**
   * Last-resort, model-based recovery of a tool call from prose. Only runs when
   * the cheap text→toolcall fallbacks failed. Guarded hard: at most once per
   * iteration, only when tools are enabled + advertised, and only when the
   * `tool_translation` topic is bound (unbound ⇒ fail-soft to today's
   * behaviour). Returns the translated calls, or null to fall through to plain
   * text. See `src/models/toolshim.ts`.
   */
  private async tryToolShim(prose: string): Promise<ToolCall[] | null> {
    if (this.toolShimAttemptedIteration === this.iteration) return null;
    if (this.toolExecutor.toolsDisabled) return null;
    const advertised = this.getAdvertisedToolHandlers();
    if (advertised.length === 0) return null;
    // Mark attempted up front: a thrown/failed translator call must still count
    // against the once-per-iteration cap (no retry storm on the failure path).
    this.toolShimAttemptedIteration = this.iteration;

    const model = await getModelRegistry().getModelForTopic('tool_translation');
    if (!model) {
      if (!this.toolShimUnboundLogged) {
        this.toolShimUnboundLogged = true;
        agentLogger.debug(
          { agentId: this.context.id },
          'Toolshim skipped: tool_translation topic unbound',
        );
      }
      return null;
    }

    const tools: ToolShimSchema[] = advertised.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    // Validate against the ADVERTISED set (what the translator was shown), not
    // the full registry — so a coincidental long-tail name match can't slip a
    // tool through that the translator never saw a schema for.
    const advertisedNames = new Set(advertised.map((t) => t.name));

    const toolCall = await translateToToolCall({
      text: prose,
      tools,
      isRegistered: (name) => advertisedNames.has(name),
      complete: (prompt) => this.runToolTranslator(model, prompt),
    });
    if (!toolCall) return null;

    agentLogger.info(
      { agentId: this.context.id, iteration: this.iteration, tool: toolCall.name, translator: model.modelId },
      'Toolshim translated prose into a tool call',
    );
    return [toolCall];
  }

  /**
   * One-shot completion against the bound translator model — no tools, no
   * history, deterministic. Returns the raw assistant content. Mirrors
   * getCompletion's provider routing + vault key resolution.
   */
  private async runToolTranslator(model: ModelConfigEntry, prompt: string): Promise<string> {
    const messages: AgentMessage[] = [{ role: 'user', content: prompt, timestamp: new Date() }];

    let apiKey: string | undefined;
    if (model.apiKeyRef) {
      try {
        const { getVault } = await import('@/security/vault');
        apiKey = (await getVault().getByName('system', model.apiKeyRef)) || undefined;
      } catch (err) {
        coreLogger.error({ err }, 'toolshim: vault key lookup failed');
      }
    }

    const completionOpts = {
      model: model.modelId,
      messages,
      temperature: 0,
      maxTokens: model.defaultMaxTokens || 1024,
      endpoint: model.endpoint || undefined,
      apiKey,
      userId: this.context.userId,
    };

    let result: CompletionResult;
    if (model.provider && model.provider !== 'litellm') {
      const { getProviderRouter } = await import('@/models/providers');
      const directProvider = getProviderRouter().getProviderByName(model.provider);
      result = directProvider
        ? await directProvider.complete(completionOpts)
        : await getLiteLLMClient().complete(completionOpts);
    } else {
      result = await getLiteLLMClient().complete(completionOpts);
    }

    await getCostTracker().logUsageWithCost(
      this.context.userId,
      model.modelId,
      result.usage.inputTokens,
      result.usage.outputTokens,
      { sessionId: this.context.sessionId, agentId: this.context.id, requestType: 'chat', metadata: { toolshim: true, iteration: this.iteration } },
    );

    return result.content;
  }

  /**
   * Execute tool calls recovered from text (parseTextToolCalls) or toolshim —
   * push the synthetic assistant message, emit the action, run the tools, and
   * drain the steer queue. Shared so both recovery paths behave identically.
   */
  private async executeRecoveredToolCalls(toolCalls: ToolCall[], source: string): Promise<void> {
    // Normalize near-miss names before the persisted assistant message + emit,
    // same coherence requirement as the structured path.
    this.toolExecutor.normalizeToolCallNames(toolCalls);
    agentLogger.info(
      { agentId: this.context.id, iteration: this.iteration, tools: toolCalls.map((tc) => tc.name), source },
      'Recovered tool calls',
    );

    this.messages.push({ role: 'assistant', content: '', toolCalls, timestamp: new Date() });

    this.emit('action', {
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        argsSummary: JSON.stringify(tc.arguments).slice(0, 80),
      })),
    });

    const isFinalTool = this.toolExecutor.hasFinalToolCall(toolCalls);
    const toolMessages = isFinalTool
      ? await this.toolExecutor.handleToolCalls(toolCalls)
      : await this.raceTimeout(this.toolExecutor.handleToolCalls(toolCalls), 'handleToolCalls');
    this.messages.push(...toolMessages);

    this.drainSteeringQueue();
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
    const advertisedTools = this.getAdvertisedToolHandlers();
    const tools: ChatCompletionTool[] = this.toolExecutor.toolsDisabled
      ? []
      : advertisedTools.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));

    this.emit('thought', { model: litellmModel, messageCount: this.messages.length });

    const metadata = model.metadata as import('@/db/schema/models').ModelMetadata | null;

    // Respect the model's configured extraBody (e.g. think:false) — except when
    // we're an agent worker emitting tool calls. Empirically (2026-05-12 QA),
    // Ollama models with `think:false` produce malformed tool-call JSON that
    // Ollama's Go-side parser rejects ("Value looks like object, but can't find
    // closing '}'"). With thinking ON, the same models emit valid tool calls.
    // Thinking output is stripped by the LLM client before delivery (see
    // litellm-client.ts), so users never see the reasoning tokens — the only
    // observable effect is reliable tool calls.
    //
    // Casual chat (direct-response.ts) preserves the model's think setting
    // because there are no tool calls to corrupt.
    let extraBody = metadata?.extraBody && Object.keys(metadata.extraBody).length > 0
      ? { ...metadata.extraBody }
      : undefined;

    if (extraBody && 'think' in extraBody) {
      delete extraBody.think;
      if (Object.keys(extraBody).length === 0) extraBody = undefined;
    }

    // Resolve API key from vault for custom/direct providers
    let apiKey: string | undefined;
    if (model.apiKeyRef) {
      try {
        const { getVault } = await import('@/security/vault');
        apiKey = await getVault().getByName('system', model.apiKeyRef) || undefined;
      } catch (err) { coreLogger.error({ err }, 'silent failure in agent-worker'); }
    }

    // Per-topic overrides (W10) take precedence over the model's own defaults
    // when set on the Topics page — applied here so they reach the LLM call.
    const completionOpts = applyTopicParamOverrides(
      {
        model: litellmModel,
        messages: this.messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: model.defaultTemperature || 0.7,
        maxTokens: model.defaultMaxTokens || model.maxTokens || 4096,
        extraBody,
        endpoint: model.endpoint || undefined,
        apiKey,
        userId: this.context.userId,
      },
      getTopicConfig(this.context.topic),
    );

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

    const octiMessage: AgentMessage = {
      role: 'assistant',
      content: result.content,
      toolCalls: result.toolCalls,
      timestamp: new Date(),
      ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}),
      ...(result.providerRaw ? { providerRaw: result.providerRaw } : {}),
    };
    this.messages.push(octiMessage);

    return result;
  }

  /**
   * Append synthetic `tool` messages for a set of tool_calls. Used when we
   * intercept/abandon an assistant tool-call round without actually executing
   * the tools (loop detection, hallucinated respond tools, transient LLM
   * errors). Without these the conversation has an assistant message with
   * `tool_calls` not followed by matching `tool` responses — OpenAI spec
   * requires the pairing, and strict providers (DeepSeek) return 400
   * "insufficient tool messages following tool_calls message".
   */
  private appendSyntheticToolResults(toolCalls: { id: string; name: string }[], note: string): void {
    for (const tc of toolCalls) {
      this.messages.push({
        role: 'tool',
        content: note,
        toolCallId: tc.id,
        name: tc.name,
        timestamp: new Date(),
      });
    }
  }

  /** Drain the steering queue into the message context. */
  private drainSteeringQueue(): void {
    if (this.steeringQueue.length > 0) {
      for (const msg of this.steeringQueue) {
        this.messages.push(msg);
      }
      agentLogger.debug({
        agentId: this.context.id,
        count: this.steeringQueue.length,
      }, 'Steering messages injected');
      this.steeringQueue = [];
    }
  }

  stop(): void {
    this.abortController.abort();
    if (this.parentSignalCleanup) {
      this.parentSignalCleanup();
      this.parentSignalCleanup = null;
    }
    this.context.status = 'stopped';
    this.context.completedAt = new Date();
    this.emit('status_change', { status: 'stopped' });
    agentLogger.info({ agentId: this.context.id }, 'Agent stopped');
  }
}
