import { getConfig, loadConfig } from '@/config';
import { runKBSelfCheck } from '@/core/rag/health';
import { runMigrations } from '@/db/migrate';
import { checkDbHealth, closeDb, initializeDb, initializeExtensions } from '@/db/postgres';
import { checkRedisHealth } from '@/db/redis';
import { closeStorage, initializeStorage } from '@/db/storage';
import { getHealthChecker } from '@/models/health-checker';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { type AgentInfo, getAgentManager } from './agent-manager';
import type { HealthStatus } from './types';

export interface GatewayStatus {
  state: 'starting' | 'running' | 'stopping' | 'stopped';
  startedAt?: Date;
  uptime?: number;
  agents: AgentInfo[];
  health: {
    database: HealthStatus;
    redis: HealthStatus;
    models: HealthStatus;
  };
}

export class Gateway {
  private state: GatewayStatus['state'] = 'stopped';
  private startedAt?: Date;
  private cleanupHandlers: (() => void)[] = [];
  private shutdownPromise?: Promise<void>;

  /**
   * Start the gateway
   */
  async start(): Promise<void> {
    if (this.state === 'running') {
      coreLogger.warn('Gateway is already running');
      return;
    }

    this.state = 'starting';
    coreLogger.info('Starting gateway...');

    try {
      // Load configuration
      loadConfig();
      const config = getConfig();
      const storageMode = config.storageMode || 'external';
      coreLogger.info({ storageMode }, 'Configuration loaded');

      // Initialize storage provider (Valkey or in-memory)
      initializeStorage({
        mode: storageMode,
        redis: storageMode === 'external' ? config.redis : undefined,
      });
      coreLogger.info({ mode: storageMode }, 'Storage initialized');

      // Initialize database (PostgreSQL or PGlite)
      await initializeDb();
      await initializeExtensions();
      coreLogger.info({ mode: storageMode }, 'Database initialized');

      // Run migrations before any queries
      await runMigrations();
      coreLogger.info('Migrations complete');

      // Initialize model registry
      getModelRegistry();
      coreLogger.info('Model registry initialized');

      // Start health checker
      const healthChecker = getHealthChecker();
      healthChecker.startPeriodicChecks();
      this.cleanupHandlers.push(() => healthChecker.stopPeriodicChecks());

      // Initialize agent manager
      const agentManager = getAgentManager();
      const cleanupAgents = agentManager.startPeriodicCleanup();
      this.cleanupHandlers.push(cleanupAgents);

      // Knowledge-base self-check: verify DB + embedding provider + vector
      // store write path before marking the gateway ready. Never blocks
      // startup — a failure here surfaces via LOUD log + KB endpoints return
      // 503 until the user fixes the config.
      try {
        await runKBSelfCheck();
      } catch (err) {
        coreLogger.error({ err }, 'KB self-check threw unexpectedly — continuing startup; KB endpoints will 503');
      }

      // Set up graceful shutdown
      this.setupShutdownHandlers();

      this.state = 'running';
      this.startedAt = new Date();

      coreLogger.info('Gateway started successfully');
    } catch (error) {
      this.state = 'stopped';
      coreLogger.error(
        {
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          errorName: error instanceof Error ? error.name : undefined,
        },
        'Failed to start gateway',
      );
      throw error;
    }
  }

  /**
   * Stop the gateway
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') {
      return this.shutdownPromise;
    }

    this.state = 'stopping';
    coreLogger.info('Stopping gateway...');

    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    try {
      // Run cleanup handlers
      for (const handler of this.cleanupHandlers) {
        try {
          handler();
        } catch (error) {
          coreLogger.error({ error }, 'Cleanup handler error');
        }
      }
      this.cleanupHandlers = [];

      // Stop all running agents
      const agentManager = getAgentManager();
      const agents = agentManager.list();
      for (const agent of agents) {
        if (agent.status === 'running') {
          agentManager.stop(agent.id);
        }
      }

      // Close database and storage connections
      await closeDb();
      await closeStorage();

      this.state = 'stopped';
      coreLogger.info('Gateway stopped');
    } catch (error) {
      coreLogger.error({ error }, 'Error during shutdown');
      this.state = 'stopped';
    }
  }

  /**
   * Set up graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      coreLogger.info({ signal }, 'Received shutdown signal');
      await this.stop();
      process.exit(0);
    };

    // When the process entrypoint (src/index.ts) owns signal handling it sets
    // OCTIPUS_SIGNALS_OWNED and runs a more complete shutdown that also calls
    // gateway.stop(). Registering our own SIGTERM/SIGINT there would race two
    // exit(0)s and truncate the other handler's async cleanup, so we skip them
    // and only install the process-global safety nets below. Standalone callers
    // (no entrypoint) still get graceful signal handling.
    if (process.env.OCTIPUS_SIGNALS_OWNED !== '1') {
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    }

    process.on('uncaughtException', (error) => {
      coreLogger.error({ error }, 'Uncaught exception');
      shutdown('uncaughtException').catch(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason) => {
      // Surface loudly with the rejection value and a stack when present. We
      // deliberately do NOT crash: a long-running multi-channel server should
      // not be taken down by a single stray rejection, but the error-level log
      // ensures the failure is visible rather than silently swallowed.
      const err = reason instanceof Error ? reason : new Error(String(reason));
      coreLogger.error({ err, stack: err.stack }, 'Unhandled promise rejection');
    });
  }

  /**
   * Get gateway status
   */
  async getStatus(): Promise<GatewayStatus> {
    const agentManager = getAgentManager();

    const [dbHealth, redisHealth] = await Promise.all([
      checkDbHealth(),
      checkRedisHealth(),
    ]);

    return {
      state: this.state,
      startedAt: this.startedAt,
      uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : undefined,
      agents: agentManager.list(),
      health: {
        database: {
          service: 'database',
          status: dbHealth.healthy ? 'healthy' : 'unhealthy',
          latency: dbHealth.latency,
          message: dbHealth.error,
          lastChecked: new Date(),
        },
        redis: {
          service: 'redis',
          status: redisHealth.healthy ? 'healthy' : 'unhealthy',
          latency: redisHealth.latency,
          message: redisHealth.error,
          lastChecked: new Date(),
        },
        models: {
          service: 'models',
          status: 'healthy', // Will be updated by health checker
          lastChecked: new Date(),
        },
      },
    };
  }

  /**
   * Check if gateway is running
   */
  isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Get current state
   */
  getState(): GatewayStatus['state'] {
    return this.state;
  }

  /**
   * Get uptime in milliseconds
   */
  getUptime(): number {
    return this.startedAt ? Date.now() - this.startedAt.getTime() : 0;
  }
}

// Singleton instance
let gatewayInstance: Gateway | null = null;

export function getGateway(): Gateway {
  if (!gatewayInstance) {
    gatewayInstance = new Gateway();
  }
  return gatewayInstance;
}
