import { startServer } from '@/api/server';
import { initializeChannels } from '@/channels';
import { loadRuntimeConfig } from '@/config';
import { initializeHotReload } from '@/config/hot-reload';
import { migrateEnvToDb } from '@/config/migrate-env-to-db';
import { getSettingsService } from '@/config/settings-service';
import { startCronLoop, stopCronLoop } from '@/core/cron-runner';
import { getGateway } from '@/core/gateway';
import { connectEventBridge } from '@/core/gateway/event-bridge';
import { getGatewayHub } from '@/core/gateway/hub';
import { wireMessageHandler } from '@/core/gateway/message-handler';
import { seedExperts } from '@/db/seed-experts';
import { seedPresetTemplates } from '@/db/seed-presets';
import { loadRolesFromDb, seedRoles } from '@/db/seed-roles';
import { seedSkillTopicAssignments } from '@/db/seed-skill-topic-assignments';
import { seedSkills } from '@/db/seed-skills';
import { getHookManager } from '@/hooks/manager';
import { getMCPBridge } from '@/mcp/bridge';
import { initializeVault } from '@/security/vault';
import { registerBuiltinTools } from '@/tools';
import { logger } from '@/utils/logger';

async function main() {
  logger.info('Starting Octipus...');

  try {
    // Initialize gateway (database, redis, etc.) — uses bootstrap config from .env
    const gateway = getGateway();
    await gateway.start();

    // Seed system data (migrations already ran inside gateway.start())
    await seedPresetTemplates();
    await seedSkills();
    await seedExperts();
    await seedSkillTopicAssignments();
    await seedRoles();
    await loadRolesFromDb();
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

    // Initialize permission rule engine (deny→allow→ask patterns)
    const { initPermissionRules } = await import('@/security/permission-rules');
    await initPermissionRules();
    logger.info('Permission rules initialized');

    // Subscribe to settings changes for hot-reload
    initializeHotReload();

    // Discover filesystem skills (agentskills.io spec) — additive to DB skills
    const { getSkillRegistry } = await import('@/skills/registry');
    getSkillRegistry().loadExternal();

    // Clean up any agents left "running" from a previous process
    const { agentRepository } = await import('@/db/repositories/agent-repository');
    const staleCount = await agentRepository.cleanupStale();
    if (staleCount > 0) {
      logger.info({ staleCount }, 'Cleaned up stale agent records from previous run');
    }

    // Clean up agent events older than 1 day
    const { agentEventRepository } = await import('@/db/repositories/agent-event-repository');
    const eventCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const deletedEvents = await agentEventRepository.deleteOlderThan(eventCutoff).catch(() => 0);
    if (deletedEvents > 0) {
      logger.info({ deletedEvents }, 'Cleaned up old agent events (>1 day)');
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

    // Load user-authored extensions (.octipus/extensions/)
    try {
      const { getExtensionRegistry } = await import('@/extensions');
      await getExtensionRegistry(gatewayHub.eventBus).loadAll();
    } catch (err) {
      logger.error({ err }, 'Extension loading failed (non-fatal)');
    }

    // Reap orphaned swarm_nodes left `running` by a previous process. Must
    // run after DB init (done in gateway.start above) and alongside the
    // agent-manager stale cleanup so the live swarm tree hydrates cleanly.
    try {
      const { reapOrphanedSwarmNodes } = await import('@/core/swarm/orphan-reaper');
      const { reaped } = await reapOrphanedSwarmNodes();
      if (reaped > 0) {
        logger.warn({ reaped }, 'Swarm orphan reaper cleaned stale running nodes');
      }
    } catch (err) {
      logger.error({ err }, 'Swarm orphan reaper failed (non-fatal)');
    }

    // Wire gateway message handler and bridge orchestrator/agent events
    wireMessageHandler(gatewayHub);
    const disconnectBridge = connectEventBridge(gatewayHub);

    // Start API server
    await startServer();
    logger.info('API server started');

    // Start recurring task scheduler
    startCronLoop();
    logger.info('Cron scheduler started');

    logger.info('Octipus started successfully');

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

      // Dispose extensions before tearing down the hub they subscribed to
      try {
        const { getExtensionRegistry } = await import('@/extensions');
        await getExtensionRegistry().disposeAll();
      } catch {
        // registry may not have been initialized
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
    logger.error({ error }, 'Failed to start Octipus');
    process.exit(1);
  }
}

main();
