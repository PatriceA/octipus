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
import { type ToolShimSchema, proseShowsToolIntent, translateToToolCall } from '@/models/toolshim';
import { applyTopicParamOverrides, getTopicConfig } from '@/models/topic-config';
import { getConfig } from '@/config';
import type { ModelConfigEntry } from '@/db/schema/models';
import { compactMessagesWithSummary, CONTEXT_OVERFLOW_TRUNCATED_MARKER, DEFAULT_TOOL_OUTPUT_SOFT_CAP, truncateOldestToolOutputs } from '@/utils/context-compaction';
import { agentLogger, coreLogger } from '@/utils/logger';
import { BaseAgentWorker } from './agent-base';
import type { ToolHandler } from './agent-base';
import { recordModelToolCall } from './agent/model-capability';
import { ensureChildRelay } from './agent/output-guard';
import { isLongTailHandler } from './agent/tool-split';
import { ClassifiedError, isFatalConnectionError, isTransientDnsError } from './errors/classification';
import { formatCollectedResults } from './swarm/collect-tool';
import {
  BudgetExceededError,
  CascadedCancellationError,
  ChildTimeoutError,
  DriftDetectedError,
} from './swarm/errors';
import type { ChildResult, PendingChild } from './swarm/types';
import { getPermissionManager } from '@/security/permissions';
import { ToolExecutor } from './tool-executor';
import { DetachedChildManager } from './agent-worker/detached-child-manager';
import { DriftDetector } from './agent-worker/drift-detector';
import { ToolLoopDetector } from './agent-worker/tool-loop-detector';
import { isRootAgent } from './types';
import type { AgentMessage, ToolCall } from './types';

// Re-export types for backward compatibility
export type { AgentEvent, AgentEventHandler, AgentWorkerConfig, ToolHandler } from './agent-base';

/**
 * Absolute backstop for a self-timed tool wait (RC5 D5). Generous by design —
 * 2h is far above any legitimate `collect_children`/pipeline duration, so it
 * only trips on a wedged wait that never resolves, never on real long work.
 */
export const DEFAULT_SELF_TIMED_TOOL_CEILING_MS = 2 * 60 * 60_000;

/**
 * Ceiling for the toolshim translator call. It is a one-shot prose→JSON
 * translation with no history and no tools; anything slower than this is a
 * stuck provider, and the caller fail-softs to "no tool call" anyway.
 */
export const TOOLSHIM_TIMEOUT_MS = 30_000;

/**
 * Ceiling for the two LLM calls that deliberately skip the wall race:
 * `finalizeGracefully`'s no-tools summary turn (reached only when the wall or
 * iteration budget is ALREADY spent, so `raceTimeout` would reject instantly)
 * and the post-delegation turn (`toolsDisabled`, where elapsed() likewise
 * includes a child's work). Skipping the *wall* race is right; skipping every
 * bound is not — an unbounded call there lets a stuck or cold provider hold a
 * worker open indefinitely after its budget is gone. Generous, since these are
 * real answer-producing turns; it only fires on a wedge.
 */
export const DEFAULT_UNRACED_TURN_CEILING_MS = 5 * 60_000;

/**
 * How often a blocked worker says what it is waiting for. This is a REPORTING
 * interval, never a deadline — nothing is cancelled when it fires. Long enough
 * that a normal tool call stays silent, short enough that a human watching a
 * quiet screen learns the cause well before they conclude it has hung.
 */
export const BLOCKED_PROGRESS_INTERVAL_MS = 20_000;

/**
 * Whether the conversation so far REFERENCES tools — an assistant turn that
 * called one, or a `tool` result answering it.
 *
 * Once it does, the request may never be sent without the tool definitions,
 * even on a turn where tools are disabled: the blocks name tools the request
 * would no longer declare. Anthropic-family providers reject that outright
 * ("The toolConfig field must be defined when using toolUse and toolResult
 * content blocks"). Two shapes count, because both appear in `this.messages` —
 * the result message and the call that produced it (a compacted history can
 * retain either one alone).
 */
export function historyReferencesTools(
  messages: Array<{ role: string; toolCalls?: unknown }>,
): boolean {
  return messages.some(
    (m) => m.role === 'tool' || (Array.isArray(m.toolCalls) && m.toolCalls.length > 0),
  );
}

/**
 * Human-readable answer to "what is it waiting for?" for a batch of tool calls.
 * The three states the user currently cannot tell apart are exactly the three
 * branches here: a human's approval, a child's work, and an ordinary long tool.
 */
export function blockedReason(
  toolCalls: Array<{ name: string }>,
  isFinal: boolean,
  isCollect: boolean,
): string {
  if (isFinal) return 'awaiting your approval';
  if (isCollect) return 'waiting for spawned children to finish';
  const names = [...new Set(toolCalls.map((tc) => tc.name))];
  return names.length === 1 ? `running ${names[0]}` : `running ${names.length} tools (${names.slice(0, 3).join(', ')})`;
}

/**
 * Start the "still waiting, here's why" heartbeat. Returns the stop function.
 *
 * Nothing here cancels anything — the wait is legitimate and a wall-clock
 * ceiling on it would kill real work (a human may take an hour to approve).
 * This is observability only, which is the actual defect being fixed.
 */
export function startBlockedHeartbeat(
  reason: string,
  emit: (payload: { type: 'blocked_progress'; reason: string; blockedForMs: number }) => void,
  intervalMs: number = BLOCKED_PROGRESS_INTERVAL_MS,
  now: () => number = Date.now,
): () => void {
  const since = now();
  const timer = setInterval(() => {
    emit({ type: 'blocked_progress', reason, blockedForMs: now() - since });
  }, intervalMs);
  // Never let a heartbeat hold the process open at shutdown.
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export class AgentWorker extends BaseAgentWorker {
  private toolExecutor: ToolExecutor;
  private abortController: AbortController;
  private totalTokensUsed: number = 0;
  private startTime: number = 0;
  /**
   * Heartbeat: wall-clock of the last loop iteration start. A healthy worker
   * bumps this every iteration; a genuinely wedged one stops. The orphan reaper
   * reads it (via getActivity) to tell a hung worker from one still progressing.
   */
  private lastActivityAt: number = 0;
  /**
   * Non-null while the worker is inside a legitimately-long blocking wait it
   * DOESN'T bump activity during — collect_children / detached auto-collect, or
   * a pipeline `final` tool awaiting human approval. The reaper must NOT kill a
   * worker in this state (it looks idle but is waiting on purpose).
   */
  private blockedSince: number | null = null;
  private emptyRetries: number = 0;
  private llmRetries: number = 0;
  /** Iteration index at which toolshim last ran — caps it to once per iteration. */
  private toolShimAttemptedIteration: number = -1;
  /** Log the unbound-translator skip only once per agent. */
  private toolShimUnboundLogged: boolean = false;
  /**
   * Set the first time this run's model emits tool calls NATIVELY. The toolshim
   * exists to reconstruct calls a model couldn't emit itself; a model that has
   * already emitted one in this run demonstrably can, so its later prose is a
   * real final answer, not a failed tool call. Without this gate the shim fired
   * on every text-only turn — i.e. on the normal, correct way to end a turn —
   * spending an extra LLM call per turn on the happy path (and, when the
   * `background` model is a cold local one, stalling the answer for as long as
   * that provider takes to load: one observed root agent sat 14 min between
   * its finished answer and delivery).
   */
  private sawNativeToolCall: boolean = false;
  /** Guards the terminal `complete` event so stop() and run() never double-fire it. */
  private terminalEmitted: boolean = false;
  /**
   * G1 escalation: set after a turn whose tool calls had to be recovered from
   * prose (text-parse/shim). Makes the NEXT model call request toolChoice
   * 'required' (one-shot), then resets — a small model that emitted prose once
   * gets forced to a structured call before we degrade further.
   */
  private forceToolChoiceNextTurn: boolean = false;
  /**
   * G5: one-shot native retry when a turn was truncated ('length') or the
   * provider reported a malformed function call — before falling back to
   * text-parse/toolshim. `lengthRetryBoost` bumps the next call's maxTokens so
   * thinking can't starve the tool call a second time.
   */
  private lengthRetried: boolean = false;
  /** Set when the FINAL turn was cut off by the token limit — see `wasTruncated`. */
  private finishedTruncated: boolean = false;
  private lengthRetryBoost: number = 0;
  /** Tool-call loop/spam detection (same-args + same-name state machines). */
  private loopDetector = new ToolLoopDetector();
  /** Seeded in `run()` from the brief; absent until then. */
  private driftDetector?: DriftDetector;
  /** Nudge queued by the drift check, appended once tool results close the turn. */
  private pendingDriftNudge?: string;
  /** Nudge queued by the redundant-call check, appended on the same schedule. */
  private pendingRedundantNudge?: string;

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
   * picked up via `collect_children` (or auto-collect). Delegated to the
   * DetachedChildManager; the public API below stays identical.
   */
  private detached = new DetachedChildManager(
    this.context.id,
    () => this.config.timeout,
    (ms) => this.addPausedMs(ms),
  );

  registerPendingChild(pc: PendingChild): void {
    this.detached.registerPendingChild(pc);
  }

  pendingDetachedCount(): number {
    return this.detached.count();
  }

  listPendingDetached(): PendingChild[] {
    return this.detached.list();
  }

  /** Mark a pending child as collected. Returns its result (awaiting if needed). */
  async collectDetached(childId: string, timeoutMs: number): Promise<ChildResult | null> {
    return this.detached.collect(childId, timeoutMs);
  }

  /** Collect every still-pending detached child. Used by collect_children and auto-collect. */
  async collectAllDetached(timeoutMs: number): Promise<ChildResult[]> {
    return this.detached.collectAll(timeoutMs);
  }

  /**
   * A pause that is still open — currently only "a human is looking at a
   * permission prompt". Counted from `elapsed()` while it runs, not just when
   * it ends: the wall race arms a timer at call time, so a credit that lands
   * afterwards would arrive after the turn was already killed.
   */
  private pauseStartedAt: number | null = null;

  /** Stop the wall clock. Idempotent — nested waits keep the earliest start. */
  private beginPause(): void {
    if (this.pauseStartedAt === null) this.pauseStartedAt = Date.now();
  }

  /** Resume the wall clock, banking the paused stretch. */
  private endPause(): void {
    if (this.pauseStartedAt === null) return;
    this.pausedMs += Date.now() - this.pauseStartedAt;
    this.pauseStartedAt = null;
  }

  /** Milliseconds of *active* work since agent start (excludes child-wait time). */
  private elapsed(): number {
    const openPause = this.pauseStartedAt === null ? 0 : Date.now() - this.pauseStartedAt;
    return Math.max(0, Date.now() - this.startTime - this.pausedMs - openPause);
  }

  /** Public elapsed time for status reporting (active only). */
  override getElapsedMs(): number {
    return this.startTime > 0 ? this.elapsed() : 0;
  }

  /**
   * Liveness snapshot for the orphan reaper. `lastActivityAt` is the last loop
   * iteration start; `blockedSince` is non-null while the worker sits in a
   * legitimately-long blocking wait (approval / collect). The reaper treats a
   * blocked worker as alive, and a non-blocked worker with a stale
   * `lastActivityAt` as wedged.
   */
  getActivity(): { lastActivityAt: number; blockedSince: number | null } {
    return { lastActivityAt: this.lastActivityAt, blockedSince: this.blockedSince };
  }

  /**
   * Run a legitimately-long blocking wait while marking the worker `blocked` so
   * the reaper won't mistake the idle-looking wait for a wedge. Cleared in
   * `finally` even on throw. Nested waits keep the earliest `blockedSince`.
   *
   * `reason` names WHAT is being waited on ("collect_children (3 pending)",
   * "awaiting approval"). While blocked, a heartbeat emits it every
   * `BLOCKED_PROGRESS_INTERVAL_MS` — see `emitBlockedProgress`. Every
   * legitimately-long wait already funnels through here, so this is the one
   * place that has to know, and a new blocking region gets the heartbeat by
   * construction (docs/plans/blocked-vs-stuck.md Phase 1).
   */
  private async whileBlocked<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    const already = this.blockedSince !== null;
    if (already) return fn();

    this.blockedSince = Date.now();
    // A silent wait is indistinguishable from a hang from outside — that IS the
    // defect. Say what we are waiting for, and for how long.
    const stopHeartbeat = startBlockedHeartbeat(reason, (payload) => this.emit('thought', payload));
    try {
      return await fn();
    } finally {
      stopHeartbeat();
      this.blockedSince = null;
    }
  }

  /** Optional parent AbortSignal — chained so that parent abort cascades down. */
  private parentSignalCleanup: (() => void) | null = null;
  /** Unsubscribe from permission wait-state events. */
  private permissionWaitCleanup: (() => void) | null = null;

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

    // A permission prompt stops this worker's wall clock. Both approval paths
    // (tool-executor and base-tool) register their wait with the permission
    // manager, so subscribing here covers both without either knowing about
    // the worker.
    try {
      this.permissionWaitCleanup = getPermissionManager().onWaitStateChange(
        (agentId: string, waiting: boolean) => {
          if (agentId !== this.context.id) return;
          if (waiting) this.beginPause();
          else this.endPause();
        },
      );
    } catch { /* permission manager unavailable (tests / early boot) */ }

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

  /**
   * Rough token estimate of the current request (≈ chars / 4). Used ONLY as a
   * fallback when the provider reports 0/absent usage — CLI providers report
   * `{tokens: 0}` on purpose and Ollama's `eval_count` ignores image-input
   * tokens (RC5 D1) — and by the pre-flight (D2). Without it the budget cap is
   * a permanent no-op for those models.
   *
   * Image handling matters: a base64 blob dumped into a STRING content (what a
   * text model receives — the run-743d4b66 373 KB screenshot) is counted at its
   * full encoded length, so it correctly trips the cap. But a structured
   * `image_url` part sent to a VISION model costs only ~fixed tokens, not its
   * base64 length — counting it by length would false-abort a legitimate vision
   * agent the moment an image enters context. So image parts get a fixed cost.
   *
   * Deliberately a slight over-estimate otherwise: a budget cap must fail safe
   * toward stopping, never toward running forever.
   */
  private estimateRequestTokens(): number {
    const IMAGE_TOKENS = 1_500; // rough fixed cost of one image to a vision model
    let chars = 0;
    let imageTokens = 0;
    for (const m of this.messages) {
      const c = (m as { content?: unknown }).content;
      if (typeof c === 'string') {
        chars += c.length;
      } else if (Array.isArray(c)) {
        for (const part of c as Array<{ type?: string; text?: string }>) {
          if (part?.type === 'image_url' || part?.type === 'image') {
            imageTokens += IMAGE_TOKENS;
          } else if (typeof part?.text === 'string') {
            chars += part.text.length;
          } else if (part) {
            chars += JSON.stringify(part).length;
          }
        }
      } else if (c) {
        chars += JSON.stringify(c).length;
      }
    }
    return Math.ceil(chars / 4) + imageTokens;
  }

  /**
   * Tokens to charge for a completion: the provider's reported count, or the
   * request estimate when it reports 0/absent (CLI / image-blind Ollama). One
   * source so budget accounting AND session/cost accounting agree (RC5 D1).
   */
  private accountedTokens(completion: CompletionResult): number {
    return completion.usage.totalTokens > 0
      ? completion.usage.totalTokens
      : this.estimateRequestTokens();
  }

  /**
   * Deterministic side-effect counters for this worker's run, sourced from
   * the tool executor. The swarm spawner reads these to build a
   * `SwarmReceipt`. Overrides the base default (`null`) — CLI workers own no
   * executor and keep the null.
   */
  /** True when this run's final answer was a fragment of a cut-off turn. */
  override wasTruncated(): boolean {
    return this.finishedTruncated;
  }

  override getSideEffectCounters(): import('./swarm/receipt').SideEffectCounters {
    return this.toolExecutor.getSideEffectCounters();
  }

  registerTool(tool: import('./agent-base').ToolHandler): void {
    this.toolExecutor.registerTool(tool);
  }

  registerTools(tools: import('./agent-base').ToolHandler[]): void {
    this.toolExecutor.registerTools(tools);
  }

  async loadHistory(): Promise<void> {
    // Root agents and task-specific workers are ephemeral — they receive their
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

    // Only persist for the root agent
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

  async run(userMessage?: string): Promise<string> {
    if (userMessage) {
      await this.addUserMessage(userMessage);
    }

    // Snapshot the brief for drift detection NOW, while it is still intact.
    // It must not be re-read from `this.messages` later: the brief is a `user`
    // message, compaction pins only `system` messages, so it is evictable — and
    // that eviction is precisely what let run 743d4b66 forget its task. A
    // detector reading from there would go blind exactly when it matters.
    //
    // The ROOT agent is exempt. Its work is delegation and polling, so its
    // tool vocabulary (spawn_child, collect_children) legitimately shares
    // nothing with the user's wording, and a false abort there is uniquely
    // destructive: `run()`'s catch cascade-cancels every pending detached
    // child, killing the work it was waiting to collect. Drift is a worker
    // failure mode; this guard belongs on workers.
    if (!isRootAgent(this.context)) {
      const originalRequest = (this.context.metadata as Record<string, unknown> | undefined)?.originalRequest;
      this.driftDetector = new DriftDetector(
        [userMessage ?? '', typeof originalRequest === 'string' ? originalRequest : ''].join(' '),
      );
    }

    this.context.status = 'running';
    this.startTime = Date.now();
    this.lastActivityAt = this.startTime; // a started worker is active until proven stale (reaper heartbeat)
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
      if (this.detached.count() > 0) {
        const autoTimeoutMs = this.detached.computeAutoCollectTimeoutMs();
        agentLogger.warn(
          { agentId: this.context.id, pending: this.detached.count(), autoTimeoutMs },
          'Auto-collecting forgotten detached children before finalizing',
        );
        const collected = await this.whileBlocked(
          `auto-collecting ${this.detached.count()} detached ${this.detached.count() === 1 ? 'child' : 'children'}`,
          () => this.collectAllDetached(autoTimeoutMs),
        );
        if (collected.length > 0) {
          // P1.2 — give each child a real relay budget instead of a 500-char
          // stub (which turned multi-thousand-char research summaries into two
          // fragments and produced the vague meta-answer). Budget per child is
          // 2–12k chars, and the whole block is bounded to ~half the context
          // window (≈3 chars/token) so a wide fan-out can't overflow.
          const ctxBudgetChars = Math.floor(this.config.contextWindowSize * 3 * 0.5);
          const totalMax = Math.max(12_000, Math.min(48_000, ctxBudgetChars || 48_000));
          const perChild = Math.max(2_000, Math.min(12_000, Math.floor(totalMax / collected.length)));
          const summary = collected
            .map((r) => {
              const out = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
              const clipped = out.length > perChild
                ? `${out.slice(0, perChild)}\n…[truncated ${out.length - perChild} chars]`
                : out;
              return `<child status="${r.status}" node="${r.nodeId}">\n${clipped}${r.notes ? `\n(notes: ${r.notes})` : ''}\n</child>`;
            })
            .join('\n\n');
          this.addSystemMessage(
            `SYSTEM: ${collected.length} detached subagent${collected.length > 1 ? 's' : ''} finished, ` +
              `but you did not call collect_children. Their full results are below:\n\n${summary}\n\n` +
              `Write ONE unified final answer that merges these results into a single coherent reply for ` +
              `the user. Do NOT reproduce each child separately, label them ("Child 1…"), or repeat the ` +
              `same point once per child — deduplicate and combine. Include all substantive findings, code, ` +
              `and data (the user sees only your reply, not the child output). If the children DISAGREE on ` +
              `any fact, do NOT silently pick one — say the sources conflict and give the differing values. ` +
              `Do NOT answer with a meta-summary that merely states you have the results; deliver the actual content.`,
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

          // P1.3 — deterministic relay fallback: if the synthesized answer
          // dropped the child content (a stub far shorter than the collected
          // material that doesn't quote it), append the formatted results
          // verbatim rather than trusting a small model to relay.
          const childText = collected
            .map((r) => (typeof r.output === 'string' ? r.output : JSON.stringify(r.output)))
            .join('\n\n');
          finalResult = ensureChildRelay(finalResult, childText, formatCollectedResults(collected));
        }
      }

      this.context.status = 'completed';
      this.context.completedAt = new Date();
      this.terminalEmitted = true;
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
      // inherited from the agent context, which the root agent
      // threads in at spawn time.
      recordAgentCompletion({
        agentId: this.context.id,
        sessionId: this.context.sessionId,
        userId: this.context.userId,
        workspaceId: this.context.workspaceId ?? null,
        swarmNodeId: this.context.id,
        role: this.context.role,
        root: isRootAgent(this.context),
        topic: this.context.topic,
        output: typeof finalResult === 'string' ? finalResult : JSON.stringify(finalResult),
      }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in agent-worker'));

      // Close any browser tabs the agent opened via browser-ext.new_tab
      import('@/tools/browser-ext').then(({ closeAgentTabs }) => {
        closeAgentTabs(this.context.id).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in agent-worker'));
      }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in agent-worker'));

      // RC5 (D3): on NORMAL completion, cancel any detached child still pending
      // after auto-collect. We are returning our final answer now, so their
      // output can never be relayed — leaving them running produces an orphan
      // that outlives us (the run-743d4b66 child ran 30 min past its parent this
      // way). Mirror the catch path: aborting our controller tears down children
      // chained to it via parentSignal; cancelAll clears the pending map.
      if (this.detached.count() > 0) {
        agentLogger.warn(
          { agentId: this.context.id, pending: this.detached.count() },
          'Cancelling detached children still pending at normal completion',
        );
        this.abortController.abort('parent completed without collecting all children');
        this.detached.cancelAll('parent completed without collecting all children');
      }

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
      // P1.7 — a stopped child must emit a complete-shaped terminal event so
      // the UI spinner resolves and a detached-parent finalizes. stop() emits
      // it directly for the common manual/cascade path; this covers a pure
      // parentSignal abort that never routed through stop(). Guarded so we
      // never double-fire.
      if (!wasStopped) {
        this.emit('status_change', { status: 'failed' });
        this.emit('error', { error: (error as Error).message });
      } else if (!this.terminalEmitted) {
        this.emit('status_change', { status: 'stopped' });
        this.emit('complete', {
          result: (error as Error).message || 'Agent stopped',
          stopped: true,
          reason: (error as Error).message,
        });
      }
      this.terminalEmitted = true;

      // Cancel-cascade: detached children never see a collect, and their
      // parent AbortSignal is already aborted (this.abortController). We
      // clear the pending map so the Promise references drop and the
      // orphan reaper can flip any `running` rows to `cancelled`.
      this.abortController.abort((error as Error).message || 'parent failed');
      this.detached.cancelAll((error as Error).message || 'parent failed');

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
      const arm = (delay: number) => {
        timer = setTimeout(() => {
          // The clock may have stopped since this timer was armed — a human
          // has been holding a permission prompt open. Re-arm for whatever is
          // actually left rather than killing a turn that spent the interval
          // waiting on a person.
          const left = this.config.timeout - this.elapsed();
          if (left > 0) {
            arm(left);
            return;
          }
          const msg = `Agent timeout exceeded (${Math.round(this.elapsed() / 1000)}s / ${Math.round(this.config.timeout / 1000)}s) during ${label}`;
          agentLogger.error({
            agentId: this.context.id, sessionId: this.context.sessionId,
            iteration: this.iteration, elapsedMs: this.elapsed(),
            phase: label, timeoutMs: this.config.timeout,
          }, msg);
          reject(new Error(msg));
        }, delay);
      };
      arm(remaining);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Race a promise against an ABSOLUTE ceiling from now (RC5 D5). Unlike
   * `raceTimeout`, the deadline is not adjusted for `elapsed()`/`pausedMs`, so a
   * self-timed tool that discounts its wait can't defeat it. This is a
   * last-resort backstop against a never-resolving tool promise, NOT a wall cap
   * — the ceiling is generous (hours), so a legitimately-long pipeline/collect
   * is unaffected; only a truly wedged wait trips it.
   */
  private async raceAbsolute<T>(promise: Promise<T>, label: string, ceilingMs: number): Promise<T> {
    if (ceilingMs <= 0) return promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ceilingPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Render short ceilings in their own unit — `Math.round(ms/60_000)`
        // prints a bare "0min" for anything under 30s, which reads as "no
        // ceiling" in a log line whose whole point is the ceiling.
        const ceilingLabel = ceilingMs >= 60_000
          ? `${Math.round(ceilingMs / 60_000)}min`
          : ceilingMs >= 1_000
            ? `${Math.round(ceilingMs / 1_000)}s`
            : `${ceilingMs}ms`;
        const msg = `Self-timed tool exceeded the absolute ceiling (${ceilingLabel}) during ${label} — treating as a wedged wait`;
        agentLogger.error(
          { agentId: this.context.id, iteration: this.iteration, phase: label, ceilingMs },
          msg,
        );
        reject(new Error(msg));
      }, ceilingMs);
    });
    try {
      return await Promise.race([promise, ceilingPromise]);
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
      this.lastActivityAt = Date.now(); // heartbeat — see getActivity()
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
      if (this.detached.count() > 0 && this.iteration > 0 && this.iteration % 5 === 0) {
        const pending = this.detached.list();
        const list = pending
          .map((pc) => `${pc.childId} (topic: ${pc.topic}${pc.subtopic ? '/' + pc.subtopic : ''}, running ${Math.round((Date.now() - pc.startedAt) / 1000)}s)`)
          .join('; ');
        this.addSystemMessage(
          `Reminder: ${pending.length} detached subagent${pending.length > 1 ? 's are' : ' is'} still running — ${list}. ` +
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
        // Phase 3.5 / 2.2 — the root root agent has no parent to receive a
        // structured timeout, so a bare timeout error would surface straight to
        // the user. Instead run one final no-tools summary turn. A child (any
        // non-root worker) still throws ChildTimeoutError so its parent gets a
        // ChildResult status='timeout' and can synthesize partial results.
        if (isRootAgent(this.context)) {
          return await this.finalizeGracefully('wall-clock budget reached');
        }
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

      // RC5 D2: pre-flight budget check. The loop-top gate only sees tokens
      // ALREADY spent, so a single call that ingests a huge input (the 373 KB
      // base64 screenshot) can blow past the cap in one step before the next
      // iteration's check. Project this call's input (post-compaction) and abort
      // BEFORE spending it if it would cross the cap.
      if (this.config.maxTokenBudget > 0) {
        const projected = this.totalTokensUsed + this.estimateRequestTokens();
        if (projected >= this.config.maxTokenBudget) {
          this.abortController.abort(`budget_exceeded_preflight:${projected}/${this.config.maxTokenBudget}`);
          throw new BudgetExceededError({
            agentId: this.context.id,
            used: projected,
            cap: this.config.maxTokenBudget,
          });
        }
      }

      // Get completion from LLM (with retry for transient failures)
      const llmStart = Date.now();
      let completion: CompletionResult;
      try {
        // Skip the WALL race for post-delegation LLM calls (toolsDisabled means a
        // pipeline/worker already completed, so elapsed() includes its time and
        // the wall deadline is already blown) — but still bound it, so a stuck
        // provider can't hold the worker open forever. See
        // DEFAULT_UNRACED_TURN_CEILING_MS.
        completion = this.toolExecutor.toolsDisabled
          ? await this.raceAbsolute(
              this.getCompletion(),
              'getCompletion:post-delegation',
              this.config.unracedTurnCeilingMs ?? DEFAULT_UNRACED_TURN_CEILING_MS,
            )
          : await this.raceTimeout(this.getCompletion(), 'getCompletion');
      } catch (err) {
        const errMsg = (err as Error).message || '';

        // Connection failures to upstream model providers (refused, dead container,
        // NXDOMAIN) are not transient — they indicate a dead container or misconfigured
        // endpoint. Surface to the user immediately so they can react (start container,
        // change model) instead of spinning through 14s of retries that all fail the same
        // way. The EAI_AGAIN DNS blip is deliberately excluded — see isFatalConnectionError —
        // so it falls through to the transient-retry path below.
        if (isFatalConnectionError(errMsg)) {
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
          || isTransientDnsError(errMsg)
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
      // Once a turn comes back untruncated, drop the G5 maxTokens boost.
      if (completion.finishReason !== 'length') this.lengthRetryBoost = 0;
      // RC5 D1: trust the provider's count only when it reported one. A 0/absent
      // usage (CLI providers, image-blind Ollama) falls back to an estimate so
      // the budget cap still binds instead of being a permanent no-op.
      const reportedTokens = completion.usage.totalTokens;
      this.totalTokensUsed += this.accountedTokens(completion);

      agentLogger.info({
        agentId: this.context.id, sessionId: this.context.sessionId,
        iteration: this.iteration, elapsedMs: this.elapsed(),
        phase: 'getCompletion', llmLatencyMs: Date.now() - llmStart,
        inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens,
        tokenEstimated: reportedTokens <= 0,
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

        // Capability floor signal (Phase 2.1): the model emitted tool calls
        // natively — the good sample that heals a prior shim streak.
        recordModelToolCall(this.context.model, false);
        this.sawNativeToolCall = true;

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
        const repeat = this.loopDetector.checkRepeat(completion.toolCalls);
        if (repeat.tripped) {
          agentLogger.warn({
            agentId: this.context.id, sessionId: this.context.sessionId,
            iteration: this.iteration, tools: toolNames,
            repeats: repeat.repeats,
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

        // Detect same-tool-name spam (different args each time, same name).
        // Catches chatty LLMs that spin on send_status_update with varying
        // messages — the per-signature loop above misses them because args
        // differ every call.
        const sameName = this.loopDetector.checkSameName(completion.toolCalls);
        if (sameName.tripped) {
          agentLogger.warn({
            agentId: this.context.id, toolNames: sameName.signature,
            repeats: sameName.repeats,
          }, 'Same tool name called repeatedly — disabling tools, forcing plain-text reply');
          this.toolExecutor.disableTools();
          // Close out the dangling assistant tool_calls with synthetic tool
          // responses — strict providers (DeepSeek) 400 on orphan tool_calls.
          this.appendSyntheticToolResults(completion.toolCalls, '[spam detected: tools disabled]');
          this.messages.push({
            role: 'user' as const,
            content:
              `[SYSTEM] You have called \`${sameName.signature}\` multiple times. ` +
              `Tools are now disabled. Respond to the user with plain text using the information you already have.`,
            timestamp: new Date(),
          });
          continue;
        }

        // Same call, same arguments, several times across the run. The two
        // checks above are both CONSECUTIVE, so an A,B,A,B,A ping-pong — the
        // shape behind a task costing 2 tool calls one run and 14 the next —
        // trips neither. Advisory only: the call still runs, because a re-read
        // after a write is a different answer to the same question.
        const redundant = this.loopDetector.checkRedundant(completion.toolCalls);
        if (redundant.tripped) {
          agentLogger.warn({
            agentId: this.context.id, sessionId: this.context.sessionId,
            iteration: this.iteration, tool: redundant.signature, count: redundant.count,
          }, 'Redundant tool call — same arguments already used this run');
          this.pendingRedundantNudge =
            `[SYSTEM] You have now called \`${redundant.signature}\` ${redundant.count} times with identical ` +
            `arguments. Its earlier result is already in this conversation — re-read it there rather than ` +
            `calling again, and move on to the next step or give your final answer.`;
        }

        // Drift: is this iteration's tool activity still about the brief?
        // Checked HERE — after name normalization, before execution — so a
        // drifting write actually gets stopped rather than producing one more
        // rogue file. An on-task iteration resets the counter.
        const drift = this.driftDetector?.record(completion.toolCalls) ?? { action: 'none' as const };
        if (drift.action === 'abort') {
          agentLogger.warn({
            agentId: this.context.id, iteration: this.iteration,
            consecutive: drift.consecutive, tools: toolNames,
          }, 'Task drift — aborting: tool activity has not matched the brief for many iterations');
          this.abortController.abort(`drift:${drift.consecutive}`);
          throw new DriftDetectedError({
            agentId: this.context.id,
            consecutive: drift.consecutive,
            briefSummary: this.driftDetector?.briefSummary() ?? '',
          });
        }
        if (drift.action === 'nudge') {
          agentLogger.warn({
            agentId: this.context.id, iteration: this.iteration,
            consecutive: drift.consecutive, tools: toolNames,
          }, 'Task drift suspected — nudging the agent back to its brief');
          // Let the tools run; just make sure the NEXT turn re-states the task.
          // Injecting after execution avoids orphaning the assistant's
          // tool_calls, which strict providers reject.
          this.pendingDriftNudge =
            `[SYSTEM] Your recent tool calls do not appear to relate to your task, whose key terms were: ` +
            `${this.driftDetector?.briefSummary() ?? ''}. If you are still working on it, continue. If you have ` +
            `drifted onto something else, STOP that work now and either return to the task or report plainly ` +
            `that you could not complete it. Do not invent a different deliverable.`;
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
        // Don't race the root agent timeout against them — a pipeline can legitimately
        // run for much longer than the root agent's own timeout.
        //
        // Phase 2.2 — `collect_children` blocks while detached children run.
        // That idle-wait is credited back to the parent's clock via pausedMs,
        // but raceTimeout computes its deadline BEFORE the wait, so racing it
        // would kill the parent mid-collect (the 1.3 "root agent failed while
        // blocked on children" bug). It bounds its own wait internally, so skip
        // the race — like a self-timed final tool.
        // Three cases:
        //  - `final` tools (create_pipeline, delegation handoffs) legitimately
        //    block on external events — a pipeline stage can AWAIT human approval
        //    for hours (approvalTimeoutMs). NEVER race these; any ceiling risks
        //    killing a run while a human is still deciding.
        //  - collect_children self-bounds to ~the child wall, but gets a generous
        //    absolute backstop (RC5 D5) so a never-settling wait can't pin the
        //    worker forever. Its real waits (~10 min) are far under the ceiling,
        //    so the backstop only fires on a genuine wedge.
        //  - everything else races the normal wall clock.
        const toolCalls = completion.toolCalls; // narrowed non-undefined by the guard above
        const isFinal = this.toolExecutor.hasFinalToolCall(toolCalls);
        const isCollect = toolCalls.some((tc) => tc.name === 'collect_children');
        // A worker running ANY tool is legitimately busy, not wedged — mark it
        // blocked for the whole execution so the reaper's heartbeat check
        // doesn't kill a healthy worker mid tool call (a long deep-research /
        // shell / MCP fetch can outlast the reaper's inactivity window). The
        // wall race below still bounds normal tools independently.
        const toolMessages: AgentMessage[] = await this.whileBlocked(blockedReason(toolCalls, isFinal, isCollect), () => {
          if (isFinal) {
            // Legitimately long (may await human approval) — no wall race.
            return this.toolExecutor.handleToolCalls(toolCalls);
          }
          if (isCollect) {
            // Self-bounds (~child wall); keep a generous absolute backstop.
            return this.raceAbsolute(
              this.toolExecutor.handleToolCalls(toolCalls),
              'handleToolCalls:collect_children',
              this.config.selfTimedToolCeilingMs ?? DEFAULT_SELF_TIMED_TOOL_CEILING_MS,
            );
          }
          return this.raceTimeout(
            this.toolExecutor.handleToolCalls(toolCalls),
            'handleToolCalls',
          );
        });
        this.messages.push(...toolMessages);

        // Drift nudge, queued before execution — appended now that the
        // tool_calls are properly closed out by their results.
        if (this.pendingDriftNudge) {
          this.messages.push({ role: 'user' as const, content: this.pendingDriftNudge, timestamp: new Date() });
          this.pendingDriftNudge = undefined;
        }
        if (this.pendingRedundantNudge) {
          this.messages.push({ role: 'user' as const, content: this.pendingRedundantNudge, timestamp: new Date() });
          this.pendingRedundantNudge = undefined;
        }

        agentLogger.info({
          agentId: this.context.id, sessionId: this.context.sessionId,
          iteration: this.iteration, elapsedMs: this.elapsed(),
          phase: 'handleToolCalls', toolDurationMs: Date.now() - toolStart, tools: toolNames,
        }, 'Tool execution completed');

        // Drain steering queue before next LLM call
        this.drainSteeringQueue();
        continue;
      }

      // G5: a truncated ('length') or MALFORMED_FUNCTION_CALL turn that surfaced
      // as prose is a native-call problem, not a prompt problem — retry the
      // model ONCE with more headroom before the text-parse/toolshim fallbacks
      // (those otherwise manufacture a `call_shim_…` for a capable model).
      if (
        !completion.toolCalls?.length &&
        !this.lengthRetried &&
        !this.toolExecutor.toolsDisabled &&
        (completion.finishReason === 'length' ||
          completion.finishReason === 'MALFORMED_FUNCTION_CALL' ||
          /MALFORMED_FUNCTION_CALL/.test(completion.content || ''))
      ) {
        this.lengthRetried = true;
        this.lengthRetryBoost = 4096;
        agentLogger.warn({
          agentId: this.context.id, iteration: this.iteration,
          finishReason: completion.finishReason,
        }, 'Truncated/malformed turn — retrying native call with more maxTokens before recovery');
        // Drop the truncated assistant turn so it isn't replayed.
        if (this.messages.length && this.messages[this.messages.length - 1].role === 'assistant') {
          this.messages.pop();
        }
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

      // No tool calls and no visible content — the model produced a
      // thinking-only turn (reasoning tokens consumed the whole output, e.g.
      // qwen3 planning "let me open these pages" without yet emitting the
      // webfetch call). This is NOT a final answer: nudge it to continue and
      // retry up to 3 times. The nudge allows EITHER the next tool call or a
      // final text answer, so a mid-task research agent can proceed to its
      // planned tool instead of being forced to answer prematurely.
      if (!completion.content?.trim()) {
        this.emptyRetries = (this.emptyRetries || 0) + 1;
        if (this.emptyRetries <= 3) {
          agentLogger.warn({
            agentId: this.context.id, iteration: this.iteration,
            outputTokens: completion.usage.outputTokens, emptyRetry: this.emptyRetries,
            hadReasoning: !!completion.reasoningContent,
          }, 'Thinking-only response (no content, no tool calls), nudging to continue');
          this.messages.push({
            role: 'user',
            content:
              'You stopped after thinking without producing a visible action. ' +
              'Continue the task now: call the next tool you need, or — if you already have enough information — write your final answer as plain text. ' +
              'Do not end your turn on thinking alone.',
            timestamp: new Date(),
          });
          continue;
        }
        agentLogger.warn({ agentId: this.context.id }, 'Max empty retries reached, returning fallback');
      }

      // The turn that produced this answer was cut off mid-stream. The one
      // `lengthRetried` retry above has already been spent by the time a second
      // truncation lands here, so the fragment becomes the final answer — a
      // Testing stage once "reported" 95 characters ending mid-sentence
      // ("Before running, I need to fix one assertion I got wrong in my own
      // analysis: at the GiB boundary") and the pipeline handed that on as its
      // result. Recorded, not repaired: callers that care (pipeline stages,
      // whose report becomes the next stage's input) can refuse it, while chat
      // still shows the user whatever was produced.
      if (completion.finishReason === 'length') {
        this.finishedTruncated = true;
        agentLogger.warn(
          { agentId: this.context.id, iteration: this.iteration, contentLength: completion.content?.length ?? 0 },
          'Final turn was truncated — the answer is a fragment',
        );
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

      // Track token usage for the root agent (response is saved by handleMessage with correct content)
      if (isRootAgent(this.context)) {
        await sessionRepository.incrementMessageCount(this.context.sessionId, this.accountedTokens(completion));
      }

      return response;
    }

    // Phase 3.5 — iteration budget exhausted. Rather than ending on a bare
    // "Max iterations reached" error string, run one final no-tools turn so the
    // worker returns a summary of what it did and what remains (hermes pattern).
    return await this.finalizeGracefully('iteration budget reached');
  }

  /**
   * Graceful exit (Phase 3.5): a worker that hits its iteration or wall-clock
   * budget must not end with a bare error string. Disable tools and run one
   * final LLM turn asking for a plain-text summary of progress + what remains.
   * Falls back to a deterministic recap of the last tool result if that call
   * fails, so this NEVER throws.
   */
  private async finalizeGracefully(reason: string): Promise<string> {
    agentLogger.warn(
      { agentId: this.context.id, role: this.context.role, reason, iteration: this.iteration },
      'Graceful exit — running final no-tools summary turn',
    );
    this.toolExecutor.disableTools();
    this.messages.push({
      role: 'user',
      content:
        `[SYSTEM] You have reached your ${reason}. Do NOT call any tools. ` +
        `In plain text, summarize what you accomplished and what remains unfinished, ` +
        `using the information already gathered. This is your final answer.`,
      timestamp: new Date(),
    });
    try {
      // Bounded, not wall-raced: we are here BECAUSE the wall/iteration budget
      // is spent, so raceTimeout would reject before the call started. See
      // DEFAULT_UNRACED_TURN_CEILING_MS.
      const completion = await this.raceAbsolute(
        this.getCompletion(),
        'getCompletion:finalizeGracefully',
        this.config.unracedTurnCeilingMs ?? DEFAULT_UNRACED_TURN_CEILING_MS,
      );
      if (isRootAgent(this.context)) {
        await sessionRepository
          .incrementMessageCount(this.context.sessionId, this.accountedTokens(completion))
          .catch(() => { /* best-effort accounting */ });
      }
      const text = (completion.content || '').trim();
      if (text) return text;
    } catch (err) {
      agentLogger.error(
        { err, agentId: this.context.id },
        'Graceful summary turn failed — falling back to deterministic recap',
      );
    }
    // Deterministic fallback — never return a bare error.
    const lastTool = [...this.messages].reverse().find((m) => m.role === 'tool');
    if (lastTool?.content) {
      const body = typeof lastTool.content === 'string' ? lastTool.content : JSON.stringify(lastTool.content);
      return `I reached my ${reason} before fully finishing. Here is where things stand based on the work so far:\n\n${body}`;
    }
    return `I reached my ${reason} before fully finishing the task. Some steps may remain incomplete — let me know if you'd like me to continue.`;
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
    // This model already proved it can emit tool calls natively in this run —
    // its prose is an answer, not a call it failed to make. See
    // `sawNativeToolCall`.
    if (this.sawNativeToolCall) return null;
    const advertised = this.getAdvertisedToolHandlers();
    if (advertised.length === 0) return null;
    // Prose that never tried to be a tool call has nothing to translate. This
    // is the ordinary final answer, so without the check the shim bills an
    // extra LLM call on every successful turn. See `proseShowsToolIntent`.
    if (!proseShowsToolIntent(prose, advertised.map((t) => t.name))) {
      agentLogger.debug(
        { agentId: this.context.id, iteration: this.iteration },
        'Toolshim skipped: prose shows no tool intent (plain final answer)',
      );
      return null;
    }
    // Mark attempted up front: a thrown/failed translator call must still count
    // against the once-per-iteration cap (no retry storm on the failure path).
    this.toolShimAttemptedIteration = this.iteration;

    const model = await getModelRegistry().getModelForTopic('background');
    if (!model) {
      if (!this.toolShimUnboundLogged) {
        this.toolShimUnboundLogged = true;
        agentLogger.debug(
          { agentId: this.context.id },
          'Toolshim skipped: background topic unbound (toolshim rides the background lane)',
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

    // Capability floor signal (Phase 2.1): this model failed to emit a native
    // tool call and needed the shim. Recorded per model — a recent shim streak
    // bars it from orchestrating (validateRootModel).
    recordModelToolCall(this.context.model, true);

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

    // Hard deadline. This is a one-shot, zero-history, no-tools translation —
    // if it can't answer inside the ceiling it is not worth the turn, and the
    // caller (`translateToToolCall`) already fail-softs to "no tool call". The
    // call previously carried only the worker's abort signal, so a cold local
    // provider (ollama with a 15 min load timeout) could pin the whole turn
    // AFTER the user's answer was already written. Chain to the worker signal
    // so a stop() still cancels, and abort on the deadline so the underlying
    // request is torn down rather than left running.
    const ceilingMs = this.config.toolShimTimeoutMs ?? TOOLSHIM_TIMEOUT_MS;
    const deadline = new AbortController();
    const onParentAbort = () => deadline.abort(this.abortController.signal.reason);
    if (this.abortController.signal.aborted) onParentAbort();
    else this.abortController.signal.addEventListener('abort', onParentAbort, { once: true });
    const timer = ceilingMs > 0
      ? setTimeout(
          () => deadline.abort(new Error(`toolshim translator exceeded ${ceilingMs}ms`)),
          ceilingMs,
        )
      : undefined;

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
      sessionId: this.context.sessionId,
      signal: deadline.signal,
    };

    let result: CompletionResult;
    try {
      if (model.provider && model.provider !== 'litellm') {
        const { getProviderRouter } = await import('@/models/providers');
        const directProvider = getProviderRouter().getProviderByName(model.provider);
        result = directProvider
          ? await directProvider.complete(completionOpts)
          : await getLiteLLMClient().complete(completionOpts);
      } else {
        result = await getLiteLLMClient().complete(completionOpts);
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.abortController.signal.removeEventListener('abort', onParentAbort);
    }

    await getCostTracker().logUsageWithCost(
      this.context.userId,
      model.modelId,
      result.usage.inputTokens,
      result.usage.outputTokens,
      {
        sessionId: this.context.sessionId,
        agentId: this.context.id,
        requestType: 'chat',
        metadata: { toolshim: true, iteration: this.iteration },
        cachedInputTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
      },
    );

    return result.content;
  }

  /**
   * Execute tool calls recovered from text (parseTextToolCalls) or toolshim —
   * push the synthetic assistant message, emit the action, run the tools, and
   * drain the steer queue. Shared so both recovery paths behave identically.
   */
  private async executeRecoveredToolCalls(toolCalls: ToolCall[], source: string): Promise<void> {
    // Recovering a tool call from prose means the model didn't emit a structured
    // one this turn — force it next turn (G1 one-shot escalation).
    this.forceToolChoiceNextTurn = true;
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

    const isSelfTimedTool =
      this.toolExecutor.hasFinalToolCall(toolCalls) ||
      toolCalls.some((tc) => tc.name === 'collect_children');
    // Mark blocked for the whole execution (same as the structured path) so the
    // reaper's heartbeat check doesn't kill a healthy worker mid tool call —
    // including a recovered `final` tool awaiting human approval.
    const toolMessages = await this.whileBlocked(
      blockedReason(toolCalls, this.toolExecutor.hasFinalToolCall(toolCalls), toolCalls.some((tc) => tc.name === 'collect_children')),
      () =>
        isSelfTimedTool
          ? this.toolExecutor.handleToolCalls(toolCalls)
          : this.raceTimeout(this.toolExecutor.handleToolCalls(toolCalls), 'handleToolCalls'),
    );
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
    const declarableTools: ChatCompletionTool[] = advertisedTools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    const tools: ChatCompletionTool[] = this.toolExecutor.toolsDisabled ? [] : declarableTools;

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
    // G1 one-shot escalation: if the PREVIOUS turn's tool calls had to be
    // recovered from prose (text-parse/shim), force the next call to emit a
    // structured tool call (toolChoice 'required'), then fall back to 'auto'.
    const escalateToolChoice = this.forceToolChoiceNextTurn && tools.length > 0;
    this.forceToolChoiceNextTurn = false;

    // Dropping the tool definitions on a turn where tools are DISABLED (a
    // `final` tool ran, the budget is spent) breaks the request outright once
    // the conversation already contains tool_use/tool_result blocks: they
    // reference tools the request no longer declares. Anthropic-family
    // providers reject exactly that — "The toolConfig field must be defined
    // when using toolUse and toolResult content blocks" — which is how a
    // research child died mid-run on 2026-08-02 and the spawner's retry then
    // answered from model recall with no searches at all.
    //
    // `toolChoice: 'none'` is the supported way to say "no more tool calls"
    // (every provider here maps it), so the history stays valid while the
    // disable still holds. Nothing changes on a turn that has tools.
    const declareToolsOnly =
      tools.length === 0 && declarableTools.length > 0 && historyReferencesTools(this.messages);
    if (declareToolsOnly) {
      agentLogger.debug(
        { agentId: this.context.id, toolCount: declarableTools.length },
        'Tools disabled but the history references them — declaring them with toolChoice:none',
      );
    }

    const completionOpts = applyTopicParamOverrides(
      {
        model: litellmModel,
        messages: this.messages,
        tools: tools.length > 0 ? tools : declareToolsOnly ? declarableTools : undefined,
        ...(declareToolsOnly ? { toolChoice: 'none' as const } : {}),
        // G6: nullish coalescing — a configured temperature of 0 must survive
        // (|| turned it into 0.7, hurting small-model tool-call fidelity).
        temperature: model.defaultTemperature ?? 0.7,
        maxTokens: (model.defaultMaxTokens ?? model.maxTokens ?? 4096) + this.lengthRetryBoost,
        ...(escalateToolChoice ? { toolChoice: 'required' as const } : {}),
        // A9: cancel the in-flight model call when the worker is stopped.
        signal: this.abortController.signal,
        extraBody,
        endpoint: model.endpoint || undefined,
        apiKey,
        userId: this.context.userId,
        sessionId: this.context.sessionId,
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
      {
        sessionId: this.context.sessionId,
        agentId: this.context.id,
        requestType: 'chat',
        metadata: { iteration: this.iteration },
        cachedInputTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
      },
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

    // Log the model's actual text (truncated) — not just {model, messageCount}.
    // Without this a post-mortem can't see WHY an agent pivoted (run 743d4b66:
    // a research child silently drifted to writing docs and the reasoning was
    // unrecoverable). Only emit when there's prose to record.
    if (result.content && result.content.trim()) {
      this.emit('thought', { text: result.content.slice(0, 1000), truncated: result.content.length > 1000 });
    }

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

  override stop(reason?: string): void {
    const stopReason = reason || 'stopped';
    this.abortController.abort(stopReason);
    // Requests no longer expire, so a stopped agent would otherwise sit on an
    // unanswerable prompt forever. Release its waits as unapproved.
    try {
      getPermissionManager().cancelWaits(this.context.id);
    } catch { /* permission manager unavailable */ }
    if (this.permissionWaitCleanup) {
      this.permissionWaitCleanup();
      this.permissionWaitCleanup = null;
    }
    this.endPause();
    if (this.parentSignalCleanup) {
      this.parentSignalCleanup();
      this.parentSignalCleanup = null;
    }
    // Already finalized (completed / failed / a prior stop) — just ensure the
    // abort fired; don't emit a second terminal event.
    if (this.terminalEmitted) {
      agentLogger.info({ agentId: this.context.id, reason: stopReason }, 'Agent stop() after terminal — abort only');
      return;
    }
    this.terminalEmitted = true;
    this.context.status = 'stopped';
    this.context.completedAt = new Date();
    // P1.7 — emit BOTH status_change:stopped and a complete-shaped terminal
    // event so the UI spinner resolves and a detached parent finalizes. The
    // reason (manual / cascade) rides along.
    this.emit('status_change', { status: 'stopped', reason: stopReason });
    this.emit('complete', { result: `Agent stopped: ${stopReason}`, stopped: true, reason: stopReason });
    agentLogger.info({ agentId: this.context.id, reason: stopReason }, 'Agent stopped');
  }
}
