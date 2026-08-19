import { coreLogger } from '@/utils/logger';
import type { AgentRole } from './types';

/**
 * Orchestrator hooks — sync/async mutable callbacks fired at fixed
 * points in the orchestrator lifecycle.
 *
 * Different from the gateway event bus (which is broadcast, immutable
 * pub/sub). Hooks let subscribers MUTATE the passed options object —
 * the persona block injection works by prepending to
 * `options.systemPrompt`. Subscribers run sequentially in registration
 * order; a thrown handler is logged and swallowed (one bad extension
 * cannot poison the orchestrator).
 *
 * Roadmap "Now" item — promoted as prerequisite for the persona
 * system and dynamic role definition.
 */

export interface BuildSystemPromptOptions {
  /** The role the prompt is being built for. */
  role: AgentRole;
  /** The user whose request is being handled. */
  userId: string;
  /** The session for this turn. */
  sessionId: string;
  /** Workspace scope inherited by children (null = no workspace). */
  workspaceId: string | null;
  /** Optional channel that delivered the message. */
  channel?: string;
  /**
   * The composed system prompt so far. Mutable — handlers may
   * prepend, append, or substring-replace. Subscribers MUST NOT
   * truncate `SECURITY_PREAMBLE` (DESIGN.md house rule #6).
   */
  systemPrompt: string;
}

/**
 * Waterfall dispatch context — around-middleware for tool execution and for
 * swarm spawns (Wave 1, "dispatch waterfall"). A `before` handler may mutate
 * the payload and may SHORT-CIRCUIT: set `shortCircuit` and no further handler
 * runs, the underlying dispatch never happens.
 *
 * Policy (permissions, quotas, sandbox selection, egress rules) belongs here as
 * a subscriber instead of another branch inside the dispatch path.
 */
export interface ShortCircuitable {
  /**
   * Set by a handler to stop the waterfall. `deny` raises a typed refusal at
   * the call site; `result` substitutes a value without executing (cache hits,
   * dry-run modes). Fail loud: a denial is never silently converted to an
   * empty success.
   */
  shortCircuit?: { deny: string } | { result: unknown };
}

/** Fired before a tool executes — after arg parsing, before permission checks. */
export interface ToolDispatchContext extends ShortCircuitable {
  /** Container id, e.g. `filesystem`. */
  toolId: string;
  /** Bare tool name within the container, e.g. `read_file`. */
  toolName: string;
  /** Mutable — a handler may rewrite args (redaction, defaulting, clamping). */
  args: Record<string, unknown>;
  /** Who is calling: user, session, role, workspace. */
  agent: HookAgentContext;
}

/** Fired after a tool executes, on every outcome including denial. */
export interface ToolResultContext {
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  agent: HookAgentContext;
  status: 'success' | 'error' | 'cancelled' | 'denied';
  /** Mutable on success — the DSH `finalizeContent` seam. */
  result?: unknown;
  error?: unknown;
  durationMs: number;
}

/** Fired before a swarm child is spawned — before depth/role/budget guards. */
export interface SpawnDispatchContext extends ShortCircuitable {
  parentNodeId: string;
  parentRole: string;
  /** Depth of the CHILD being spawned (1 = agent, 2 = subagent). */
  childDepth: number;
  childRole: string;
  /** Slash-joined lineage, e.g. `research / pricing / eu`. */
  topicPath: string;
  /** True when the parent supplied an explicit step plan. */
  planned: boolean;
  agent: HookAgentContext;
}

/** Fired after a swarm child settles (or is denied). */
export interface SpawnResultContext {
  parentNodeId: string;
  childRole: string;
  childDepth: number;
  status: 'completed' | 'denied' | 'failed';
  /** Denial or failure reason; absent on success. */
  reason?: string;
  durationMs: number;
}

/**
 * The caller identity carried through the waterfall. Structural on purpose —
 * hooks.ts stays free of imports from `@/core/types` and `@/core/swarm` so any
 * subsystem can subscribe without an import cycle.
 */
export interface HookAgentContext {
  userId: string;
  sessionId: string;
  role?: string;
  workspaceId?: string | null;
  metadata?: Record<string, unknown>;
}

export type HookHandler<T> = (ctx: T) => Promise<void> | void;

export type OrchestratorHookEvents = {
  'before-agent-start': BuildSystemPromptOptions;
  'tool:before': ToolDispatchContext;
  'tool:after': ToolResultContext;
  'spawn:before': SpawnDispatchContext;
  'spawn:after': SpawnResultContext;
};

export type OrchestratorHookEvent = keyof OrchestratorHookEvents;

class OrchestratorHookRegistry {
  private handlers: Map<OrchestratorHookEvent, HookHandler<unknown>[]> = new Map();

  register<E extends OrchestratorHookEvent>(
    event: E,
    handler: HookHandler<OrchestratorHookEvents[E]>,
  ): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    const arr = this.handlers.get(event)!;
    arr.push(handler as HookHandler<unknown>);
    return () => {
      const list = this.handlers.get(event);
      if (!list) return;
      const idx = list.indexOf(handler as HookHandler<unknown>);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  async fire<E extends OrchestratorHookEvent>(
    event: E,
    ctx: OrchestratorHookEvents[E],
  ): Promise<OrchestratorHookEvents[E]> {
    const list = this.handlers.get(event);
    if (!list || list.length === 0) return ctx;
    for (const handler of list) {
      try {
        await handler(ctx as unknown);
      } catch (err) {
        coreLogger.error({ err, event }, 'orchestrator hook handler failed — continuing');
      }
    }
    return ctx;
  }

  /**
   * Waterfall dispatch — around-middleware semantics, for the events whose
   * payload is `ShortCircuitable`.
   *
   * Two differences from `fire`, both deliberate:
   *
   * - **Fail closed.** A throwing handler ABORTS the dispatch instead of being
   *   logged and swallowed. These handlers are policy; a permission check that
   *   crashes must not read as "allowed". `fire` keeps its swallow-and-continue
   *   behavior for observational events.
   * - **Short circuit.** The first handler to set `ctx.shortCircuit` ends the
   *   chain, and the call site skips the underlying work.
   */
  async fireWaterfall<E extends OrchestratorHookEvent>(
    event: E,
    ctx: OrchestratorHookEvents[E] & ShortCircuitable,
  ): Promise<OrchestratorHookEvents[E] & ShortCircuitable> {
    const list = this.handlers.get(event);
    if (!list || list.length === 0) return ctx;
    // Snapshot: a handler may unregister itself (or a sibling) mid-chain.
    for (const handler of [...list]) {
      await handler(ctx as unknown);
      if (ctx.shortCircuit) {
        coreLogger.debug({ event, shortCircuit: ctx.shortCircuit }, 'hook short-circuited dispatch');
        break;
      }
    }
    return ctx;
  }

  /** Test hook — remove every subscriber. */
  _clearForTesting(): void {
    this.handlers.clear();
  }

  /** Count handlers registered for an event (test helper). */
  _count(event: OrchestratorHookEvent): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}

let instance: OrchestratorHookRegistry | null = null;
export function getOrchestratorHooks(): OrchestratorHookRegistry {
  if (!instance) instance = new OrchestratorHookRegistry();
  return instance;
}
