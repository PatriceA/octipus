import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './schema';

// Absolute workspace root under the user's home (outside the repo tree, so
// workspace files can't be committed). `path.resolve` does NOT expand `~`, so
// we compute the absolute path here rather than emit a literal tilde.
const WORKSPACE_ROOT = join(homedir(), '.octipus', 'workspace');

export const defaultConfig: Partial<Config> = {
  storageMode: 'external',
  database: {
    url: '', // Must be set via DATABASE_URL env var in external mode
    dataDir: '~/.octipus/data',
    poolSize: 10,
    idleTimeout: 30000,
    connectionTimeout: 10000,
  },
  litellm: {
    proxyUrl: 'http://localhost:4000',
    timeout: 120000,
    maxRetries: 3,
  },
  ollama: {
    defaultModel: 'llama3.2',
    requestTimeout: 300000,
    keepAlive: '10m',
  },
  security: {
    masterKey: '', // Must be provided
    jwtSecret: '', // Must be provided
    sessionSecret: '', // Must be provided
    sessionMaxAge: 86400000,
    totpIssuer: 'Octipus',
    passkeyRpId: 'localhost',
    passkeyRpName: 'Octipus',
    passkeyOrigin: 'http://localhost:3000',
    shellSandbox: 'off',
    vaultDenyUnscopedSecrets: false,
    dockerIsolation: 'off',
  },
  api: {
    host: '0.0.0.0',
    port: 3000,
    corsOrigins: ['http://localhost:3001'],
    rateLimitMax: 600,
  },
  voice: {
    sttEnabled: false,
    ttsEnabled: false,
    sttProvider: 'auto' as const,
    fasterWhisperModel: 'small' as const,
    ttsProvider: 'mistral' as const,
    language: 'en',
  },
  mcp: {
    autoStart: true,
  },
  logging: {
    level: 'info',
    format: 'pretty',
  },
  agent: {
    maxConcurrentAgents: 10,
    defaultTimeout: 900000,
    maxIterations: 50,
    contextWindowSize: 32000,
    maxTokenBudget: 100000,
  },
  orchestrator: {
    mode: 'auto',
    liteMaxIterations: 8,
    routerSmallModelMaxParams: 10_000_000_000,
    liteModelMaxParams: 24_000_000_000,
    smallModelMaxTools: 7,
    /** Orchestrator agent timeout for interactive channels (30 min). */
    orchestratorTimeoutMs: 1800000,
    /** Orchestrator agent timeout for unattended hook-triggered runs (45 min). */
    orchestratorHookTimeoutMs: 2700000,
    /** Token pool for one pipeline run, summed over node visits. 0 = off. */
    pipelineTokenBudget: 2_000_000,
  },
  multiuser: {
    // Octipus is always multi-user — there is no single-user mode and no
    // MASTER_KEY fallback. These sub-flags tune independent layered features.
    auditShadow: true,
    enforcePermissions: true,
    rlsEnabled: false,           // requires non-superuser app role; opt-in
    orgWorkspaces: true,
    /**
     * Refuse (don't auto-approve) these actions for unattended workers.
     *
     * Not empty. An ASK-level action reaching a caller that cannot be asked
     * falls through to this list, and an empty list means "auto-approve
     * everything nobody can be asked about" — which is how a spawned child ran
     * `rm -rf ./*` in a live session with a person sitting at the terminal.
     * A worker that hits this fails loudly and reports what it needed, which
     * the root can then put to the user.
     */
    unattendedDenyActions: ['shell.execute_destructive', 'filesystem.delete'],
  },
  workspace: {
    rootPath: WORKSPACE_ROOT,
    additionalPaths: [],
    sessionFolders: true,
    autoIndexFiles: true,
    documentsPath: join(WORKSPACE_ROOT, 'documents'),
    maxUploadSize: 52428800,
    ocrModel: 'glm-ocr',
    ocrEndpoint: 'http://localhost:11435',
  },
  compaction: {
    minSavingsRatio: 0.10,
    growthMultiplier: 2.0,
    hardCeiling: 1_000_000,
  },
  swarm: {
    perUserSpawnsPerMinute: 30,
    orphanReaperIntervalMs: 600_000,
    contractRetries: 1,
    levelDefaults: {
      orchestrator: { tokens: 200_000, wallMs: 600_000, fanOut: 6, maxPendingDetached: 6 },
      agent: { tokens: 80_000, wallMs: 600_000, fanOut: 4, maxPendingDetached: 3 },
      subagent: { tokens: 30_000, wallMs: 600_000, fanOut: 0, maxPendingDetached: 0 },
    },
  },
};

/** Required env vars — DATABASE_URL is only needed in external mode */
export const requiredEnvVars = [
  'MASTER_KEY',
  'JWT_SECRET',
  'SESSION_SECRET',
];

/** Additional env vars required only in external storage mode */
export const externalModeRequiredVars = [
  'DATABASE_URL',
];

export const optionalEnvVars = [
  'LITELLM_PROXY_URL',
  'LITELLM_API_KEY',
  'OLLAMA_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USERS',
  'TEAMS_APP_ID',
  'TEAMS_APP_PASSWORD',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'WHISPER_MODEL_PATH',
  'PIPER_MODEL_PATH',
  'API_HOST',
  'API_PORT',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'N8N_URL',
  'N8N_API_KEY',
  'MCP_SERVERS_CONFIG',
  'WORKSPACE_PATH',
  'WORKSPACE_ADDITIONAL_PATHS',
  'PUBLIC_URL',
];
