import { anthropicNativeMessagesEnabled, type ProviderSettings, providerControls } from '@/shared/provider-settings';
import type { CompletionOptions } from './litellm-client';
import { cacheAffinityKey } from './providers/usage';

/** Only opt schemas into strict mode when doing so preserves optionality. */
export function strictSchema(schema: any): boolean {
  if (!schema || typeof schema !== 'object') return false;
  // Conservative intersection of supported strict-schema subsets. Leave richer
  // schemas untouched rather than changing their meaning or causing API 400s.
  if (!schema.type && !schema.enum && !schema.anyOf) return false;
  const validTypes = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type !== undefined && (types.length === 0 || types.some((type: unknown) => typeof type !== 'string' || !validTypes.has(type)))) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some((v: unknown) => v !== null && typeof v === 'object'))) return false;
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description', 'anyOf', 'title']);
  if (Object.keys(schema).some(key => !allowed.has(key))) return false;
  if (types.includes('object') || schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return false;
    if (schema.additionalProperties !== false) return false;
    if (!Array.isArray(schema.required)
      || Object.keys(schema.properties).some(k => !schema.required.includes(k))
      || schema.required.some((key: unknown) => typeof key !== 'string' || !Object.hasOwn(schema.properties, key))) return false;
    if (!Object.values(schema.properties).every(strictSchema)) return false;
  }
  if (types.includes('array') && !schema.items) return false;
  if (schema.items !== undefined && (!types.includes('array') || !strictSchema(schema.items))) return false;
  if (schema.anyOf !== undefined && (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0 || !schema.anyOf.every(strictSchema))) return false;
  return true;
}

export function applyProviderSettings(options: CompletionOptions, provider: string, settings?: ProviderSettings): CompletionOptions {
  const extra = { ...options.extraBody };
  const controls = providerControls(
    provider,
    options.model,
    provider !== 'anthropic' || anthropicNativeMessagesEnabled(process.env.ANTHROPIC_NATIVE_MESSAGES),
  );
  if (settings?.reasoningEffort && !controls.reasoning) throw new Error('Reasoning effort is not supported by this provider/model configuration');
  if (provider === 'anthropic' && settings?.reasoningEffort) {
    extra.thinking = { type: 'adaptive' };
    extra.output_config = { ...(extra.output_config as object), effort: settings.reasoningEffort };
  }
  if (settings?.reasoningEffort && ['openai', 'grok', 'openrouter', 'gemini'].includes(provider)) {
    extra.reasoning_effort = settings.reasoningEffort;
  }
  if (provider === 'gemini' && settings?.cachedContent) {
    const body = (extra.extra_body ?? {}) as Record<string, any>;
    extra.extra_body = { ...body, google: { ...body.google, cached_content: settings.cachedContent } };
  }
  if (provider === 'anthropic' && settings?.thinkingBudget && !settings.reasoningEffort) {
    if (!controls.thinkingBudget) throw new Error('Manual thinking budgets are not supported by this Claude model');
    if (settings.thinkingBudget >= (options.maxTokens ?? 4096)) throw new Error('Thinking budget must be smaller than max output tokens');
    extra.thinking = { type: 'enabled', budget_tokens: settings.thinkingBudget };
  }
  if (provider === 'openai' && settings?.cachePolicy === 'session') {
    const key = cacheAffinityKey(options.sessionId, options.userId);
    if (key) extra.prompt_cache_key = key;
  }
  // Cache suppression is only an Octipus explicit-cache control. Upstream
  // automatic caching cannot universally be disabled by a client.
  return {
    ...options, extraBody: extra,
    cachePolicy: options.cachePolicy ?? settings?.cachePolicy,
    tools: settings?.strictTools && controls.strictTools
      ? options.tools?.map(t => t.type === 'function' && strictSchema(t.function.parameters)
        ? { ...t, function: { ...t.function, strict: true } } : t)
      : options.tools,
  };
}
