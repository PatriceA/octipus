export interface Model {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  endpoint?: string;
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
    cliAgent?: {
      permissionMode?: string;
      allowedTools?: string[];
      maxBudgetUsd?: number;
      mcpConfigPath?: string;
      extraArgs?: string[];
    };
  };
  health?: 'healthy' | 'unhealthy' | 'unknown';
}

export interface CLITool {
  name: string;
  available: boolean;
  modelPatterns: string[];
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

/** Topics used by the orchestrator for role-based model routing */
export const AVAILABLE_TOPICS = [
  { value: 'general', label: 'General', description: 'General-purpose tasks' },
  { value: 'coding', label: 'Coding', description: 'Code generation, shell, git' },
  { value: 'analysis', label: 'Analysis', description: 'Research, review, QA, code analysis' },
  { value: 'communication', label: 'Communication', description: 'Email, calendar, contacts (Google/Microsoft)' },
  { value: 'chat', label: 'Chat', description: 'Casual conversations' },
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
  cli: 'CLI (Subscription)',
  custom: 'Custom',
};

/** Default model capabilities by provider */
export const PROVIDER_DEFAULTS: Record<string, { contextWindow: number; maxTokens: number; supportsVision: boolean; supportsTools: boolean }> = {
  ollama: { contextWindow: 8192, maxTokens: 4096, supportsVision: false, supportsTools: true },
  openai: { contextWindow: 128000, maxTokens: 16384, supportsVision: true, supportsTools: true },
  anthropic: { contextWindow: 200000, maxTokens: 8192, supportsVision: true, supportsTools: true },
  deepseek: { contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsTools: true },
  gemini: { contextWindow: 1000000, maxTokens: 8192, supportsVision: true, supportsTools: true },
};
