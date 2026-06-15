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
import { resetLiteLLMClient } from '@/models/litellm-client';
import { initializeVault } from '@/security/vault';
import { registerBuiltinTools } from '@/tools';
import { logger } from '@/utils/logger';

async function main() {
  logger.info('Starting Octipus...');

  // Claim process signal ownership before starting the gateway so it doesn't
  // also register SIGTERM/SIGINT — otherwise two handlers race their exit(0)
  // and truncate each other's async cleanup.
  process.env.OCTIPUS_SIGNALS_OWNED = '1';

  try {
    // Initialize vault first — gateway.start() runs the KB self-check which
    // exercises the embedding provider, and that provider needs the vault to
    // resolve API keys. If vault is not initialized yet, getByName throws and
    // providers fall back with a misleading "API key not configured" error.
    await initializeVault();
    logger.info('Vault initialized');

    // Initialize gateway (database, redis, etc.) — uses bootstrap config from .env
    const gateway = getGateway();
    await gateway.start();

    // Seed system data (migrations already ran inside gateway.start()).
    // Each seed is isolated: a failure — e.g. a constraint conflict from a
    // partially-written embedded DB after a hard kill — is logged loudly but
    // must NOT abort the whole backend. A missing preset/skill degrades one
    // feature; it does not justify bricking startup and leaving the user with
    // an install that crash-loops on every boot.
    const seedStep = async (step: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        logger.error({ err, step }, `System-data seed "${step}" failed — continuing boot (feature may be degraded)`);
      }
    };
    await seedStep('preset-templates', seedPresetTemplates);
    await seedStep('skills', seedSkills);
    await seedStep('experts', seedExperts);
    await seedStep('skill-topic-assignments', seedSkillTopicAssignments);
    await seedStep('roles', seedRoles);
    await loadRolesFromDb();
    logger.info('System data seeded');

    // One-time migration: move .env values into DB settings + vault
    await migrateEnvToDb();

    // First-boot model bootstrap: reads BOOTSTRAP_PROVIDER / _MODEL /
    // _API_KEY / _BASE_URL from .env (set by `bun run setup`) and
    // seeds a single default model_config row + vault entry — only
    // when model_config is empty.
    try {
      const { bootstrapDefaultModel } = await import('@/db/bootstrap-model');
      await bootstrapDefaultModel();
    } catch (err) {
      logger.error({ err }, 'bootstrap-model failed — first-message UX may show the no-engine path');
    }

    // Initialize settings service: warm cache from DB
    const settingsService = getSettingsService();
    await settingsService.initialize();
    logger.info('Settings service initialized');

    // Load runtime config from DB settings (replaces env-based config)
    await loadRuntimeConfig();
    logger.info('Runtime configuration loaded');

    // Invalidate config-derived singletons built DURING earlier startup (e.g.
    // the gateway KB self-check exercises the embedding provider, which lazily
    // constructs the LiteLLMClient). Those captured the pre-load default config
    // — crucially an EMPTY litellm.apiKey, since vault secrets are only resolved
    // here in loadRuntimeConfig(). Without this reset the orchestrator keeps
    // using the 'sk-litellm' placeholder for the whole process and every
    // completion 401s ("Invalid proxy server token"). Hot-reload only fires on
    // CHANGE events, so the initial load needs an explicit reset.
    resetLiteLLMClient();

    // Initialize permission rule engine (deny→allow→ask patterns)
    const { initPermissionRules } = await import('@/security/permission-rules');
    await initPermissionRules();
    logger.info('Permission rules initialized');

    // Subscribe to settings changes for hot-reload
    initializeHotReload();

    // Live Artifacts: auto-generate the token secret + populate SDK sha
    // from disk if the user hasn't set them in the UI. Wrapped so any
    // failure here cannot abort the rest of the boot sequence.
    try {
      const { bootstrapArtifactSettings } = await import('@/core/artifacts/settings');
      await bootstrapArtifactSettings();
      const { registerArtifactRefreshHandler } = await import('@/core/artifacts/scheduler');
      const { registerArtifactCleanupHandler, bootstrapArtifactCleanup } = await import('@/core/artifacts/cleanup');
      registerArtifactRefreshHandler();
      registerArtifactCleanupHandler();
      await bootstrapArtifactCleanup();
      logger.info('Live artifacts initialized');
    } catch (err) {
      logger.error({ err }, 'Live artifacts init failed — feature will be unavailable but server continues');
    }

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

    // Auto-index Octipus's own product docs into the knowledge base so users
    // can ask "how do I set up Telegram / a model provider / X?" and get an
    // answer grounded in the shipped manual. Must run AFTER runtime config is
    // loaded (the embedding provider needs vault-resolved credentials, or the
    // embed call 401s) — it is here, after registerBuiltinTools() and the
    // loadRuntimeConfig()/resetLiteLLMClient() above. Non-fatal and idempotent
    // (skips unchanged files); the cron refresh retries if the embedding model
    // is only bound after first boot.
    try {
      const { indexProductDocs } = await import('@/db/seed-docs');
      await indexProductDocs();
    } catch (err) {
      logger.error({ err }, 'Product docs auto-index failed (non-fatal) — server continues');
    }

    // Probe optional capabilities (Playwright, MCP, docker, …) and persist
    // their state to the `capabilities` table so the orchestrator can
    // gate agent dispatch on tool availability. Non-fatal — if probing
    // fails we still boot, agents will surface "tool unavailable" hints
    // at spawn time instead.
    try {
      const { getCapabilityService } = await import('@/capabilities/service');
      await getCapabilityService().probeAll();
    } catch (err) {
      logger.error({ err }, 'capability probe failed — orchestrator will fall back to per-spawn probes');
    }

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

    // Persona system: install the `before-agent-start` hook so the
    // orchestrator's system prompt gets the persona block, and the
    // narration bridge so swarm.node_spawned/completed events get
    // mirrored as `swarm.narration` for channel UIs. Synchronous so
    // the first message after boot is never persona-less.
    {
      const { installPersonaHook } = await import('@/core/personas/persona-hook');
      installPersonaHook();
      logger.info('Persona system installed (before-agent-start hook + narration bridge)');
    }

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

    // task_state orphan reaper — drops typed-output rows whose session
    // was deleted (schema deliberately has no FK; see migration 0050).
    // Runs once on boot, then weekly via the cron runner.
    try {
      const { getTaskStateRepository } = await import('@/db/repositories/task-state-repository');
      const removed = await getTaskStateRepository().reapOrphans();
      if (removed > 0) {
        logger.warn({ removed }, 'task_state orphan reaper removed rows from deleted sessions');
      }
    } catch (err) {
      logger.error({ err }, 'task_state orphan reaper failed (non-fatal)');
    }

    // Embedding-drift early warning. If the embeddings or memories
    // table carries rows produced by multiple embedding models,
    // cosine similarity across them is meaningless. The dedicated
    // script `scripts/check-embedding-drift.ts` gives the breakdown
    // and remediation; this is just a boot-time heads-up.
    try {
      const { sql } = await import('drizzle-orm');
      const { getDb } = await import('@/db/postgres');
      const db = getDb();
      for (const table of ['embeddings', 'memories'] as const) {
        const res = await db.execute(sql`
          SELECT count(DISTINCT embedding_version)::int AS distinct_versions
          FROM ${sql.raw(table)}
        `);
        const rows = Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? [];
        const distinct = (rows[0] as { distinct_versions?: number } | undefined)?.distinct_versions ?? 0;
        if (distinct > 1) {
          logger.warn(
            { table, distinctVersions: distinct },
            'Embedding-version drift detected — run `bun run scripts/check-embedding-drift.ts` for breakdown',
          );
        }
      }
    } catch (err) {
      logger.debug({ err }, 'embedding drift check skipped (non-fatal)');
    }

    // Wire gateway message handler and bridge orchestrator/agent events
    wireMessageHandler(gatewayHub);
    const disconnectBridge = connectEventBridge(gatewayHub);

    // Start API server
    await startServer();
    logger.info('API server started');

    // Mint / refresh the MCP bootstrap api token so bin/octi can stamp it
    // into .mcp.json (the legacy MASTER_KEY path was removed).
    try {
      const { ensureMcpBootstrapToken } = await import('@/security/mcp-token-bootstrap');
      await ensureMcpBootstrapToken();
    } catch (err) {
      logger.error({ err }, 'MCP token bootstrap failed (non-fatal)');
    }

    // Start recurring task scheduler
    startCronLoop();
    logger.info('Cron scheduler started');

    logger.info('Octipus started successfully');

    // Handle graceful shutdown. Idempotent: SIGTERM immediately followed by
    // SIGINT (or a double Ctrl-C) must not run the teardown twice.
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
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

      // Dispose tools that hold long-lived resources (e.g. the browser
      // tool's headless Chromium) before tearing down the rest.
      try {
        const { getToolRegistry } = await import('@/tools/registry');
        await getToolRegistry().shutdownAll();
      } catch {
        // registry may not have been initialized
      }

      stopCronLoop();
      disconnectBridge();
      await gatewayHub.stop();
      await mcpBridge.disconnectAll();
      await gateway.stop();

      // Close the long-lived task_state LISTEN connection (if it was
      // ever opened). Safe to call when no subscribers were active.
      try {
        const { shutdownTaskStateListener } = await import('@/db/task-state-listener');
        await shutdownTaskStateListener();
      } catch {
        // Module may not have loaded; nothing to close.
      }

      logger.info('Shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Last-resort guards: a stray rejection/exception from any channel, tool, or
    // background task must NOT silently wedge or kill the process — there is no
    // external supervisor to restart it. Log loudly (fail-loud) and stay up.
    process.on('unhandledRejection', (reason) => {
      logger.error(
        { reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason },
        'Unhandled promise rejection — process kept alive',
      );
    });
    process.on('uncaughtException', (error) => {
      logger.error({ error: { message: error.message, stack: error.stack } }, 'Uncaught exception — process kept alive');
    });
  } catch (error) {
    logger.error(
      {
        error,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        errorName: error instanceof Error ? error.name : undefined,
      },
      'Failed to start Octipus',
    );
    process.exit(1);
  }
}

main();
