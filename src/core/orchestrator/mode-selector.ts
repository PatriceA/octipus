import type { ModelMetadata } from '@/db/schema/models';
import { coreLogger } from '@/utils/logger';

/**
 * Orchestrator execution modes. See `orchestratorConfigSchema.mode`.
 *   - router: no orchestrator LLM — classify → one specialist → relay (≤~10B)
 *   - lite:   shrunken LLM orchestrator, single-step delegation (~10–24B)
 *   - full:   full swarm orchestrator (≥~24B)
 */
export type OrchestratorMode = 'full' | 'lite' | 'router';

/** The size thresholds the selector keys off (from orchestrator config). */
export interface ModeThresholds {
  /** Below this param count → router. */
  routerSmallModelMaxParams: number;
  /** Below this (and ≥ router threshold) → lite. */
  liteModelMaxParams: number;
}

/** Minimal model shape the selector needs — a subset of ModelConfigEntry. */
export interface ModeModelMeta {
  modelId: string;
  metadata?: ModelMetadata | null;
}

/**
 * Map a parameter count to a mode using the configured thresholds. Shared by
 * the live selector and the hwfit recommend annotation so the wizard preview
 * and the runtime decision never disagree.
 */
export function paramCountToMode(params: number, thresholds: ModeThresholds): OrchestratorMode {
  if (params < thresholds.routerSmallModelMaxParams) return 'router';
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
export function describeMode(mode: OrchestratorMode): string {
  switch (mode) {
    case 'router':
      return 'router mode — routes each request to a single specialist; no multi-agent swarms or follow-up planning';
    case 'lite':
      return 'lite mode — a lightweight orchestrator that delegates one step at a time; no parallel swarms or pipelines';
    case 'full':
      return 'full mode — the complete orchestrator with parallel swarms, pipelines, and multi-step planning';
  }
}

/**
 * Annotate what orchestrator mode a model implies if used as the default,
 * from its known parameter count. Used by the hardware-scan / recommend UI so
 * the user sees what each model means for how Octipus will run.
 */
export function describeModeForParams(
  params: number,
  thresholds: ModeThresholds,
): { mode: OrchestratorMode; note: string } {
  const mode = paramCountToMode(params, thresholds);
  return { mode, note: describeMode(mode) };
}

/**
 * Resolve the orchestrator mode for a turn. An explicit config mode pins that
 * value; 'auto' derives it live from the model's parameter count so swapping
 * the default model changes the mode with no restart. Unknown size → lite
 * (loud), which is the safe middle band.
 */
export function resolveOrchestratorMode(
  model: ModeModelMeta,
  config: { mode: 'auto' | OrchestratorMode } & ModeThresholds,
): OrchestratorMode {
  if (config.mode !== 'auto') return config.mode;

  const params = deriveParamCount(model.modelId, model.metadata);
  if (params === undefined) {
    coreLogger.warn(
      { modelId: model.modelId },
      'Could not determine model size for orchestrator mode — defaulting to lite',
    );
    return 'lite';
  }
  const mode = paramCountToMode(params, config);
  coreLogger.debug({ modelId: model.modelId, params, mode }, 'Resolved orchestrator mode (auto)');
  return mode;
}
