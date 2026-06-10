import { isCancellationError } from '@/core/swarm/errors';
import { renderToolActivity } from '@/core/work-stream/renderers';
import { stripWorkStreamMeta } from '@/shared/work-stream';
import { auditRepository } from '@/db/repositories/audit-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { getPermissionManager } from '@/security/permissions';
import { agentLogger, coreLogger } from '@/utils/logger';
import { sanitizeToolOutput } from '@/utils/sanitize';
import type { AgentEvent, ToolHandler } from './agent-base';
import type { AgentContext, AgentMessage, ToolCall, ToolResult } from './types';

const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

/**
 * Bounded Levenshtein edit distance. Returns early once the running minimum
 * exceeds `max`, so a near-miss check costs O(n·m) only for genuinely close
 * strings. Used to recover from models that emit a slightly-off tool name.
 */
function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

const FILE_CHANGE_TOOLS = new Set([
  'filesystem__write_file',
  'filesystem__append_file',
  'filesystem__delete_file',
  'filesystem__copy_file',
  'filesystem__move_file',
  'filesystem__create_directory',
]);

/**
 * Pull the canonical filesystem path out of a file-mutating tool's *result*.
 * write/append/delete/create_directory return `{ path }`; copy/move return
 * `{ source, destination }` where `destination` is the file that now exists.
 * Returns undefined when the result carries no usable path so the caller can
 * fall back to the requested-argument path.
 */
export function resolvedFileChangePath(result: unknown): string | undefined {
  if (result == null || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  const destination = r.destination;
  if (typeof destination === 'string' && destination.length > 0) return destination;
  const path = r.path;
  if (typeof path === 'string' && path.length > 0) return path;
  return undefined;
}

/** Tools whose wall-clock duration is *paused* out of the calling agent's
 * timer — the agent is blocked waiting on the child, not doing work. */
const DELEGATION_TOOLS = new Set(['spawn_child', 'escalate_to_different_expert']);

/**
 * One-line preview of a tool's return value for UI streaming. Strings are
 * trimmed to a single line; objects are JSON-serialized with a length cap.
 * Keep this tight — it lands in the `tool_call_complete` event payload
 * and the UI only needs a glance ("read 348 lines from x.ts").
 */
function previewToolResult(result: unknown): string {
  if (result == null) return '';
  let text: string;
  if (typeof result === 'string') {
    text = result;
  } else {
    try {
      text = JSON.stringify(result);
    } catch {
      text = String(result);
    }
  }
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? oneLine.slice(0, 197) + '...' : oneLine;
}

export class ToolExecutor {
  private tools: Map<string, ToolHandler> = new Map();
  private consecutiveToolErrors: number = 0;
  private _toolsDisabled: boolean = false;

  constructor(
    private context: AgentContext,
    private emitFn: (type: AgentEvent['type'], data: unknown) => void,
    /**
     * Called after a delegation tool finishes. The agent uses this to subtract
     * child-wait time from its own timeout counter. User spec: "waiting time
     * should not go into the timeout calculation."
     */
    private onDelegationPause?: (durationMs: number) => void,
  ) {}

  get toolsDisabled(): boolean {
    return this._toolsDisabled;
  }

  /** External caller (e.g. AgentWorker loop guard) can force-disable tools. */
  disableTools(): void {
    this._toolsDisabled = true;
  }

  registerTool(tool: ToolHandler): void {
    this.tools.set(tool.name, tool);
    agentLogger.debug({ agentId: this.context.id, tool: tool.name }, 'Tool registered');
  }

  registerTools(tools: ToolHandler[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }

  getToolId(toolName: string): string | undefined {
    return this.tools.get(toolName)?.toolId;
  }

  /**
   * Rewrite any near-miss tool-call names to their canonical registered form
   * in place. Must run before anything reads `tc.name` for display or routing
   * (the worker's `tool_call` event, this executor's `action` snapshot) so the
   * whole event stream agrees with what actually executes. Idempotent — exact
   * matches are left untouched; unresolvable names are left for the miss path
   * to report. See `resolveToolName`.
   */
  normalizeToolCallNames(toolCalls: ToolCall[]): void {
    for (const tc of toolCalls) {
      if (this.tools.has(tc.name)) continue;
      const resolved = this.resolveToolName(tc.name);
      if (resolved && 'canonical' in resolved) {
        agentLogger.info(
          { agentId: this.context.id, requested: tc.name, routedTo: resolved.canonical },
          'Routed near-miss tool name to its canonical form',
        );
        tc.name = resolved.canonical;
      }
    }
  }

  /**
   * Recover from a tool name the model got slightly wrong before it dead-ends
   * at `Unknown tool`. Registered names are prefixed (`filesystem__read_file`);
   * models periodically emit the bare sub-name (`read_file`) or a typo. Two
   * stages, both auto-routing ONLY when the match is unambiguous:
   *
   *  1. Bare-name alias: if `name` has no `__` and exactly one registered tool
   *     ends with `__<name>`, route to it. Ambiguous (two groups own the same
   *     sub-name) → no route.
   *  2. Fuzzy fallback: closest registered name within edit distance 2. Routes
   *     only when that closest name is unique at the minimum distance.
   *
   * Returns the resolved canonical name (caller looks it up + logs the
   * correction), a `didYouMean` hint when a single best guess exists but we
   * won't silently route, or null when nothing is close.
   */
  private resolveToolName(name: string): { canonical: string } | { didYouMean: string } | null {
    // Stage 1: unambiguous bare sub-name → prefixed name.
    if (!name.includes('__')) {
      const suffix = `__${name}`;
      const owners: string[] = [];
      for (const registered of this.tools.keys()) {
        if (registered.endsWith(suffix)) owners.push(registered);
      }
      if (owners.length === 1) return { canonical: owners[0] };
    }

    // Stage 2: closest registered name within edit distance 2.
    const MAX_DISTANCE = 2;
    let best: string | undefined;
    let bestDist = MAX_DISTANCE + 1;
    let tied = false;
    for (const registered of this.tools.keys()) {
      const d = boundedLevenshtein(name, registered, MAX_DISTANCE);
      if (d < bestDist) {
        bestDist = d;
        best = registered;
        tied = false;
      } else if (d === bestDist) {
        tied = true;
      }
    }
    if (best === undefined || bestDist > MAX_DISTANCE) return null;
    // A unique closest name is safe to auto-route; a tie is reported as a hint
    // so the next iteration can correct itself rather than us guessing wrong.
    return tied ? { didYouMean: best } : { canonical: best };
  }

  /** Check if any of the given tool calls target a final (delegation) tool */
  hasFinalToolCall(toolCalls: ToolCall[]): boolean {
    return toolCalls.some(tc => this.tools.get(tc.name)?.final === true);
  }

  /**
   * Swarm Phase 2: find `spawn_child` calls with a matching `parallelGroup`
   * in the current turn and run them via `Promise.all`. Returns a map of
   * tool-call-id → `ToolResult` for the parallel ones; the caller merges
   * these back into the sequential results at each original position.
   *
   * Default fan-out cap per turn is enforced at the spawner — this method
   * only handles the concurrency mechanics. If a group has a single member
   * it is handled as normal (sequential) to keep semantics simple.
   */
  private async executeParallelSwarmGroups(
    toolCalls: ToolCall[],
  ): Promise<Map<string, ToolResult>> {
    const out = new Map<string, ToolResult>();

    // Bucket by parallelGroup.
    const groups = new Map<string, ToolCall[]>();
    for (const tc of toolCalls) {
      if (tc.name !== 'spawn_child') continue;
      const pg = (tc.arguments as Record<string, unknown>).parallelGroup;
      if (typeof pg !== 'string' || !pg.trim()) continue;
      const key = pg.trim();
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = [];
        groups.set(key, bucket);
      }
      bucket.push(tc);
    }

    for (const [key, bucket] of groups) {
      // Singleton group — let the normal sequential path handle it.
      if (bucket.length < 2) continue;

      // Default fan-out cap per turn (design §Spawn Mechanics: 4/node/turn).
      // The spawner also enforces its own per-node fan-out budget.
      const DEFAULT_PARALLEL_CAP = 4;
      const group = bucket.slice(0, DEFAULT_PARALLEL_CAP);
      const excess = bucket.slice(DEFAULT_PARALLEL_CAP);

      agentLogger.info(
        {
          agentId: this.context.id,
          parallelGroup: key,
          count: group.length,
          excess: excess.length,
        },
        'Fanning out parallel spawn_child group',
      );

      const tool = this.tools.get('spawn_child');
      if (!tool) continue;

      const groupStart = Date.now();
      const promises = group.map(async (tc) => {
        try {
          const res = await tool.execute(tc.arguments, this.context);
          return { toolCallId: tc.id, result: res } as ToolResult;
        } catch (err) {
          return {
            toolCallId: tc.id,
            result: null,
            error: (err as Error).message,
          } as ToolResult;
        }
      });
      const settled = await Promise.all(promises);
      // Pause parent clock for wall-clock of the slowest branch.
      if (this.onDelegationPause) this.onDelegationPause(Date.now() - groupStart);
      for (const r of settled) out.set(r.toolCallId, r);
      // Over-cap calls short-circuit as concurrency_limit.
      for (const tc of excess) {
        out.set(tc.id, {
          toolCallId: tc.id,
          result:
            `<ChildResult nodeId="" status="concurrency_limit" tokens="0" durationMs="0">\n` +
            `<output>null</output>\n<notes>parallel fan-out cap (${DEFAULT_PARALLEL_CAP}) exceeded for group "${key}"</notes>\n</ChildResult>`,
        });
      }
    }

    return out;
  }

  /**
   * Handle tool calls from the LLM with permission gating.
   * Returns tool result messages to append to the conversation.
   *
   * Swarm Phase 2: `spawn_child` calls in the same turn that share a
   * `parallelGroup` are fanned out via `Promise.all` and their results
   * merged back into the `results` list in call order. Default fan-out
   * cap is enforced at the spawner (see `parent.budget.fanOut.cap`).
   */
  async handleToolCalls(toolCalls: ToolCall[]): Promise<AgentMessage[]> {
    // Rewrite near-miss names to canonical BEFORE the action snapshot below, so
    // the emitted call names match what executes. Idempotent if the worker
    // already normalized (it does, before its own tool_call event).
    this.normalizeToolCallNames(toolCalls);

    this.emitFn('action', {
      role: this.context.role,
      toolCalls: toolCalls.map(tc => {
        // Thread 1 (rich work stream): a per-tool renderer turns the call into
        // a human one-liner + a structured, capped input preview. `argsSummary`
        // stays for backward-compat (TUI + REST `/agents/:id/events` replay
        // don't yet read the structured shape).
        const activity = renderToolActivity(tc.name, tc.arguments);
        return {
          id: tc.id,
          name: tc.name,
          argsSummary: Object.entries(tc.arguments)
            .map(([k, v]) => {
              const s = typeof v === 'string' ? v : JSON.stringify(v);
              return `${k}: ${s.length > 60 ? s.slice(0, 57) + '...' : s}`;
            })
            .join(', ')
            .slice(0, 120),
          title: activity.title,
          input: activity.input,
        };
      }),
    });

    const permissionManager = getPermissionManager();
    const results: ToolResult[] = [];
    // Swarm: detect parallelGroup spawn_child calls and execute them
    // concurrently. Results keyed by toolCallId for merge-in-order below.
    const parallelResults = await this.executeParallelSwarmGroups(toolCalls);

    for (const toolCall of toolCalls) {
      // Swarm: if this call was handled by the parallel fan-out, skip.
      if (parallelResults.has(toolCall.id)) {
        results.push(parallelResults.get(toolCall.id)!);
        continue;
      }
      const tool = this.tools.get(toolCall.name);

      if (!tool) {
        // Names were already normalized at entry, so anything still missing is
        // genuinely unknown — but offer the closest match as a hint so the next
        // iteration can self-correct instead of blindly retrying.
        const resolved = this.resolveToolName(toolCall.name);
        const hint =
          resolved && 'didYouMean' in resolved ? ` Did you mean "${resolved.didYouMean}"?` : '';
        results.push({
          toolCallId: toolCall.id,
          result: null,
          error: `Unknown tool: ${toolCall.name}.${hint}`,
        });
        continue;
      }

      const toolId = tool.toolId || 'agent';

      // Internal orchestrator meta-tools are always allowed
      if (toolId === 'agent') {
        try {
          const toolExecStart = Date.now();
          const result = await tool.execute(toolCall.arguments, this.context);
          const toolExecMs = Date.now() - toolExecStart;

          // Delegation tools: pause parent's timeout clock for this duration.
          if (DELEGATION_TOOLS.has(toolCall.name) && this.onDelegationPause) {
            this.onDelegationPause(toolExecMs);
          }

          agentLogger.info({
            agentId: this.context.id, sessionId: this.context.sessionId,
            tool: toolCall.name, toolId, durationMs: toolExecMs,
          }, 'Tool executed');

          {
            const activity = renderToolActivity(toolCall.name, toolCall.arguments, result, true);
            this.emitFn('action', {
              type: 'tool_call_complete',
              toolCallId: toolCall.id,
              name: toolCall.name,
              role: this.context.role,
              status: 'ok',
              durationMs: toolExecMs,
              resultPreview: previewToolResult(result),
              title: activity.title,
              input: activity.input,
              result: activity.result,
            });
          }

          results.push({ toolCallId: toolCall.id, result });

          if (tool.final) {
            this._toolsDisabled = true;
            agentLogger.info(
              { agentId: this.context.id, tool: toolCall.name },
              'Final tool executed — disabling tools for remaining iterations',
            );
          }

          // Safety: LLMs sometimes use `send_status_update(progress=100)` as
          // their terminal action instead of returning plain text. Treat
          // progress=100 as a signal: disable further tools so the next
          // iteration MUST reply with text. Prevents the orchestrator from
          // looping on status updates indefinitely. The meta-tool also
          // stashes `lastStatusMessage` so the service layer can fall back
          // to that text if the LLM still returns empty.
          if (toolCall.name === 'send_status_update') {
            const progress = (toolCall.arguments as Record<string, unknown>).progress;
            if (typeof progress === 'number' && progress >= 100) {
              this._toolsDisabled = true;
              agentLogger.info(
                { agentId: this.context.id, progress },
                'send_status_update(progress=100) — disabling tools, forcing plain-text reply',
              );
            }
          }
        } catch (error) {
          // If a final tool fails, propagate immediately — avoids a slow LLM round-trip
          // just to relay the error message to the user
          if (tool.final) {
            throw error;
          }
          {
            const activity = renderToolActivity(toolCall.name, toolCall.arguments);
            this.emitFn('action', {
              type: 'tool_call_complete',
              toolCallId: toolCall.id,
              name: toolCall.name,
              role: this.context.role,
              status: isCancellationError(error) ? 'cancelled' : 'error',
              error: (error as Error).message,
              title: activity.title,
              input: activity.input,
            });
          }
          results.push({ toolCallId: toolCall.id, result: null, error: (error as Error).message });
        }
        continue;
      }

      // Permission check
      const permResult = await permissionManager.check(
        this.context.userId,
        toolId,
        toolCall.name,
        toolCall.arguments
      );

      if (permResult.level === 'DENY') {
        agentLogger.info(
          { agentId: this.context.id, tool: toolCall.name, reason: permResult.reason },
          'Tool call denied by permission policy'
        );

        results.push({
          toolCallId: toolCall.id,
          result: null,
          error: `Permission denied: ${permResult.reason || 'action is not allowed'}. Do NOT retry this action — it is blocked by policy.`,
        });

        await auditRepository.logToolDenied(
          this.context.userId,
          this.context.sessionId,
          toolCall.name,
          toolId,
          { args: toolCall.arguments, reason: permResult.reason }
        );
        continue;
      }

      if (permResult.level === 'ASK') {
        // Autonomous agent workers (non-orchestrator roles spawned by the orchestrator)
        // cannot prompt a human — auto-approve their tool calls at ASK level.
        const isAutonomousWorker = this.context.role && this.context.role !== 'orchestrator';

        if (!isAutonomousWorker) {
          const requestId = await permissionManager.requestApproval(
            this.context.userId,
            this.context.id,
            toolId,
            toolCall.name,
            toolCall.arguments,
            this.context.sessionId
          );

          this.emitFn('permission_request', {
            requestId,
            toolName: toolCall.name,
            args: toolCall.arguments,
            toolId,
          });

          const approved = await permissionManager.waitForApproval(requestId);

          if (!approved) {
            agentLogger.info(
              { agentId: this.context.id, tool: toolCall.name, requestId },
              'Tool call denied by user — aborting agent'
            );

            await auditRepository.logToolDenied(
              this.context.userId,
              this.context.sessionId,
              toolCall.name,
              toolId,
              { args: toolCall.arguments, reason: 'user_denied', requestId }
            );

            // Abort the agent entirely — don't let it retry or try alternatives.
            // The orchestrator will handle follow-up with the user.
            throw new Error(`Permission denied for "${toolCall.name}". The user rejected this action.`);
          }
        } else {
          agentLogger.info(
            { agentId: this.context.id, tool: toolCall.name, role: this.context.role },
            'Auto-approving ASK-level tool for autonomous worker'
          );
        }
      }

      // ALLOW path (or approved ASK) — execute tool

      // Pre-tool hook check
      try {
        const { getHookManager } = await import('@/hooks/manager');
        const hookManager = getHookManager();
        const preHookResult = await hookManager.triggerToolHooks('tool_pre', toolCall.name, toolId, toolCall.arguments);
        if (preHookResult.decision === 'deny') {
          results.push({
            toolCallId: toolCall.id,
            result: null,
            error: `Blocked by hook: ${preHookResult.message || 'pre-tool hook denied execution'}`,
          });
          continue;
        }
      } catch { /* hooks not ready, allow by default */ }

      try {
        const toolExecStart = Date.now();
        const result = await tool.execute(toolCall.arguments, this.context);
        const toolExecMs = Date.now() - toolExecStart;

        agentLogger.info({
          agentId: this.context.id, sessionId: this.context.sessionId,
          tool: toolCall.name, toolId, durationMs: toolExecMs,
        }, 'Tool executed');

        // Phase 5: per-tool completion event so the UI can flip a row
        // from "running" to "done" as soon as the tool returns, instead
        // of waiting for the bulk `observation` emit at end-of-batch.
        // Thread 1: carry the rendered title + structured result preview.
        const completedActivity = renderToolActivity(toolCall.name, toolCall.arguments, result, true);
        this.emitFn('action', {
          type: 'tool_call_complete',
          toolCallId: toolCall.id,
          name: toolCall.name,
          role: this.context.role,
          status: 'ok',
          durationMs: toolExecMs,
          resultPreview: previewToolResult(result),
          title: completedActivity.title,
          input: completedActivity.input,
          result: completedActivity.result,
        });

        results.push({ toolCallId: toolCall.id, result });

        // Emit file change events for file-modifying operations.
        // Prefer the path the tool actually wrote to (its result), not the
        // path the agent *requested* in its arguments: write_file relocates
        // `/workspace/foo.md` into a per-session output dir and returns the
        // canonical post-relocation path. Emitting the argument path here was
        // making the UI link a file that doesn't exist there ("File not
        // found" on click). Fall back to the argument path only if the tool
        // returned no path (e.g. an error result).
        if (FILE_CHANGE_TOOLS.has(toolCall.name)) {
          const resolvedPath = resolvedFileChangePath(result);
          // Fallback for a result with no path (malformed/edge-case result):
          // mirror the helper's destination-first preference so copy/move point
          // at where the file now lives, not where it came from.
          const filePath = resolvedPath
            ?? ((toolCall.arguments.destination || toolCall.arguments.path || toolCall.arguments.source) as string | undefined);
          if (filePath) {
            agentLogger.info(
              { agentId: this.context.id, tool: toolCall.name, path: filePath },
              'Emitting file_change event',
            );
            this.emitFn('action', {
              type: 'file_change',
              action: toolCall.name.replace('filesystem__', '').replace('_file', '').replace('_directory', '_dir'),
              path: filePath,
              agentId: this.context.id,
              agentRole: this.context.role,
            });
          } else {
            agentLogger.warn(
              { agentId: this.context.id, tool: toolCall.name, args: Object.keys(toolCall.arguments) },
              'File change tool called but no path found in arguments',
            );
          }
        }

        if (tool.final) {
          this._toolsDisabled = true;
          agentLogger.info(
            { agentId: this.context.id, tool: toolCall.name },
            'Final tool executed — disabling tools for remaining iterations',
          );
        }

        const resultStr = sanitizeToolOutput(result);
        await auditRepository.logToolExecuted(
          this.context.userId,
          this.context.sessionId,
          toolCall.name,
          toolId,
          { args: toolCall.arguments, result: resultStr.slice(0, 10_000), durationMs: toolExecMs }
        );

        // Post-tool hook (fire-and-forget, can't block after execution)
        try {
          const { getHookManager } = await import('@/hooks/manager');
          const hookManager = getHookManager();
          hookManager.triggerToolHooks('tool_post', toolCall.name, toolId, toolCall.arguments, {
            output: resultStr.slice(0, 2000),
          }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in tool-executor'));
        } catch { /* hooks not ready */ }
      } catch (error) {
        const cancelled = isCancellationError(error);
        if (cancelled) {
          // Tool aborted because the agent (or an ancestor) was cancelled.
          // Not a real tool failure — log at info so cancelling a swarm
          // doesn't fill the dashboard with red error rows.
          agentLogger.info(
            { agentId: this.context.id, tool: toolCall.name, reason: (error as Error).message },
            'Tool execution cancelled'
          );
        } else {
          agentLogger.error(
            { err: error, agentId: this.context.id, tool: toolCall.name },
            'Tool execution failed'
          );
        }

        // Phase 5: surface per-tool failure too, so the UI can mark the
        // row failed before the batch finishes.
        const failedActivity = renderToolActivity(toolCall.name, toolCall.arguments);
        this.emitFn('action', {
          type: 'tool_call_complete',
          toolCallId: toolCall.id,
          name: toolCall.name,
          role: this.context.role,
          status: cancelled ? 'cancelled' : 'error',
          error: (error as Error).message,
          title: failedActivity.title,
          input: failedActivity.input,
        });

        results.push({
          toolCallId: toolCall.id,
          result: null,
          error: (error as Error).message,
        });
      }
    }

    this.emitFn('observation', { results });

    // Track consecutive tool failures
    const allFailed = results.length > 0 && results.every(r => r.error);
    const toolMessages: AgentMessage[] = [];

    if (allFailed) {
      this.consecutiveToolErrors++;
      if (this.consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
        agentLogger.warn(
          { agentId: this.context.id, consecutiveErrors: this.consecutiveToolErrors },
          'Too many consecutive tool failures — disabling tools'
        );
        this._toolsDisabled = true;
        toolMessages.push({
          role: 'system',
          content: 'The tools have failed multiple times in a row and are now unavailable. Provide the best response you can with the information you already have. Explain to the user which tools failed and why.',
          timestamp: new Date(),
        });
      }
    } else {
      this.consecutiveToolErrors = 0;
    }

    // Build tool result messages
    for (const result of results) {
      // Drop UI-only work-stream metadata (e.g. a file diff) before the result
      // reaches the model or the persisted transcript — the model already has
      // the inputs it acted on, so this would be redundant, token-costly context.
      const modelSafe = result.error || sanitizeToolOutput(stripWorkStreamMeta(result.result));
      toolMessages.push({
        role: 'tool',
        content: modelSafe,
        toolCallId: result.toolCallId,
        timestamp: new Date(),
      });

      // Persist tool result (skip for orchestrator)
      if (this.context.role !== 'orchestrator') {
        await messageRepository.create({
          sessionId: this.context.sessionId,
          role: 'tool',
          content: modelSafe,
          toolCallId: result.toolCallId,
          agentId: this.context.id,
        });
      }
    }

    return toolMessages;
  }
}
