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
 * Note: for MoE tags like `mixtral:8x7b` this picks up the `7b` (per-expert)
 * size, not the total — acceptable since such tags aren't in the catalog and
 * the caller treats unknown/odd sizes conservatively.
 */
export function deriveParamCount(modelId: string, metadata?: ModelMetadata | null): number | undefined {
  if (metadata?.paramCount && Number.isFinite(metadata.paramCount) && metadata.paramCount > 0) {
    return metadata.paramCount;
  }
  // Prefer the size token after the ':' tag separator; fall back to anywhere.
  const tag = modelId.includes(':') ? modelId.slice(modelId.indexOf(':') + 1) : modelId;
  const match = tag.match(/(\d+(?:\.\d+)?)\s*b\b/i) ?? modelId.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (!match) return undefined;
  const billions = Number.parseFloat(match[1]);
  if (!Number.isFinite(billions) || billions <= 0) return undefined;
  return Math.round(billions * 1_000_000_000);
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
