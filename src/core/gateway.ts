import { initializeDb, closeDb, initializeExtensions, checkDbHealth } from '@/db/postgres';
import { checkRedisHealth } from '@/db/redis';
import { initializeStorage, closeStorage } from '@/db/storage';
import { runMigrations } from '@/db/migrate';
import { loadConfig, getConfig } from '@/config';
import { getAgentManager, type AgentInfo } from './agent-manager';
import { getModelRegistry } from '@/models/model-registry';
import { getHealthChecker } from '@/models/health-checker';
import { coreLogger } from '@/utils/logger';
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

      // Initialize storage provider (Redis or in-memory)
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

      // Set up graceful shutdown
      this.setupShutdownHandlers();

      this.state = 'running';
      this.startedAt = new Date();

      coreLogger.info('Gateway started successfully');
    } catch (error) {
      this.state = 'stopped';
      coreLogger.error({ error }, 'Failed to start gateway');
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

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
      coreLogger.error({ error }, 'Uncaught exception');
      shutdown('uncaughtException').catch(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason) => {
      coreLogger.error({ reason }, 'Unhandled rejection');
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
