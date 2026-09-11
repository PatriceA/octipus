/** Persisted per-model controls. Unset fields retain the provider default. */
export interface ProviderSettings {
  reasoningEffort?: 'low' | 'medium' | 'high';
  thinkingBudget?: number;
  strictTools?: boolean;
  cachePolicy?: 'default' | 'off' | 'session';
  cachedContent?: string;
}

export interface ModelPricing {
  /** USD per million tokens. Zero is an explicitly free rate. */
  cacheRead?: number;
  cacheWrite?: number;
  source?: string;
  verifiedAt?: string;
  free?: boolean;
}

export interface ProviderControls {
  reasoning: boolean;
  thinkingBudget: boolean;
  strictTools: boolean;
  cachePolicy: boolean;
  cachedContent: boolean;
}

export function anthropicNativeMessagesEnabled(value?: string): boolean {
  return value !== '0' && value !== 'false';
}

export function providerControls(provider: string, model = '', anthropicNative = true): ProviderControls {
  return {
    reasoning: ((provider === 'openai' || provider === 'openrouter') && /(?:^|\/)(?:gpt-[5-9]|o[1-9])/.test(model)) || (provider === 'gemini' && /gemini-(?:2\.5|[3-9])/.test(model)) || (provider === 'grok' && /grok-(?:3-mini|[4-9])/.test(model) && !model.includes('non-reasoning')) || (provider === 'anthropic' && /(?:opus|sonnet)-4-[6-9]|(?:opus|sonnet|fable|mythos)-[5-9]/.test(model)),
    thinkingBudget: provider === 'anthropic' && /(?:opus|sonnet|haiku)-4-[0-6]|claude-3[.-]7/.test(model),
    strictTools: ['openai', 'openrouter'].includes(provider) || (provider === 'anthropic' && anthropicNative && supportsClaudeStructuredOutput(model)),
    cachePolicy: ['openai', 'mistral', 'grok'].includes(provider) || (provider === 'anthropic' && anthropicNative),
    cachedContent: provider === 'gemini',
  };
}

export function validateProviderSettings(provider: string, model: string, settings: ProviderSettings | undefined, maxTokens = 4096, anthropicNative = true): string | null {
  if (!settings) return null;
  const controls = providerControls(provider, model, anthropicNative);
  if (settings.reasoningEffort && !controls.reasoning) return 'Reasoning effort is not supported for this provider/model.';
  if (settings.thinkingBudget != null && (!controls.thinkingBudget || settings.thinkingBudget >= maxTokens)) return 'Manual thinking budget must be supported by this model and smaller than its default output limit.';
  if (settings.thinkingBudget != null && settings.reasoningEffort) return 'Choose adaptive reasoning effort or a manual thinking budget, not both.';
  if (settings.strictTools && !controls.strictTools) return 'Strict tools are not supported by this provider configuration.';
  if (settings.cachedContent && !controls.cachedContent) return 'Cached content references require Gemini.';
  if (settings.cachePolicy && settings.cachePolicy !== 'default' && !controls.cachePolicy) return 'Cache hints are not configurable for this provider.';
  return null;
}

export function supportsClaudeStructuredOutput(model: string): boolean {
  return /(?:opus|sonnet|haiku)-4-[5-9]|(?:opus|sonnet|haiku|fable|mythos)-[5-9]/.test(model);
}
