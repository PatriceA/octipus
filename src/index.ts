import { getGateway } from '@/core/gateway';
import { startServer } from '@/api/server';
import { initializeChannels } from '@/channels';
import { registerBuiltinSkills } from '@/skills';
import { getMCPBridge } from '@/mcp/bridge';
import { getHookManager } from '@/hooks/manager';
import { initializeVault } from '@/security/vault';
import { runMigrations } from '@/db/migrate';
import { seedPresetTemplates } from '@/db/seed-presets';
import { logger } from '@/utils/logger';

async function main() {
  logger.info('Starting Assistant...');

  try {
    // Initialize gateway (database, redis, etc.)
    const gateway = getGateway();
    await gateway.start();

    // Run database migrations
    await runMigrations();
    logger.info('Migrations complete');

    // Seed preset data
    await seedPresetTemplates();
    logger.info('Presets seeded');

    // Initialize vault
    await initializeVault();
    logger.info('Vault initialized');

    // Register built-in skills
    await registerBuiltinSkills();
    logger.info('Skills registered');

    // Connect to MCP servers
    const mcpBridge = getMCPBridge();
    await mcpBridge.connectAll();
    logger.info('MCP servers connected');

    // Load hooks
    const hookManager = getHookManager();
    await hookManager.loadHooks();
    logger.info('Hooks loaded');

    // Initialize messaging channels
    await initializeChannels();
    logger.info('Channels initialized');

    // Start API server
    await startServer();
    logger.info('API server started');

    logger.info('Assistant started successfully');

    // Handle graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down...');

      hookManager.cleanup();
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
