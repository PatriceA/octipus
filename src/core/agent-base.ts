import { agentLogger } from '@/utils/logger';
import type { AgentContext, AgentMessage, AgentStatus } from './types';

// Re-export types from agent-worker that are used externally
export type AgentEventHandler = (event: AgentEvent) => void;

export interface AgentEvent {
  type: 'thought' | 'action' | 'observation' | 'error' | 'complete' | 'status_change' | 'permission_request';
  agentId: string;
  data: unknown;
  timestamp: Date;
}

/**
 * How a worker advertises its tools to the model (lazy tool discovery).
 * - `full`: advertise every registered tool's JSON schema (default, unchanged).
 * - `lazy`: advertise only the `coreToolIds` groups (plus the discovery/MCP
 *   meta-tools); the long tail stays registered/callable but unadvertised.
 * The mode is DECIDED by the worker-spawner (where model + size are known) and
 * passed in — agent-worker never re-derives it. See docs/plans/lazy-tool-discovery.md.
 */
export type ToolAdvertisement =
  | { mode: 'full' }
  | { mode: 'lazy'; coreToolIds: string[] };

export interface AgentWorkerConfig {
  maxIterations: number;
  contextWindowSize: number;
  timeout: number;
  maxTokenBudget: number;
  /** Defaults to `{ mode: 'full' }` when omitted. */
  toolAdvertisement?: ToolAdvertisement;
  /**
   * Soft cap on the number of full tool-result messages kept in context. Once
   * exceeded, the OLDEST tool outputs are truncated (recent ones kept full) —
   * cheaper + less destructive than whole-history compaction, and it triggers
   * earlier so context-overflow errors are rarer. Defaults to
   * `DEFAULT_TOOL_OUTPUT_SOFT_CAP` when omitted.
   */
  toolOutputSoftCap?: number;
}

export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  toolId?: string;
  final?: boolean;
  /** Name of the most-informative parameter for compact UI display. */
  previewParam?: string;
  /** Custom preview renderer (overrides `previewParam`). Truncated to 80 chars. */
  previewFn?: (params: Record<string, unknown>) => string;
  execute: (args: Record<string, unknown>, context: AgentContext) => Promise<unknown>;
}

export abstract class BaseAgentWorker {
  protected context: AgentContext;
  protected config: AgentWorkerConfig;
  protected messages: AgentMessage[] = [];
  protected eventHandlers: Set<AgentEventHandler> = new Set();
  protected iteration: number = 0;

  constructor(context: AgentContext, config: AgentWorkerConfig) {
    this.context = context;
    this.config = config;
  }

  abstract run(userMessage?: string): Promise<string>;
  /** Stop the worker. `reason` (manual / cascade) rides on the terminal event. */
  abstract stop(reason?: string): void;
  abstract registerTool(tool: ToolHandler): void;
  abstract registerTools(tools: ToolHandler[]): void;
  abstract addSystemMessage(content: string): void;
  abstract addUserMessage(content: string): Promise<void>;
  abstract loadHistory(): Promise<void>;

  onEvent(handler: AgentEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  protected emit(type: AgentEvent['type'], data: unknown): void {
    const event: AgentEvent = {
      type,
      agentId: this.context.id,
      data,
      timestamp: new Date(),
    };
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        agentLogger.error({ error, agentId: this.context.id }, 'Event handler error');
      }
    }
  }

  getStatus(): AgentStatus {
    return this.context.status;
  }

  getContext(): AgentContext {
    return this.context;
  }

  getIteration(): number {
    return this.iteration;
  }

  getTotalTokens(): number {
    return 0;
  }

  /**
   * Deterministic side-effect counters for this worker's run, or `null` when
   * the worker keeps no executor-level tally (e.g. CLI workers). The full
   * `AgentWorker` overrides this; the swarm spawner reads it to build a
   * receipt. Declared here so the read is type-safe and a rename breaks the
   * build rather than silently yielding `null`.
   */
  getSideEffectCounters(): import('./swarm/receipt').SideEffectCounters | null {
    return null;
  }

  getElapsedMs(): number {
    return 0;
  }
}
