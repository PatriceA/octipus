import { getConfig } from '@/config';
import { agentEventRepository } from '@/db/repositories/agent-event-repository';
import { agentRepository } from '@/db/repositories/agent-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { getModelRegistry } from '@/models/model-registry';
import { generateId } from '@/utils/crypto';
import { agentLogger, coreLogger } from '@/utils/logger';
import { type AgentEvent, AgentWorker, type AgentWorkerConfig, type ToolHandler } from './agent-worker';
import { isCLIProvider } from './cli-agent-factory';
import { CLIAgentWorker } from './cli-agent-worker';
import { getRouter } from './router';
import type { AgentContext, AgentStatus } from './types';

/** Union type for all agent worker implementations */
export type AnyAgentWorker = AgentWorker | CLIAgentWorker;

export interface SpawnOptions {
  sessionId: string;
  userId: string;
  /** Workspace UUID for multi-tenant scoping (memory-redesign Phase B). */
  workspaceId?: string | null;
  topic?: string;
  model?: string;
  role?: string;
  systemPrompt?: string;
  tools?: ToolHandler[];
  timeout?: number;
  maxIterations?: number;
  maxTokenBudget?: number;
  /** Parent AbortSignal — the spawned worker aborts when this does (Swarm Phase 2). */
  parentSignal?: AbortSignal;
  /** Parent agent id (Swarm Phase 2). Used by `stop(id,{cascade:true})` to walk descendants. */
  parentAgentId?: string;
  /** Seed metadata on the agent context (e.g. `originalRequest`). */
  contextMetadata?: Record<string, unknown>;
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
  /** Set once the agent reached a terminal state. Undefined while running. */
  completedAt?: Date;
  /** Frozen at terminal-state transition; for running agents this is the live elapsed time. */
  durationMs?: number;
  totalTokens?: number;
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
   * Swarm Phase 2: parent → children index for cascade cancellation.
   * Populated by `spawn()` when `parentAgentId` is provided.
   * `stop(id, {cascade:true})` walks this to abort descendants transitively.
   */
  private childrenByParent: Map<string, Set<string>> = new Map();

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

    // Per-user concurrency quota for real users (system/local jobs rely on
    // the global cap above). Throws QuotaExceededError (distinct from the
    // global cap's plain Error) so callers can distinguish.
    if (
      options.userId
      && options.userId !== 'system'
      && options.userId !== 'local'
    ) {
      const { getQuotaManager } = await import('@/security/quotas');
      const check = await getQuotaManager().willExceed(options.userId, 'concurrentAgents', 1);
      if (!check.allowed) {
        const { QuotaExceededError } = await import('@/security/quota-error');
        throw new QuotaExceededError({ ...check.reason, userId: options.userId });
      }
    }

    const config = getConfig();

    // If both topic and model are already specified, skip re-routing
    // (the caller has already routed, e.g. SwarmSpawner or internal spawnWorker)
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
      workspaceId: options.workspaceId ?? null,
      topic: routedTopic,
      model: routedModel,
      role: options.role || 'general',
      status: 'idle',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: { ...(options.contextMetadata ?? {}) },
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
      worker = new CLIAgentWorker(context, workerConfig, { parentSignal: options.parentSignal });
      agentLogger.info(
        { agentId, model: routedModel },
        'Spawning CLI sub-agent (autonomous mode)',
      );
    } else {
      // Swarm Phase 2: chain parent AbortSignal into the worker.
      worker = new AgentWorker(context, workerConfig, { parentSignal: options.parentSignal });
    }

    // Swarm Phase 2: track parent→child edges for cascade cancel.
    if (options.parentAgentId) {
      let set = this.childrenByParent.get(options.parentAgentId);
      if (!set) {
        set = new Set();
        this.childrenByParent.set(options.parentAgentId, set);
      }
      set.add(agentId);
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
      }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in agent-manager'));

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

    // Persist agent snapshot to DB. Pass the in-memory context.createdAt
    // explicitly — the column default (NOW()) fires at *insert* time, which
    // for a fire-and-forget call can land seconds after the agent actually
    // started, and it has historically disagreed with the JS clock by one
    // hour (timezone interpretation). Awaiting also makes ordering vs. the
    // user-message insert deterministic.
    try {
      await agentRepository.create({
        id: agentId,
        sessionId: options.sessionId,
        userId: options.userId,
        role: options.role || 'general',
        model: routedModel,
        topic: routedTopic,
        status: 'running',
        createdAt: context.createdAt,
      });
    } catch (err) {
      agentLogger.error({ err, agentId }, 'Failed to persist agent record');
    }

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
   * Stop an agent.
   *
   * Swarm Phase 2: `cascade: true` walks the in-memory parent→child index
   * and DB `swarm_nodes.parent_node_id` to stop every descendant. Default
   * cascade when the agent has a swarm node (any agent spawned with
   * `parentAgentId`). CLI-triggered root cancel (`gateway agent.stop`) should
   * pass `cascade: true` explicitly.
   */
  stop(agentId: string, opts: { cascade?: boolean } = {}): boolean {
    const agent = this.agents.get(agentId);
    const cascade = opts.cascade ?? false;

    // Stop the local agent.
    if (agent) {
      agent.stop();
      agentLogger.info({ agentId, cascade }, 'Agent stopped');
    } else {
      // Agent not in memory — may be a zombie DB record. Mark it as stopped.
      agentRepository.updateStatus(agentId, { status: 'stopped', error: 'Stopped manually (not in memory)' })
        .catch(err => agentLogger.error({ err, agentId }, 'Failed to update zombie agent status'));
    }

    if (!cascade) return true;

    // ── Cascade: in-memory children first (synchronous) ──────────────
    const directChildren = this.childrenByParent.get(agentId);
    if (directChildren && directChildren.size > 0) {
      for (const childId of directChildren) {
        // Recurse — each child cascades in turn.
        this.stop(childId, { cascade: true });
      }
      this.childrenByParent.delete(agentId);
    }

    // ── Cascade: DB descendants (handles cross-process zombies) ──────
    // Fire-and-forget — best-effort cleanup for agents no longer in memory.
    void this.cascadeStopFromDb(agentId);

    return true;
  }

  /**
   * Walk `swarm_nodes` transitively and stop every descendant. Silent
   * best-effort (no throw) because the swarm schema is optional — agents
   * that never joined a swarm have no rows and this is a no-op.
   */
  private async cascadeStopFromDb(rootAgentId: string): Promise<void> {
    try {
      const { swarmNodeRepository } = await import('./swarm/node-repository');
      const { getDb } = await import('@/db/postgres');
      const { swarmNodes } = await import('@/db/schema/swarm-nodes');
      const { eq } = await import('drizzle-orm');

      const visited = new Set<string>([rootAgentId]);
      const queue: string[] = [rootAgentId];
      while (queue.length > 0) {
        const parentId = queue.shift()!;
        const children = await getDb()
          .select()
          .from(swarmNodes)
          .where(eq(swarmNodes.parentNodeId, parentId));
        for (const row of children) {
          if (visited.has(row.id)) continue;
          visited.add(row.id);
          queue.push(row.id);

          // Stop in-memory worker if still present (no recurse — DB walk is
          // already transitive).
          const worker = this.agents.get(row.id);
          if (worker) {
            try { worker.stop(); } catch { /* best effort */ }
          }
          // Mark row as cancelled.
          try {
            await swarmNodeRepository.updateStatus(row.id, {
              status: 'cancelled',
              error: 'cascade_cancelled_from_ancestor',
            });
          } catch { /* best effort */ }
        }
      }
    } catch (err) {
      agentLogger.debug({ err, rootAgentId }, 'cascadeStopFromDb skipped');
    }
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
      this.childrenByParent.delete(agentId);
      // Remove self from any parent's children set.
      for (const set of this.childrenByParent.values()) set.delete(agentId);
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
      // For finished agents still in memory, freeze duration to completedAt-createdAt.
      // For running agents, fall back to the worker's live elapsed time so the UI
      // ticks. Without this, finished-but-not-yet-cleaned agents reported `0ms`
      // because the route only had createdAt to work with.
      const durationMs = context.completedAt
        ? context.completedAt.getTime() - context.createdAt.getTime()
        : worker.getElapsedMs();
      return {
        id: context.id,
        sessionId: context.sessionId,
        userId: context.userId,
        topic: context.topic,
        model: context.model,
        role: context.role,
        status: context.status,
        createdAt: context.createdAt,
        completedAt: context.completedAt,
        durationMs,
        totalTokens: worker.getTotalTokens(),
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
