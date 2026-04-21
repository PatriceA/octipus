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

export interface AgentWorkerConfig {
  maxIterations: number;
  contextWindowSize: number;
  timeout: number;
  maxTokenBudget: number;
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
  abstract stop(): void;
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

  getElapsedMs(): number {
    return 0;
  }
}
