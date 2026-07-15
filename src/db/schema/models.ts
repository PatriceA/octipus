import { boolean, index, integer, jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

export const modelConfig = pgTable('model_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  provider: text('provider').notNull(), // openai, anthropic, ollama, etc.
  modelId: text('model_id').notNull(), // gpt-4o, claude-3-opus, llama3.2, etc.
  endpoint: text('endpoint'), // Custom endpoint URL
  apiKeyRef: text('api_key_ref'), // Reference to vault entry
  /** Org-shared registry. NULL = system-wide. Members of the org see this row in their list. */
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  // Capabilities
  maxTokens: integer('max_tokens').default(4096).notNull(),
  contextWindow: integer('context_window').default(128000).notNull(),
  supportsVision: boolean('supports_vision').default(false).notNull(),
  supportsTools: boolean('supports_tools').default(true).notNull(),
  supportsStreaming: boolean('supports_streaming').default(true).notNull(),
  // Default parameters
  defaultTemperature: real('default_temperature').default(0.7),
  defaultTopP: real('default_top_p').default(1.0),
  defaultMaxTokens: integer('default_max_tokens').default(4096),
  // Routing
  topics: text('topics').array().default([]), // coding, research, chat, etc.
  priority: integer('priority').default(0).notNull(), // Higher = preferred (deprecated, use topicRoles)
  topicRoles: jsonb('topic_roles').$type<Record<string, 'primary' | 'backup'>>().default({}),
  // Cost tracking (per 1M tokens)
  costPerInputToken: real('cost_per_input_token').default(0).notNull(),
  costPerOutputToken: real('cost_per_output_token').default(0).notNull(),
  // Status
  isEnabled: boolean('is_enabled').default(true).notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  metadata: jsonb('metadata').$type<ModelMetadata>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  providerIdx: index('model_config_provider_idx').on(table.provider),
  topicsIdx: index('model_config_topics_idx').on(table.topics),
  orgIdIdx: index('model_config_org_id_idx').on(table.orgId),
}));

export interface CLIAgentConfig {
  /** Permission mode: 'bypassPermissions' (Claude), 'yolo' (Gemini) */
  permissionMode?: string;
  /** Allowed tools whitelist (Claude only) */
  allowedTools?: string[];
  /** Max budget in USD per invocation (Claude only) */
  maxBudgetUsd?: number;
  /** Path to MCP config JSON file */
  mcpConfigPath?: string;
  /** Additional CLI flags */
  extraArgs?: string[];
  /** Override the model the CLI uses (e.g. Codex — bypasses ~/.codex/config.toml default) */
  model?: string;
}

export interface ModelMetadata {
  description?: string;
  releaseDate?: string;
  deprecated?: boolean;
  /**
   * Parameter count (e.g. 7_000_000_000 for a 7B model). Used by the
   * orchestrator mode selector to pick full/lite/router. When absent, the
   * selector falls back to parsing the size out of the model id tag.
   */
  paramCount?: number;
  rateLimits?: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
  customHeaders?: Record<string, string>;
  /** Extra body parameters passed to LiteLLM/provider (e.g. { think: false } for Ollama Qwen3) */
  extraBody?: Record<string, unknown>;
  /** CLI sub-agent configuration (only for provider='cli') */
  cliAgent?: CLIAgentConfig;
  /** Custom provider configuration (only for provider='custom-openai', 'custom-anthropic', or 'custom-gemini') */
  customProvider?: CustomProviderConfig;
}

export interface CustomProviderConfig {
  /** Authentication scheme used by the upstream endpoint */
  auth: {
    type: 'bearer' | 'header' | 'query';
    /** Header name when type='header' (e.g. 'x-api-key') */
    headerName?: string;
    /** Query parameter name when type='query' (e.g. 'key') */
    paramName?: string;
  };
  /**
   * Override the default request path. Defaults per flavor:
   *   - custom-openai:    '/v1/chat/completions'
   *   - custom-anthropic: '/v1/messages'
   *   - custom-gemini:    '/v1beta/models/{model}:generateContent'
   */
  pathOverride?: string;
  /** Extra headers to include on every request */
  extraHeaders?: Record<string, string>;
}

export const costLog = pgTable('cost_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  sessionId: uuid('session_id'),
  agentId: text('agent_id'),
  modelName: text('model_name').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  // Cache accounting: cachedInputTokens is the subset of inputTokens that hit a
  // provider prompt cache (billed at a discount); cacheCreationTokens is the
  // write cost for a fresh cache entry (Anthropic only, billed at a premium).
  cachedInputTokens: integer('cached_input_tokens').default(0).notNull(),
  cacheCreationTokens: integer('cache_creation_tokens').default(0).notNull(),
  totalCost: real('total_cost').notNull(),
  requestType: text('request_type'), // chat, completion, embedding
  metadata: jsonb('metadata').$type<CostLogMetadata>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('cost_log_user_id_idx').on(table.userId),
  sessionIdIdx: index('cost_log_session_id_idx').on(table.sessionId),
  modelNameIdx: index('cost_log_model_name_idx').on(table.modelName),
  createdAtIdx: index('cost_log_created_at_idx').on(table.createdAt),
}));

export interface CostLogMetadata {
  prompt?: string;
  latencyMs?: number;
  cached?: boolean;
  retries?: number;
}

export type ModelConfigEntry = typeof modelConfig.$inferSelect;
export type NewModelConfigEntry = typeof modelConfig.$inferInsert;
export type CostLogEntry = typeof costLog.$inferSelect;
export type NewCostLogEntry = typeof costLog.$inferInsert;
