import { getGateway } from '@/core/gateway';
import { startServer } from '@/api/server';
import { initializeChannels } from '@/channels';
import { registerBuiltinTools } from '@/tools';
import { seedSkills } from '@/db/seed-skills';
import { getMCPBridge } from '@/mcp/bridge';
import { getHookManager } from '@/hooks/manager';
import { initializeVault } from '@/security/vault';
import { seedPresetTemplates } from '@/db/seed-presets';
import { seedExperts } from '@/db/seed-experts';
import { getSettingsService } from '@/config/settings-service';
import { migrateEnvToDb } from '@/config/migrate-env-to-db';
import { loadRuntimeConfig } from '@/config';
import { initializeHotReload } from '@/config/hot-reload';
import { startCronLoop, stopCronLoop } from '@/core/cron-runner';
import { getGatewayHub } from '@/core/gateway/hub';
import { connectEventBridge } from '@/core/gateway/event-bridge';
import { wireMessageHandler } from '@/core/gateway/message-handler';
import { logger } from '@/utils/logger';

async function main() {
  logger.info('Starting Assistant...');

  try {
    // Initialize gateway (database, redis, etc.) — uses bootstrap config from .env
    const gateway = getGateway();
    await gateway.start();

    // Seed system data (migrations already ran inside gateway.start())
    await seedPresetTemplates();
    await seedSkills();
    await seedExperts();
    logger.info('System data seeded');

    // Initialize vault (needs master key from .env)
    await initializeVault();
    logger.info('Vault initialized');

    // One-time migration: move .env values into DB settings + vault
    await migrateEnvToDb();

    // Initialize settings service: warm cache from DB
    const settingsService = getSettingsService();
    await settingsService.initialize();
    logger.info('Settings service initialized');

    // Load runtime config from DB settings (replaces env-based config)
    await loadRuntimeConfig();
    logger.info('Runtime configuration loaded');

    // Subscribe to settings changes for hot-reload
    initializeHotReload();

    // Clean up any agents left "running" from a previous process
    const { agentRepository } = await import('@/db/repositories/agent-repository');
    const staleCount = await agentRepository.cleanupStale();
    if (staleCount > 0) {
      logger.info({ staleCount }, 'Cleaned up stale agent records from previous run');
    }

    // Register built-in tools
    await registerBuiltinTools();
    logger.info('Tools registered');

    // Connect to MCP servers
    const mcpBridge = getMCPBridge();
    await mcpBridge.connectAll();
    logger.info('MCP servers connected');

    // Load hooks
    const hookManager = getHookManager();
    await hookManager.loadHooks();
    logger.info('Hooks loaded');

    // Initialize messaging channels (reads config from DB now)
    await initializeChannels();
    logger.info('Channels initialized');

    // Start gateway hub (unified WebSocket protocol)
    const gatewayHub = getGatewayHub();
    await gatewayHub.start();
    logger.info('Gateway hub started');

    // Wire gateway message handler and bridge orchestrator/agent events
    wireMessageHandler(gatewayHub);
    const disconnectBridge = connectEventBridge(gatewayHub);

    // Start API server
    await startServer();
    logger.info('API server started');

    // Start recurring task scheduler
    startCronLoop();
    logger.info('Cron scheduler started');

    logger.info('Assistant started successfully');

    // Handle graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down...');

      // Stop all running agents (kills CLI child processes)
      try {
        const { getAgentManager } = await import('@/core/agent-manager');
        const agentManager = getAgentManager();
        agentManager.stopAll();
        logger.info('All agents stopped');
      } catch {
        // Agent manager may not be initialized
      }

      stopCronLoop();
      disconnectBridge();
      await gatewayHub.stop();
      await mcpBridge.disconnectAll();
      await gateway.stop();

      logger.info('Shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    logger.error({ error }, 'Failed to start Assistant');
    process.exit(1);
  }
}

main();
