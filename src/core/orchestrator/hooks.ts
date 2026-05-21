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

export type HookHandler<T> = (ctx: T) => Promise<void> | void;

export type OrchestratorHookEvents = {
  'before-agent-start': BuildSystemPromptOptions;
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
