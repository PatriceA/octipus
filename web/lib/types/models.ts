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
  // worker role topics (topic === role)
  { value: 'general', label: 'General', description: 'General-purpose tasks, browser interaction' },
  { value: 'coding', label: 'Coding', description: 'Code generation, shell, git' },
  { value: 'research', label: 'Research', description: 'Web search, information gathering, investigation' },
  { value: 'architecture', label: 'Architecture', description: 'Software architecture, requirements, system design' },
  { value: 'review', label: 'Review', description: 'Code review, PR review, quality analysis' },
  { value: 'communication', label: 'Communication', description: 'Email, calendar, contacts (Google/Microsoft)' },
  { value: 'design', label: 'Design', description: 'UI/UX design, layout, accessibility' },
  { value: 'devops', label: 'DevOps', description: 'CI/CD, Docker, infrastructure, deployment' },
  { value: 'security', label: 'Security', description: 'Security analysis, threat modeling, hardening' },
  { value: 'data', label: 'Data', description: 'Databases, data pipelines, SQL' },
  { value: 'ai', label: 'AI/ML', description: 'Machine learning, RAG, model training' },
  { value: 'qa', label: 'QA', description: 'Testing, browser testing, bug reports' },
  { value: 'finance', label: 'Finance', description: 'Financial analysis, market data' },
  { value: 'automation', label: 'Automation', description: 'Workflows, process orchestration' },
  { value: 'pm', label: 'Project Mgmt', description: 'Project planning, tracking, coordination' },
  { value: 'writing', label: 'Writing', description: 'Documentation, technical writing' },
  // orchestrator-direct / capability text topics
  { value: 'chat', label: 'Chat', description: 'Casual conversations' },
  { value: 'simple', label: 'Simple', description: 'Trivial single-step requests routed direct (no swarm)' },
  { value: 'local', label: 'Local', description: 'Local-model-preferred lightweight tasks' },
  { value: 'voice', label: 'Voice', description: 'Phone call conversations — use a fast model for low latency' },
  // automated background text tasks
  { value: 'memory_extraction', label: 'Memory Extraction', description: 'Long-term memory extractor + judge. Runs per turn — bind a cheap, fast model. Unbound = memory tier stays off.' },
  { value: 'knowledge_review', label: 'Knowledge Review', description: 'KB curation / review passes — bind a cheap model.' },
  { value: 'evaluation', label: 'Evaluation', description: 'LLM-as-judge for eval/conformance — use a fast deterministic model' },
  { value: 'summarization', label: 'Summarization', description: 'L0 abstracts for knowledge-base chunks (docs/files). Runs per chunk on import — bind a cheap/local model. Unbound = no abstracts generated.' },
  { value: 'tool_translation', label: 'Tool Translation', description: 'Toolshim: converts a weak/local model’s prose-instead-of-tool-call into a valid tool call. Runs only on the tool-call failure path — bind a small, reliable tool-calling model. Unbound = toolshim disabled (current behaviour).' },
  // non-text model classes
  { value: 'ocr', label: 'OCR', description: 'Text extraction from images and scanned documents' },
  { value: 'vision', label: 'Vision', description: 'Image understanding, description, and analysis' },
  { value: 'embedding', label: 'Embedding', description: 'Vector embeddings' },
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
  grok: 'Grok (xAI)',
  mistral: 'Mistral AI',
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
  openrouter: { contextWindow: 128000, maxTokens: 16384, supportsVision: true, supportsTools: true },
  litellm: { contextWindow: 8192, maxTokens: 4096, supportsVision: false, supportsTools: true },
  'custom-openai': { contextWindow: 32000, maxTokens: 4096, supportsVision: false, supportsTools: true },
  'custom-anthropic': { contextWindow: 200000, maxTokens: 8192, supportsVision: false, supportsTools: true },
  'custom-gemini': { contextWindow: 1000000, maxTokens: 8192, supportsVision: false, supportsTools: true },
};
