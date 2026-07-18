export interface Model {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  endpoint?: string;
  apiKeyRef?: string | null;
  isEnabled: boolean;
  isDefault: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  contextWindow: number;
  maxTokens: number;
  topics: string[];
  priority: number;
  costPerInputToken: number;
  costPerOutputToken: number;
  metadata?: {
    description?: string;
    /**
     * Parameter count as a raw number (e.g. 7_000_000_000 for a 7B model).
     * Drives the orchestrator mode selector (router/lite/full) when
     * `orchestrator.mode` is `auto`. Absent for external model IDs that
     * carry no size tag — set it here so they don't dead-end at lite.
     */
    paramCount?: number;
    extraBody?: Record<string, unknown>;
    cliAgent?: {
      permissionMode?: string;
      allowedTools?: string[];
      maxBudgetUsd?: number;
      mcpConfigPath?: string;
      extraArgs?: string[];
      model?: string;
    };
    customProvider?: {
      auth: {
        type: 'bearer' | 'header' | 'query';
        headerName?: string;
        paramName?: string;
      };
      pathOverride?: string;
      extraHeaders?: Record<string, string>;
    };
  };
  health?: 'healthy' | 'unhealthy' | 'unknown';
}

export interface CLIBillingInfo {
  vendor: string;
  planNote: string;
  billingMode: 'subscription' | 'api-key' | 'mixed';
  pricingDocUrl: string;
  modelsDocUrl: string;
  modelFlagDocUrl: string;
  warning: string;
}

export interface CLITool {
  name: string;
  available: boolean;
  modelPatterns: string[];
  /** Direct provider whose model catalog drives this CLI's picker. */
  modelProvider?: 'anthropic' | 'google' | 'openai' | 'mistral';
  /** CLI flag for model selection (display only). */
  modelFlag?: string;
  billingInfo?: CLIBillingInfo;
  quota: {
    provider: string;
    hasQuota: boolean;
    exhausted: boolean;
    resetsAt?: string;
  } | null;
}

export interface LiteLLMModel {
  id: string;
  provider: string;
  litellmModel: string;
}

/**
 * Topics used by the orchestrator for role-based model routing.
 *
 * KEEP IN SYNC with src/models/topics.ts (TOPICS) — single source of truth.
 * web cannot import backend src (its tsconfig only maps @/* to the web root),
 * so this literal is mirrored by hand. Adding a topic to TOPICS without
 * mirroring it here makes the topic invisible in the model editor AND (until
 * the edit-model-modal fix) silently strips it from any model bound to it.
 */
export const AVAILABLE_TOPICS = [
  // model lanes (text)
  { value: 'agents', label: 'Agents', description: 'All expert/worker agents — the main text lane. Every specialist resolves its model here unless the expert pins its own model or lane.' },
  { value: 'writing', label: 'Writing', description: 'Long-form text roles — Researcher, Writer, Project Manager, Communication. Split from Agents so this work can run on a cheaper/faster model. Unbound = these roles fail loud; bind a model or leave them on Agents.' },
  { value: 'chat', label: 'Chat', description: 'Casual conversations and direct replies. Also preferred by the orchestrator when bound; unbound = orchestrator uses the default model.' },
  { value: 'voice', label: 'Voice', description: 'Phone call conversations (Twilio/Telnyx/Plivo) — bind a fast model for low latency. Unbound = falls back to the default model.' },
  // automated background text tasks (one lane)
  { value: 'background', label: 'Background', description: 'Automated background tasks: memory extraction, knowledge-base review, evaluation, chunk summarization, tool-call translation. Bind a cheap/local model. Unbound = these features stay off.' },
  // non-text model classes
  { value: 'ocr', label: 'OCR', description: 'Text extraction from images and scanned documents' },
  { value: 'vision', label: 'Vision', description: 'Image understanding, description, and analysis' },
  { value: 'embedding', label: 'Embedding', description: 'Vector embeddings' },
] as const;

/**
 * Worker roles (tool bundles + base prompts) — used where the UI picks WHO
 * does the work (e.g. pipeline stages), as opposed to AVAILABLE_TOPICS above,
 * which are model lanes (WHICH model serves it). Pipeline `step.topic`
 * historically carries the role name; the backend canonicalizes it to the
 * 'agents' lane for model resolution.
 *
 * KEEP IN SYNC with src/core/orchestrator/roles/<name>/config.ts.
 */
export const WORKER_ROLES = [
  { value: 'general', label: 'General' },
  { value: 'coding', label: 'Coding' },
  { value: 'research', label: 'Research' },
  { value: 'architecture', label: 'Architecture' },
  { value: 'review', label: 'Review' },
  { value: 'communication', label: 'Communication' },
  { value: 'design', label: 'Design' },
  { value: 'devops', label: 'DevOps' },
  { value: 'security', label: 'Security' },
  { value: 'data', label: 'Data' },
  { value: 'ai', label: 'AI/ML' },
  { value: 'qa', label: 'QA' },
  { value: 'finance', label: 'Finance' },
  { value: 'automation', label: 'Automation' },
  { value: 'pm', label: 'Project Mgmt' },
  { value: 'writing', label: 'Writing' },
] as const;

/** Map LiteLLM provider prefix to our internal provider name */
export function mapLiteLLMProvider(provider: string): string {
  const map: Record<string, string> = {
    ollama: 'ollama',
    openai: 'openai',
    anthropic: 'anthropic',
    deepseek: 'deepseek',
    gemini: 'gemini',
    mistral: 'mistral',
    zai: 'zai',
    zhipuai: 'zai',
    moonshot: 'moonshot',
  };
  return map[provider] || provider;
}

/** Provider display labels */
export const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama (Local)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  gemini: 'Google Gemini',
  vertex: 'Vertex AI (Google)',
  grok: 'Grok (xAI)',
  mistral: 'Mistral AI',
  zai: 'Z.AI (GLM)',
  moonshot: 'Moonshot (Kimi)',
  openrouter: 'OpenRouter',
  voyage: 'Voyage AI (Embeddings)',
  cli: 'CLI (Subscription)',
  litellm: 'LiteLLM Proxy',
  'custom-openai': 'Custom (OpenAI-compatible)',
  'custom-anthropic': 'Custom (Anthropic-compatible)',
  'custom-gemini': 'Custom (Gemini-compatible)',
};

/** Default model capabilities by provider */
export const PROVIDER_DEFAULTS: Record<string, { contextWindow: number; maxTokens: number; supportsVision: boolean; supportsTools: boolean }> = {
  ollama: { contextWindow: 8192, maxTokens: 4096, supportsVision: false, supportsTools: true },
  openai: { contextWindow: 128000, maxTokens: 16384, supportsVision: true, supportsTools: true },
  anthropic: { contextWindow: 200000, maxTokens: 8192, supportsVision: true, supportsTools: true },
  deepseek: { contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsTools: true },
  gemini: { contextWindow: 1000000, maxTokens: 8192, supportsVision: true, supportsTools: true },
  grok: { contextWindow: 256000, maxTokens: 8192, supportsVision: true, supportsTools: true },
  mistral: { contextWindow: 128000, maxTokens: 8192, supportsVision: true, supportsTools: true },
  zai: { contextWindow: 200000, maxTokens: 128000, supportsVision: false, supportsTools: true },
  moonshot: { contextWindow: 256000, maxTokens: 8192, supportsVision: false, supportsTools: true },
  openrouter: { contextWindow: 128000, maxTokens: 16384, supportsVision: true, supportsTools: true },
  litellm: { contextWindow: 8192, maxTokens: 4096, supportsVision: false, supportsTools: true },
  'custom-openai': { contextWindow: 32000, maxTokens: 4096, supportsVision: false, supportsTools: true },
  'custom-anthropic': { contextWindow: 200000, maxTokens: 8192, supportsVision: false, supportsTools: true },
  'custom-gemini': { contextWindow: 1000000, maxTokens: 8192, supportsVision: false, supportsTools: true },
};
