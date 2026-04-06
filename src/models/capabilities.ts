import type { ModelConfigEntry } from '@/db/schema/models';

export interface ModelCapabilities {
  multiturn: boolean;
  media: boolean;           // vision/image input
  tools: boolean;           // function calling
  streaming: boolean;
  systemRole: boolean;      // native system role support (Gemini converts to user turn)
  embeddings: boolean;
  structuredOutput: boolean; // JSON mode / structured output
}

/**
 * Provider-level capability defaults.
 * These are preset and reflect what the provider supports by design,
 * not user preference. Individual model DB flags (supportsTools,
 * supportsVision, supportsStreaming) override specific fields, but
 * cannot be changed by users through the API — they are derived from
 * the capabilities system.
 */
export const PROVIDER_CAPABILITY_DEFAULTS: Record<string, ModelCapabilities> = {
  ollama: {
    multiturn: true,
    media: false,
    tools: true,
    streaming: true,
    systemRole: true,
    embeddings: true,
    structuredOutput: false,
  },
  openai: {
    multiturn: true,
    media: true,
    tools: true,
    streaming: true,
    systemRole: true,
    embeddings: true,
    structuredOutput: true,
  },
  anthropic: {
    multiturn: true,
    media: true,
    tools: true,
    streaming: true,
    systemRole: true,
    embeddings: false,
    structuredOutput: false,
  },
  gemini: {
    multiturn: true,
    media: true,
    tools: true,
    streaming: true,
    // Gemini does not support a native system role — it is converted to a
    // user turn by the provider adapter.
    systemRole: false,
    embeddings: false,
    structuredOutput: false,
  },
  deepseek: {
    multiturn: true,
    media: false,
    tools: true,
    streaming: true,
    systemRole: true,
    embeddings: false,
    structuredOutput: true,
  },
  openrouter: {
    // OpenRouter is a multi-provider proxy; capabilities depend on the
    // underlying model. Default to all true (similar to litellm).
    multiturn: true,
    media: true,
    tools: true,
    streaming: true,
    systemRole: true,
    embeddings: false,
    structuredOutput: true,
  },
  voyage: {
    // Voyage AI is an embedding-only provider.
    multiturn: false,
    media: false,
    tools: false,
    streaming: false,
    systemRole: false,
    embeddings: true,
    structuredOutput: false,
  },
  cli: {
    // CLI-delegated models (Claude Code, Gemini CLI, Codex CLI).
    // They support multi-turn and tools via the CLI protocol, but do not
    // expose streaming or embeddings back to the assistant.
    multiturn: true,
    media: false,
    tools: true,
    streaming: false,
    systemRole: true,
    embeddings: false,
    structuredOutput: false,
  },
  litellm: {
    // LiteLLM is a proxy; capabilities depend on the underlying model.
    // Default to all true so the proxy never blocks a feature the
    // underlying model may support.
    multiturn: true,
    media: true,
    tools: true,
    streaming: true,
    systemRole: true,
    embeddings: true,
    structuredOutput: true,
  },
};

/**
 * Resolve the effective capabilities for a registered model.
 *
 * Resolution order (highest priority first):
 *  1. `model.metadata?.capabilities` — explicit per-model override stored in DB
 *  2. `PROVIDER_CAPABILITY_DEFAULTS[model.provider]` — provider preset
 *  3. DB boolean flags (`supportsTools`, `supportsVision`, `supportsStreaming`)
 *     applied on top of whichever base was chosen above
 *
 * The DB flags exist for legacy/compatibility but are treated as refinements,
 * not as user-settable preferences.  The API strips them from user updates.
 */
export function getCapabilitiesForModel(model: ModelConfigEntry): ModelCapabilities {
  // Start from provider defaults (or a safe all-false baseline for unknown providers)
  const providerDefaults: ModelCapabilities = PROVIDER_CAPABILITY_DEFAULTS[model.provider] ?? {
    multiturn: false,
    media: false,
    tools: false,
    streaming: false,
    systemRole: false,
    embeddings: false,
    structuredOutput: false,
  };

  // Merge any explicit per-model capability overrides stored in metadata
  const metaCapabilities = (model.metadata as any)?.capabilities as Partial<ModelCapabilities> | undefined;
  const base: ModelCapabilities = metaCapabilities
    ? { ...providerDefaults, ...metaCapabilities }
    : { ...providerDefaults };

  // Apply DB boolean flags as final overrides
  if (model.supportsTools !== undefined) {
    base.tools = model.supportsTools;
  }
  if (model.supportsVision !== undefined) {
    base.media = model.supportsVision;
  }
  if (model.supportsStreaming !== undefined) {
    base.streaming = model.supportsStreaming;
  }

  return base;
}
