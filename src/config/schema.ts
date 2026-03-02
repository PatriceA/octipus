import { z } from 'zod';

// Database configuration schema
export const databaseConfigSchema = z.object({
  url: z.string().url().describe('PostgreSQL connection URL'),
  poolSize: z.number().min(1).max(100).default(10),
  idleTimeout: z.number().min(0).default(30000),
  connectionTimeout: z.number().min(0).default(10000),
});

// Redis configuration schema
export const redisConfigSchema = z.object({
  url: z.string().default('redis://localhost:6379'),
  keyPrefix: z.string().default('assistant:'),
  maxRetries: z.number().min(0).default(3),
  retryDelay: z.number().min(0).default(1000),
});

// LiteLLM configuration schema
export const litellmConfigSchema = z.object({
  proxyUrl: z.string().url().default('http://localhost:4000'),
  apiKey: z.string().optional(),
  timeout: z.number().min(0).default(120000),
  maxRetries: z.number().min(0).default(3),
});

// Ollama configuration schema
export const ollamaConfigSchema = z.object({
  url: z.string().url().default('http://localhost:11434'),
  defaultModel: z.string().default('llama3.2'),
});

// Security configuration schema
export const securityConfigSchema = z.object({
  masterKey: z.string().min(32).describe('32-byte hex master encryption key'),
  jwtSecret: z.string().min(32),
  sessionSecret: z.string().min(32),
  sessionMaxAge: z.number().min(0).default(86400000), // 24 hours
  totpIssuer: z.string().default('Assistant'),
  passkeyRpId: z.string().default('localhost'),
  passkeyRpName: z.string().default('Assistant'),
  passkeyOrigin: z.string().url().default('http://localhost:3000'),
});

// API server configuration schema
export const apiConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().min(1).max(65535).default(3000),
  corsOrigins: z.array(z.string()).default(['http://localhost:3001']),
  rateLimitWindow: z.number().min(0).default(60000),
  rateLimitMax: z.number().min(0).default(100),
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

// Voice configuration schema
export const voiceConfigSchema = z.object({
  sttEnabled: z.boolean().default(false),
  ttsEnabled: z.boolean().default(false),
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
  defaultTimeout: z.number().min(0).default(300000), // 5 minutes
  maxIterations: z.number().min(1).max(1000).default(50),
  contextWindowSize: z.number().min(1000).default(32000),
});

// CLI models configuration schema
export const cliModelsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  claudeCode: z.object({
    enabled: z.boolean().default(true),
    binaryPath: z.string().default('claude'),
    timeout: z.number().min(0).default(300000),
  }).default({}),
  geminiCli: z.object({
    enabled: z.boolean().default(true),
    binaryPath: z.string().default('gemini'),
    timeout: z.number().min(0).default(300000),
  }).default({}),
  codexCli: z.object({
    enabled: z.boolean().default(false),
    binaryPath: z.string().default('codex'),
    timeout: z.number().min(0).default(300000),
  }).default({}),
});

// Orchestrator configuration schema
export const orchestratorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaultModel: z.string().optional().describe('Override model for orchestrator. Uses DB default model if unset.'),
  piiFilterEnabled: z.boolean().default(true),
  maxPipelineStages: z.number().min(1).max(20).default(10),
  approvalTimeoutMs: z.number().min(0).default(3600000), // 1 hour
  workerTimeoutMs: z.number().min(0).default(600000), // 10 minutes
});

// OAuth configuration schema
export const oauthConfigSchema = z.object({
  google: z.object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
  }).default({}),
  microsoft: z.object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    tenantId: z.string().default('common'),
  }).default({}),
  publicUrl: z.string().optional(),
}).default({});

// Workspace configuration schema
export const workspaceConfigSchema = z.object({
  rootPath: z.string().default('./workspace'),
  additionalPaths: z.array(z.string()).default([]),
});

// Full configuration schema
export const configSchema = z.object({
  database: databaseConfigSchema,
  redis: redisConfigSchema,
  litellm: litellmConfigSchema,
  ollama: ollamaConfigSchema,
  security: securityConfigSchema,
  api: apiConfigSchema,
  telegram: telegramConfigSchema.optional(),
  teams: teamsConfigSchema.optional(),
  slack: slackConfigSchema.optional(),
  voice: voiceConfigSchema,
  mcp: mcpConfigSchema,
  n8n: n8nConfigSchema.optional(),
  logging: loggingConfigSchema,
  agent: agentConfigSchema,
  orchestrator: orchestratorConfigSchema.default({}),
  cliModels: cliModelsConfigSchema.default({}),
  workspace: workspaceConfigSchema.default({}),
  oauth: oauthConfigSchema,
});

export type Config = z.infer<typeof configSchema>;
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
export type OAuthConfig = z.infer<typeof oauthConfigSchema>;
