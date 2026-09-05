import type { ModelMetadata } from '@/db/schema/models';
import { coreLogger } from '@/utils/logger';

/**
 * Root-agent PROMPT tiers. See `agentConfigSchema.promptTier`.
 *   - lite: shrunken prompt, capped tool set and iterations (< ~24B)
 *   - full: the whole prompt, the whole toolset, swarms and pipelines
 *
 * A tier is a prompt size, NOT a control-flow branch. The `router` mode — a
 * keyword table that dispatched one specialist with no root LLM at all — was
 * deleted in Phase 9 of the rebuild plan along with the rest of the routing
 * hop. A small model now runs the same single loop as any other, with fewer
 * tools and a hard iteration cap.
 */
export type PromptTier = 'full' | 'lite';

/** The size thresholds the selector keys off (from root agent config). */
export interface ModeThresholds {
  /**
   * The "small model" threshold: below this a model gets the trimmed prompt and
   * tool set everywhere (`isSmallModel`). Named for the mode it used to select;
   * kept because every other small-model gate reads the same key.
   */
  smallModelMaxParams: number;
  /** Below this → lite. */
  liteModelMaxParams: number;
}

/** Minimal model shape the selector needs — a subset of ModelConfigEntry. */
export interface ModeModelMeta {
  modelId: string;
  metadata?: ModelMetadata | null;
  /** Used to pick a sane mode when the param count is unknown (see resolvePromptTier). */
  provider?: string;
}

/**
 * Providers that only ever host frontier/hosted models. When a model's size is
 * unparseable, one of these implies a capable model → `full` (so `gpt-4o` /
 * `claude-*` aren't throttled to lite for lacking an `Nb` tag). An ALLOWLIST,
 * not a denylist: an unknown/custom/self-hosted provider (`vllm`, `custom-*`,
 * `litellm` proxy) could be fronting a small local model, so it stays `lite`
 * (the safe middle band) rather than being optimistically promoted to full.
 */
const FRONTIER_CLOUD_PROVIDERS = new Set([
  'openai', 'anthropic', 'google', 'gemini', 'deepseek', 'openrouter',
  'xai', 'grok', 'mistral', 'zai', 'moonshot', 'groq', 'cohere', 'perplexity', 'together',
  'fireworks', 'cli',
]);

/**
 * Map a parameter count to a mode using the configured thresholds. Shared by
 * the live selector and the hwfit recommend annotation so the wizard preview
 * and the runtime decision never disagree.
 */
export function paramCountToTier(params: number, thresholds: ModeThresholds): PromptTier {
  if (params < thresholds.liteModelMaxParams) return 'lite';
  return 'full';
}

/**
 * Best-effort parameter count for a model. Prefers an explicit
 * `metadata.paramCount`; otherwise parses the size out of the model id tag
 * (`qwen2.5:32b-instruct-q4_K_M` → 32e9, `llama3.2:1b` → 1e9). Returns
 * undefined when no size can be determined.
 *
 * MoE tags like `mixtral:8x7b` are expanded to the aggregate (8 × 7B = 56B),
 * not the per-expert size, so a capable MoE model isn't mistaken for a tiny one.
 */
export function deriveParamCount(modelId: string, metadata?: ModelMetadata | null): number | undefined {
  if (metadata?.paramCount && Number.isFinite(metadata.paramCount) && metadata.paramCount > 0) {
    return metadata.paramCount;
  }
  // Prefer the size token after the ':' tag separator; fall back to anywhere.
  const tag = modelId.includes(':') ? modelId.slice(modelId.indexOf(':') + 1) : modelId;

  // MoE first: 'NxMb' (e.g. '8x7b') ≈ N experts × M params each.
  const moe = tag.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/i) ?? modelId.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/i);
  if (moe) {
    const total = Number.parseInt(moe[1], 10) * Number.parseFloat(moe[2]);
    if (Number.isFinite(total) && total > 0) return Math.round(total * 1_000_000_000);
  }

  const match = tag.match(/(\d+(?:\.\d+)?)\s*b\b/i) ?? modelId.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (!match) return undefined;
  const billions = Number.parseFloat(match[1]);
  if (!Number.isFinite(billions) || billions <= 0) return undefined;
  return Math.round(billions * 1_000_000_000);
}

/** Plain-language explanation of what a mode means for the end user. */
export function describeTier(mode: PromptTier): string {
  switch (mode) {
    case 'lite':
      return 'lite mode — a trimmed prompt, a capped tool set and few iterations; one delegation per request, no parallel swarms or pipelines';
    case 'full':
      return 'full mode — the whole toolset, parallel swarms, pipelines, and multi-step planning';
  }
}

/**
 * Annotate which prompt tier a model implies if used as the default,
 * from its known parameter count. Used by the hardware-scan / recommend UI so
 * the user sees what each model means for how Octipus will run.
 */
export function describeTierForParams(
  params: number,
  thresholds: ModeThresholds,
): { mode: PromptTier; note: string } {
  const mode = paramCountToTier(params, thresholds);
  return { mode, note: describeTier(mode) };
}

/**
 * Resolve the root agent's prompt tier for a turn. An explicit config mode pins that
 * value; 'auto' derives it live from the model's parameter count so swapping
 * the default model changes the mode with no restart. Unknown size → lite
 * (loud), which is the safe middle band.
 */
export function resolvePromptTier(
  model: ModeModelMeta,
  config: { mode: 'auto' | PromptTier } & ModeThresholds,
): PromptTier {
  if (config.mode !== 'auto') return config.mode;

  const params = deriveParamCount(model.modelId, model.metadata);
  if (params === undefined) {
    // No size signal. A known frontier-cloud provider is capable → full; every
    // other case (local runner, custom/proxy provider, no provider) → lite (the
    // safe middle band). This stops `gpt-4o` / `claude-*` (no `Nb` tag) being
    // throttled to lite, without optimistically promoting an unknown provider.
    const provider = (model.provider ?? '').toLowerCase();
    if (FRONTIER_CLOUD_PROVIDERS.has(provider)) {
      coreLogger.debug(
        { modelId: model.modelId, provider },
        'No size for cloud model — prompt tier = full',
      );
      return 'full';
    }
    coreLogger.warn(
      { modelId: model.modelId, provider },
      'Could not determine model size for the prompt tier — defaulting to lite',
    );
    return 'lite';
  }
  const mode = paramCountToTier(params, config);
  coreLogger.debug({ modelId: model.modelId, params, mode }, 'Resolved prompt tier (auto)');
  return mode;
}
