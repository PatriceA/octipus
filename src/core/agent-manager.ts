import { AgentWorker, type AgentWorkerConfig, type ToolHandler, type AgentEvent } from './agent-worker';
import { CLIAgentWorker } from './cli-agent-worker';
import { isCLIProvider } from './cli-agent-factory';
import { getRouter } from './router';
import { getScheduler } from './scheduler';
import { getModelRegistry } from '@/models/model-registry';
import { sessionRepository } from '@/db/repositories/session-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { agentRepository } from '@/db/repositories/agent-repository';
import { agentEventRepository } from '@/db/repositories/agent-event-repository';
import { getConfig } from '@/config';
import { agentLogger } from '@/utils/logger';
import { generateId } from '@/utils/crypto';
import type { AgentContext, AgentStatus } from './types';

/** Union type for all agent worker implementations */
export type AnyAgentWorker = AgentWorker | CLIAgentWorker;

export interface SpawnOptions {
  sessionId: string;
  userId: string;
  topic?: string;
  model?: string;
  role?: string;
  systemPrompt?: string;
  tools?: ToolHandler[];
  timeout?: number;
  maxIterations?: number;
  maxTokenBudget?: number;
}

export interface AgentInfo {
  id: string;
  sessionId: string;
  userId: string;
  topic: string;
  model: string;
  role: string;
  status: AgentStatus;
  createdAt: Date;
  iteration: number;
}

/** Buffered event with sequential ID for polling cursor */
export interface BufferedEvent {
  seq: number;
  event: AgentEvent;
}

export class AgentManager {
  private agents: Map<string, AnyAgentWorker> = new Map();
  private eventHandlers: Set<(event: AgentEvent) => void> = new Set();
  private globalTools: Map<string, ToolHandler> = new Map();
  /** Per-agent event ring buffer for polling (max 200 events per agent) */
  private eventBuffers: Map<string, BufferedEvent[]> = new Map();
  private eventSeqCounter: number = 0;
  private static MAX_BUFFERED_EVENTS = 200;

  /**
   * Register a global tool available to all agents
   */
  registerGlobalTool(tool: ToolHandler): void {
    this.globalTools.set(tool.name, tool);
    agentLogger.info({ tool: tool.name }, 'Global tool registered');
  }

  /**
   * Spawn a new agent
   */
  async spawn(options: SpawnOptions): Promise<AnyAgentWorker> {
    // Check concurrency limit
    const runningAgents = Array.from(this.agents.values()).filter(
      (a) => a.getStatus() === 'running'
    );

    const maxConcurrent = getConfig().agent.maxConcurrentAgents;
    if (runningAgents.length >= maxConcurrent) {
      throw new Error(`Maximum concurrent agents (${maxConcurrent}) reached`);
    }

    const config = getConfig();

    // If both topic and model are already specified, skip re-routing
    // (the caller has already routed, e.g. spawnWorker)
    let routedTopic = options.topic || 'general';
    let routedModel = options.model || '';

    if (!options.model) {
      // Only route if model isn't pre-determined
      const router = getRouter();
      const routing = await router.route(options.topic || '');
      routedTopic = routing.topic;
      routedModel = routing.model;
    }

    const agentId = generateId();

    const context: AgentContext = {
      id: agentId,
      sessionId: options.sessionId,
      userId: options.userId,
      topic: routedTopic,
      model: routedModel,
      role: options.role || 'general',
      status: 'idle',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {},
    };

    const workerConfig: AgentWorkerConfig = {
      maxIterations: options.maxIterations ?? config.agent.maxIterations,
      contextWindowSize: config.agent.contextWindowSize,
      timeout: options.timeout ?? config.agent.defaultTimeout,
      maxTokenBudget: options.maxTokenBudget ?? config.agent.maxTokenBudget,
    };

    // Determine if this is a CLI model (autonomous sub-agent)
    const registry = getModelRegistry();
    const modelEntry = await registry.getModelByModelId(routedModel);
    const isCLI = modelEntry ? isCLIProvider(modelEntry.provider) : false;

    let worker: AnyAgentWorker;

    if (isCLI) {
      worker = new CLIAgentWorker(context, workerConfig);
      agentLogger.info(
        { agentId, model: routedModel },
        'Spawning CLI sub-agent (autonomous mode)',
      );
    } else {
      worker = new AgentWorker(context, workerConfig);
    }

    // Register global tools (no-op for CLI workers)
    for (const tool of this.globalTools.values()) {
      worker.registerTool(tool);
    }

    // Register agent-specific tools (no-op for CLI workers)
    if (options.tools) {
      worker.registerTools(options.tools);
    }

    // Subscribe to events: buffer for polling + persist to DB + forward to manager handlers
    worker.onEvent((event) => {
      // Buffer the event for polling
      const buffered: BufferedEvent = { seq: ++this.eventSeqCounter, event };
      let buf = this.eventBuffers.get(agentId);
      if (!buf) {
        buf = [];
        this.eventBuffers.set(agentId, buf);
      }
      buf.push(buffered);
      // Trim ring buffer
      if (buf.length > AgentManager.MAX_BUFFERED_EVENTS) {
        buf.splice(0, buf.length - AgentManager.MAX_BUFFERED_EVENTS);
      }

      // Persist to DB (fire-and-forget) — survives server restarts
      agentEventRepository.create({
        agentId: event.agentId,
        sessionId: context.sessionId,
        type: event.type,
        data: event.data,
      }).catch(() => {});

      // Forward to WebSocket / other handlers
      for (const handler of this.eventHandlers) {
        handler(event);
      }
    });

    // Load conversation history BEFORE adding system prompt
    // (loadHistory replaces this.messages, so system prompt must come after)
    await worker.loadHistory();

    // Add system prompt if provided
    if (options.systemPrompt) {
      worker.addSystemMessage(options.systemPrompt);
    }

    // Store the worker
    this.agents.set(agentId, worker);

    // Merge into session context (preserve devMode, projectPath, etc.)
    const existingSession = await sessionRepository.findById(options.sessionId);
    const existingCtx = (existingSession?.context as Record<string, unknown>) || {};
    await sessionRepository.update(options.sessionId, {
      context: { ...existingCtx, activeAgentId: agentId, currentTopic: routedTopic },
    });

    // Log audit
    await auditRepository.logAgentSpawned(
      options.userId,
      options.sessionId,
      agentId,
      routedTopic
    );

    // Persist agent snapshot to DB
    agentRepository.create({
      id: agentId,
      sessionId: options.sessionId,
      userId: options.userId,
      role: options.role || 'general',
      model: routedModel,
      topic: routedTopic,
      status: 'running',
    }).catch(err => agentLogger.error({ err, agentId }, 'Failed to persist agent record'));

    agentLogger.info(
      { agentId, sessionId: options.sessionId, model: routedModel, topic: routedTopic },
      'Agent spawned'
    );

    return worker;
  }

  /**
   * Get an agent by ID
   */
  get(agentId: string): AnyAgentWorker | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all agents for a session
   */
  getBySession(sessionId: string): AnyAgentWorker[] {
    return Array.from(this.agents.values()).filter(
      (a) => a.getContext().sessionId === sessionId
    );
  }

  /**
   * Get all agents for a user
   */
  getByUser(userId: string): AnyAgentWorker[] {
    return Array.from(this.agents.values()).filter(
      (a) => a.getContext().userId === userId
    );
  }

  /**
   * Stop an agent
   */
  stop(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.stop();
      agentLogger.info({ agentId }, 'Agent stopped');
      return true;
    }
    // Agent not in memory — may be a zombie DB record. Mark it as stopped.
    agentRepository.updateStatus(agentId, { status: 'stopped', error: 'Stopped manually (not in memory)' })
      .catch(err => agentLogger.error({ err, agentId }, 'Failed to update zombie agent status'));
    return true;
  }

  /**
   * Stop all running agents (used during shutdown)
   */
  stopAll(): void {
    for (const [id, agent] of this.agents) {
      if (agent.getStatus() === 'running') {
        try {
          agent.stop();
          agentLogger.info({ agentId: id }, 'Agent stopped during shutdown');
        } catch {
          // Best effort
        }
      }
    }
  }

  /**
   * Remove an agent (clean up)
   */
  remove(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (agent) {
      if (agent.getStatus() === 'running') {
        agent.stop();
      }
      this.agents.delete(agentId);
      this.eventBuffers.delete(agentId);
      agentLogger.info({ agentId }, 'Agent removed');
      return true;
    }
    return false;
  }

  /**
   * Stop all agents for a session
   */
  stopSession(sessionId: string): number {
    const agents = this.getBySession(sessionId);
    let count = 0;
    for (const agent of agents) {
      if (this.stop(agent.getContext().id)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Stop all agents for a user
   */
  stopUser(userId: string): number {
    const agents = this.getByUser(userId);
    let count = 0;
    for (const agent of agents) {
      if (this.stop(agent.getContext().id)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get info about all agents
   */
  list(): AgentInfo[] {
    return Array.from(this.agents.values()).map((worker) => {
      const context = worker.getContext();
      return {
        id: context.id,
        sessionId: context.sessionId,
        userId: context.userId,
        topic: context.topic,
        model: context.model,
        role: context.role,
        status: context.status,
        createdAt: context.createdAt,
        iteration: worker.getIteration(),
      };
    }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Get running agents count
   */
  getRunningCount(): number {
    return Array.from(this.agents.values()).filter(
      (a) => a.getStatus() === 'running'
    ).length;
  }

  /**
   * Get buffered events for an agent, optionally filtered by cursor.
   * Returns events with seq > afterSeq (or all if afterSeq is 0).
   */
  getEvents(agentId: string, afterSeq: number = 0): BufferedEvent[] {
    const buf = this.eventBuffers.get(agentId);
    if (!buf) return [];
    if (afterSeq === 0) return buf;
    return buf.filter(e => e.seq > afterSeq);
  }

  /**
   * Subscribe to agent events
   */
  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Clean up completed/failed agents older than maxAge
   */
  cleanup(maxAgeMs: number = 3600000): number {
    const now = Date.now();
    let count = 0;

    for (const [id, worker] of this.agents) {
      const context = worker.getContext();
      const status = worker.getStatus();

      if (
        (status === 'completed' || status === 'failed' || status === 'stopped') &&
        now - context.updatedAt.getTime() > maxAgeMs
      ) {
        this.agents.delete(id);
        this.eventBuffers.delete(id);
        count++;
      }
    }

    if (count > 0) {
      agentLogger.info({ count }, 'Cleaned up old agents');
    }

    return count;
  }

  /**
   * Start periodic cleanup
   */
  startPeriodicCleanup(intervalMs: number = 300000): () => void {
    const interval = setInterval(() => this.cleanup(), intervalMs);
    return () => clearInterval(interval);
  }
}

// Singleton instance
let managerInstance: AgentManager | null = null;

export function getAgentManager(): AgentManager {
  if (!managerInstance) {
    managerInstance = new AgentManager();
  }
  return managerInstance;
}
