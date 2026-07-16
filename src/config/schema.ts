import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// Absolute workspace root under the user's home — `path.resolve` does not
// expand `~`, so schema defaults must be concrete absolute paths.
const WORKSPACE_ROOT = join(homedir(), '.octipus', 'workspace');

// Storage mode: 'embedded' (PGlite + in-memory) or 'external' (PostgreSQL + Valkey)
export const storageModeSchema = z.enum(['embedded', 'external']).default('external');

// Database configuration schema
export const databaseConfigSchema = z.object({
  url: z.string().describe('PostgreSQL connection URL (external mode — set DATABASE_URL)'),
  dataDir: z.string().default('~/.octipus/data').describe('PGlite data directory (embedded mode)'),
  poolSize: z.number().min(1).max(100).default(10),
  idleTimeout: z.number().min(0).default(30000),
  connectionTimeout: z.number().min(0).default(10000),
});

// Valkey (Redis-compatible) configuration schema
export const redisConfigSchema = z.object({
  url: z.string().default('redis://localhost:6379'),
  keyPrefix: z.string().default('octipus:'),
  maxRetries: z.number().min(0).default(3),
  retryDelay: z.number().min(0).default(1000),
});

// LiteLLM configuration schema
export const litellmConfigSchema = z.object({
  proxyUrl: z.union([z.string().url(), z.literal('')]).default(''),
  apiKey: z.string().optional(),
  timeout: z.number().min(0).default(120000),
  maxRetries: z.number().min(0).default(3),
});

// Ollama configuration schema
export const ollamaConfigSchema = z.object({
  url: z.string().url().optional().describe('Ollama service URL — leave empty if not using a local/remote Ollama instance'),
  defaultModel: z.string().default('llama3.2'),
  // Cold-loading a large model on slow hardware (e.g. an iGPU) can exceed the
  // old hard-coded 120s. When the client cancels first, Ollama ABORTS the load,
  // so the model never warms and every retry cold-loads again → permanent
  // timeout loop. Default raised to 5min; operators on slower hosts can go higher.
  requestTimeout: z.number().min(1000).default(300000).describe('Ollama load + inference timeout (ms)'),
  // Sent as `keep_alive` so a loaded model stays resident in VRAM between calls
  // instead of unloading after Ollama\'s 5min default — avoids repeated cold loads.
  // Accepts a duration string ('10m', '1h') or '-1' to keep it loaded indefinitely.
  keepAlive: z.string().default('10m').describe('How long Ollama keeps a model warm in VRAM (duration string or -1)'),
});

// Security configuration schema
export const securityConfigSchema = z.object({
  masterKey: z.string().min(32).describe('32-byte hex master encryption key'),
  jwtSecret: z.string().min(32),
  sessionSecret: z.string().min(32),
  sessionMaxAge: z.number().min(0).default(86400000), // 24 hours
  totpIssuer: z.string().default('Octipus'),
  passkeyRpId: z.string().default('localhost'),
  passkeyRpName: z.string().default('Octipus'),
  passkeyOrigin: z.string().url().default('http://localhost:3000'),
  /**
   * Shell sandbox — Phase 3e. Wraps shell-tool spawns in a process
   * sandbox (bubblewrap or firejail) so a compromised agent can't
   * read/write outside the configured workspace.
   *
   *   - `'off'` (default) — no wrapping; behavior matches pre-3e.
   *   - `'auto'` — wrap when bwrap/firejail is on PATH; fall back to
   *     unsandboxed run if not.
   *   - `'required'` — wrap when available; refuse to spawn if no
   *     runner is found. Operational deployments use this once
   *     they've installed a runner.
   *
   * Linux-only; on macOS/Windows the runners aren't available so
   * `auto` reduces to `off`.
   */
  shellSandbox: z.enum(['off', 'auto', 'required']).default('off'),
  vaultDenyUnscopedSecrets: z.boolean().default(false),
  /**
   * Docker tool per-user isolation — Phase 3f. When `'enforce'` and
   * `multiuser.enabled` is true, the Docker tool:
   *   - filters list_containers to containers labelled
   *     octipus.user_id=<userId>;
   *   - refuses start/stop/logs/exec on containers that don't carry
   *     the caller's label (returns "container not found");
   *   - auto-injects the label on every container the tool builds /
   *     runs going forward.
   * Off (default) leaves the tool's behavior unchanged. Single-user
   * installs and deployments that don't use the Docker tool stay
   * unaffected.
   */
  dockerIsolation: z.enum(['off', 'enforce']).default('off'),
});

// API server configuration schema
export const apiConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().min(1).max(65535).default(3000),
  corsOrigins: z.array(z.string()).default(['http://localhost:3001']),
  rateLimitWindow: z.number().min(0).default(60000),
  /**
   * Per-user API-call ceiling per `rateLimitWindow` (the default quota for
   * `maxApiCallsPerMinute`). Octipus is always multi-user, so this fires for
   * every authenticated user — including the lone operator of a single-user
   * install whose dashboard polling counts here. Kept in line with the per-IP
   * baseline (`BASELINE_IP_LIMIT`, 600/min ≈ 10 req/s "won't bother a real
   * interactive user"); a stricter value throttles normal dashboard use. Lower
   * it per-user via /admin/quotas when running true multi-tenant.
   */
  rateLimitMax: z.number().min(0).default(600),
});

// Telegram configuration schema
export const telegramConfigSchema = z.object({
  botToken: z.string().optional(),
  allowedUsers: z.array(z.string()).default([]),
  webhookUrl: z.string().url().optional(),
  pollingTimeout: z.number().min(0).default(30),
});

// Microsoft Teams configuration schema
export const teamsConfigSchema = z.object({
  appId: z.string().optional(),
  appPassword: z.string().optional(),
  tenantId: z.string().optional(),
});

// Slack configuration schema
export const slackConfigSchema = z.object({
  botToken: z.string().optional(),
  appToken: z.string().optional(),
  signingSecret: z.string().optional(),
});

// WhatsApp configuration schema
export const whatsappConfigSchema = z.object({
  accessToken: z.string().optional(),
  phoneNumberId: z.string().optional(),
  verifyToken: z.string().default('octipus-whatsapp-verify'),
  appSecret: z.string().optional(),
  businessAccountId: z.string().optional(),
});

// Voice configuration schema
export const voiceConfigSchema = z.object({
  sttEnabled: z.boolean().default(false),
  ttsEnabled: z.boolean().default(false),
  /**
   * Which engine transcribes speech on the realtime `/voice` socket.
   * `auto` picks the best available (cloud realtime if a key is set, else local
   * whisper); the others force a specific engine. `mistral` = Voxtral cloud,
   * `openai` = gpt-4o-transcribe, `whisper` = local whisper.cpp (offline).
   */
  sttProvider: z.enum(['auto', 'whisper', 'mistral', 'openai']).default('auto').catch('auto'),
  /**
   * Which TTS engine serves /api/voice/speak. Defaults to cloud (mistral/Voxtral)
   * so voice-out works with no host setup. `openai` = gpt-4o-mini-tts (cloud);
   * `piper` is the local opt-in (needs a binary + .onnx voice).
   *
   * `.catch` coerces a now-removed value (an old `edge`/`coqui` row persisted in
   * the settings DB) back to the default instead of failing the whole config load.
   */
  ttsProvider: z.enum(['mistral', 'openai', 'piper']).default('mistral').catch('mistral'),
  whisperModelPath: z.string().optional(),
  piperModelPath: z.string().optional(),
  wakeWord: z.string().optional(),
  language: z.string().default('en'),
});

// MCP configuration schema
export const mcpConfigSchema = z.object({
  serversConfigPath: z.string().optional(),
  autoStart: z.boolean().default(true),
  connectionTimeout: z.number().min(0).default(30000),
});

// N8N configuration schema
export const n8nConfigSchema = z.object({
  url: z.string().url().optional(),
  apiKey: z.string().optional(),
  webhookPath: z.string().default('/n8n/webhook'),
});

// Logging configuration schema
export const loggingConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  format: z.enum(['pretty', 'json']).default('pretty'),
  file: z.string().optional(),
});

// Agent configuration schema
export const agentConfigSchema = z.object({
  maxConcurrentAgents: z.number().min(1).max(100).default(10),
  defaultTimeout: z.number().min(0).default(900000), // 15 minutes
  maxIterations: z.number().min(1).max(1000).default(50),
  contextWindowSize: z.number().min(1000).default(32000),
  maxTokenBudget: z.number().min(0).default(100000), // 0 = unlimited
  // Soft cap on full tool-result messages kept in context before the OLDEST
  // ones are truncated (recent kept full). Left optional with NO default so
  // omitting it preserves today's behaviour (DEFAULT_TOOL_OUTPUT_SOFT_CAP);
  // setting it gives a runtime knob without editing agent construction sites.
  toolOutputSoftCap: z.number().min(1).optional(),
});

// CLI models configuration schema
export const cliModelsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  claudeCode: z.object({
    enabled: z.boolean().default(true),
    binaryPath: z.string().default('claude'),
    timeout: z.number().min(0).default(300000),
  }).prefault({}),
  antigravityCli: z.object({
    enabled: z.boolean().default(true),
    binaryPath: z.string().default('agy'),
    timeout: z.number().min(0).default(300000),
  }).prefault({}),
  codexCli: z.object({
    enabled: z.boolean().default(false),
    binaryPath: z.string().default('codex'),
    timeout: z.number().min(0).default(300000),
  }).prefault({}),
});

// Orchestrator configuration schema
export const orchestratorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaultModel: z.string().optional().describe('Override model for orchestrator. Uses DB default model if unset.'),
  /**
   * Orchestrator execution mode. 'auto' (default) re-derives the mode every
   * turn from the current default model's parameter count, so swapping to a
   * smaller model changes the mode with no restart:
   *   - router: no orchestrator LLM — classify → one specialist → relay (≤~10B)
   *   - lite:   shrunken LLM orchestrator, single-step delegation (~10–24B)
   *   - full:   today's full swarm orchestrator (≥~24B)
   * Setting an explicit value pins that mode regardless of model size.
   */
  mode: z.enum(['auto', 'full', 'lite', 'router']).default('auto'),
  /**
   * Iteration cap for the lite orchestrator loop. Default 3 keeps lite cheap;
   * the ceiling allows operators to raise it for heavier "full run" workloads
   * (full mode's own loop tops out at 25, so that's the sensible upper bound).
   */
  liteMaxIterations: z.number().min(1).max(25).default(3),
  /** auto: models with fewer params than this run in router mode. */
  routerSmallModelMaxParams: z.number().default(10_000_000_000),
  /** auto: models with fewer params than this (and ≥ router threshold) run in lite mode. */
  liteModelMaxParams: z.number().default(24_000_000_000),
  /**
   * Max tools handed to a worker whose bound model is in the small (router)
   * tier. Small local models lose track of large tool surfaces and emit
   * malformed tool-call JSON; capping the list improves reliability and cuts
   * prompt size. Role tool lists are priority-ordered, so the cap keeps the
   * core tools. Does not affect workers on larger models.
   */
  smallModelMaxTools: z.number().min(1).max(50).default(7),
  piiFilterEnabled: z.boolean().default(true),
  maxPipelineStages: z.number().min(1).max(20).default(10),
  approvalTimeoutMs: z.number().min(0).default(3600000), // 1 hour
  workerTimeoutMs: z.number().min(0).default(600000), // 10 minutes
  orchestratorTimeoutMs: z.number().min(0).default(1800000), // 30 minutes
  orchestratorHookTimeoutMs: z.number().min(0).default(2700000), // 45 minutes for hook-triggered runs
});

// OAuth configuration schema
export const oauthConfigSchema = z.object({
  // OAuth client credentials are stored in the vault (not env vars)
  // Vault names: google_oauth_client_id, google_oauth_client_secret,
  //              microsoft_oauth_client_id, microsoft_oauth_client_secret, microsoft_oauth_tenant_id
  publicUrl: z.string().optional(),
}).default({});

// Rate limit configuration schema
export const rateLimitConfigSchema = z.object({
  /** Per-provider overrides */
  providers: z.record(z.string(), z.object({
    maxConcurrency: z.number().min(1).optional(),
    rpm: z.number().min(0).optional(),
    tpm: z.number().min(0).optional(),
    minDelay: z.number().min(0).optional(),
    adaptive: z.boolean().optional(),
  })).optional(),
  /** Global max concurrent requests across all providers */
  globalMaxConcurrency: z.number().min(1).default(50),
  /** Max time (ms) a request can wait in the queue before being rejected */
  queueTimeout: z.number().min(0).default(30000),
}).optional();

// Session compaction configuration schema
//
// Used by the anti-thrashing guard in
// `src/core/orchestrator/session-compaction.ts` to avoid looping when a
// compaction pass fails to meaningfully reduce token usage.
export const compactionConfigSchema = z.object({
  /**
   * Minimum savings ratio — (tokensBefore - tokensAfter) / tokensBefore —
   * for a pass to be considered effective. Below this a stall flag is set.
   */
  minSavingsRatio: z.number().min(0).max(1).default(0.10),
  /**
   * Once stalled, the session must grow by this multiple of its pre-compact
   * size before another pass is attempted.
   */
  growthMultiplier: z.number().min(1).default(2.0),
  /**
   * Safety valve — once the session exceeds this many tokens we always run
   * a compaction pass, even if the session is marked stalled.
   */
  hardCeiling: z.number().min(1).default(1_000_000),
});

// Swarm (agent delegation tree) configuration schema.
// See `.octipus/swarm-design.md`. Phase 3 adds per-user fan-out caps +
// orphan reaper cadence; both have safe defaults so existing deployments
// don't need to set anything.
const swarmLevelSchema = z.object({
  tokens: z.number().min(1_000),
  wallMs: z.number().min(10_000),
  fanOut: z.number().min(0).max(20),
  maxPendingDetached: z.number().min(0).max(10).default(0),
});

export const swarmConfigSchema = z.object({
  perUserSpawnsPerMinute: z.number().min(1).max(1000).default(30),
  orphanReaperIntervalMs: z.number().min(30_000).default(600_000),
  levelDefaults: z.object({
    orchestrator: swarmLevelSchema.default({ tokens: 200_000, wallMs: 600_000, fanOut: 6, maxPendingDetached: 6 }),
    agent: swarmLevelSchema.default({ tokens: 80_000, wallMs: 600_000, fanOut: 4, maxPendingDetached: 3 }),
    subagent: swarmLevelSchema.default({ tokens: 30_000, wallMs: 600_000, fanOut: 0, maxPendingDetached: 0 }),
  }).prefault({}),
});

// Multi-user configuration schema.
//
// Octipus is always multi-user: every request must carry a valid session or
// API token (there is no MASTER_KEY fallback), workspaces are per-user, and
// quotas / per-user rate limits apply. A single-user install simply never
// creates a second user. The sub-flags below tune independent features
// layered on top.
export const multiuserConfigSchema = z.object({
  auditShadow: z.boolean().default(true),
  enforcePermissions: z.boolean().default(true),
  /**
   * Postgres Row-Level Security — Phase 3b. When true, the connection
   * wrapper opens authenticated queries in a transaction and sets
   *   SET LOCAL app.current_user_id = <principal.userId>
   *   SET LOCAL app.bypass_rls = 'false'
   * so the policies installed by migration 0034 enforce per-row
   * ownership in addition to the application-layer scoped repositories.
   *
   * Off by default. PGlite ignores RLS (single-superuser bypass) so
   * embedded installs are unaffected. External-Postgres deployments
   * need a non-superuser app role for the policies to actually fire.
   * The "bypass on missing GUC" default in the policy lets unscoped
   * code paths continue to work non-disruptively when this is on.
   */
  rlsEnabled: z.boolean().default(false),
  /**
   * Org / workspace grouping layer — Phase 3g. When false (default),
   * the `/api/me/workspaces` and `/api/admin/orgs` routes return 404
   * and no part of the runtime consults the orgs/workspaces tables.
   * The schema is in place (migration 0038) so flipping this on later
   * requires no migration. Phase 4 wires `workspace_id` onto sessions
   * and documents and gates that on the same flag.
   */
  orgWorkspaces: z.boolean().default(false),
});

// Workspace configuration schema
export const skillsConfigSchema = z.object({
  externalEnabled: z.boolean().default(true),
  externalDirectories: z.array(z.string()).default([]),
});

export const workspaceConfigSchema = z.object({
  // Default outside the repo tree so workspace files can never be
  // accidentally committed/pushed. Editable via PUT /api/workspace; existing
  // installs keep their configured path.
  rootPath: z.string().default(WORKSPACE_ROOT),
  additionalPaths: z.array(z.string()).default([]),
  sessionFolders: z.boolean().default(true),
  autoIndexFiles: z.boolean().default(true),
  documentsPath: z.string().default(join(WORKSPACE_ROOT, 'documents')),
  maxUploadSize: z.number().min(0).default(52428800), // 50MB
  ocrModel: z.string().default('glm-ocr'),
  ocrEndpoint: z.string().default('http://localhost:11435'),
});

/**
 * Knowledge-graph Tier 3 — two-way Obsidian vault sync. When `enabled`,
 * notes can be exported to / imported from a real vault directory. DB
 * stays authoritative; `direction` bounds which way sync may run.
 */
export const vaultSyncConfigSchema = z.object({
  enabled: z.boolean().default(false),
  path: z.string().default('./workspace/vault'),
  direction: z.enum(['export', 'import', 'both']).default('both'),
});

// Full configuration schema
/**
 * WS2 — heartbeat loop. A periodic per-user agent turn that reviews standing
 * context and acts or stays silent. Off by default; a cheap deterministic gate
 * (quiet hours, daily cap, quota, "anything pending?" probe) runs before any
 * LLM tokens are spent. See src/core/heartbeat.ts.
 */
export const heartbeatConfigSchema = z.object({
  /** Master switch. When false the cron-runner never processes heartbeat hooks. */
  enabled: z.boolean().default(false),
  /** Minutes between heartbeat runs per user. */
  intervalMinutes: z.number().int().min(5).max(1440).default(60),
  /** Quiet hours (local to `quietHoursTimezone`): no runs when the hour is in
   *  [start, end). Equal start/end disables quiet hours. */
  quietHoursStart: z.number().int().min(0).max(23).default(22),
  quietHoursEnd: z.number().int().min(0).max(23).default(7),
  quietHoursTimezone: z.string().default('UTC'),
  /** Hard cap on heartbeat runs per user per calendar day (in the tz above). */
  maxRunsPerDay: z.number().int().min(1).max(288).default(24),
});

// Full configuration schema
export const configSchema = z.object({
  storageMode: storageModeSchema,
  database: databaseConfigSchema,
  redis: redisConfigSchema,
  litellm: litellmConfigSchema,
  ollama: ollamaConfigSchema,
  security: securityConfigSchema,
  api: apiConfigSchema,
  telegram: telegramConfigSchema.optional(),
  teams: teamsConfigSchema.optional(),
  slack: slackConfigSchema.optional(),
  whatsapp: whatsappConfigSchema.optional(),
  voice: voiceConfigSchema,
  mcp: mcpConfigSchema,
  n8n: n8nConfigSchema.optional(),
  logging: loggingConfigSchema,
  agent: agentConfigSchema,
  orchestrator: orchestratorConfigSchema.prefault({}),
  cliModels: cliModelsConfigSchema.prefault({}),
  workspace: workspaceConfigSchema.prefault({}),
  vaultSync: vaultSyncConfigSchema.prefault({}),
  multiuser: multiuserConfigSchema.prefault({}),
  compaction: compactionConfigSchema.prefault({}),
  memory: z.object({
    /**
     * When to run the memory extractor + judge pipeline.
     *
     * - `per_turn`: extract after every user turn. Granular, more
     *   LLM calls (one extractor + one judge call per extracted
     *   fact, typically 0–1 per turn). Default.
     * - `on_compaction`: extract only when the session compactor
     *   runs. Fewer LLM calls; learning lags by hours of conversation.
     * - `off`: skip extraction entirely. Retrieval still works
     *   for any memories already in the table.
     */
    extractionCadence: z.enum(['per_turn', 'on_compaction', 'off']).default('per_turn'),
  }).prefault({}),
  oauth: oauthConfigSchema,
  rateLimit: rateLimitConfigSchema,
  swarm: swarmConfigSchema.prefault({}),
  skills: skillsConfigSchema.prefault({}),
  heartbeat: heartbeatConfigSchema.prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type HeartbeatConfig = z.infer<typeof heartbeatConfigSchema>;
export type StorageMode = z.infer<typeof storageModeSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type RedisConfig = z.infer<typeof redisConfigSchema>;
export type LiteLLMConfig = z.infer<typeof litellmConfigSchema>;
export type OllamaConfig = z.infer<typeof ollamaConfigSchema>;
export type SecurityConfig = z.infer<typeof securityConfigSchema>;
export type APIConfig = z.infer<typeof apiConfigSchema>;
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;
export type TeamsConfig = z.infer<typeof teamsConfigSchema>;
export type SlackConfig = z.infer<typeof slackConfigSchema>;
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;
export type MCPConfig = z.infer<typeof mcpConfigSchema>;
export type N8NConfig = z.infer<typeof n8nConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
export type CLIModelsConfig = z.infer<typeof cliModelsConfigSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type VaultSyncConfig = z.infer<typeof vaultSyncConfigSchema>;
export type MultiuserConfig = z.infer<typeof multiuserConfigSchema>;
export type CompactionConfig = z.infer<typeof compactionConfigSchema>;
export type WhatsAppConfig = z.infer<typeof whatsappConfigSchema>;
export type OAuthConfig = z.infer<typeof oauthConfigSchema>;
export type RateLimitConfig = z.infer<typeof rateLimitConfigSchema>;
export type SwarmConfig = z.infer<typeof swarmConfigSchema>;
export type SkillsConfig = z.infer<typeof skillsConfigSchema>;
