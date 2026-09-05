/**
 * Types for the `hwfit` hardware-aware model recommender.
 * Re-exports the host probe shape so the scorer and routes share one contract.
 */
export type { HardwareProfile } from '@/setup/probes';

/** Known quantization labels a catalog entry may use. */
export const KNOWN_QUANTS = ['q4_0', 'q4_K_M', 'q5_K_M', 'q6_K', 'q8_0', 'fp16'] as const;
export type QuantLabel = (typeof KNOWN_QUANTS)[number];

/**
 * Topic-binding names a catalog entry may target. A focused subset of the
 * registry's topic vocabulary (see ModelRegistry) — the topics a local model
 * can actually serve. Catalog `topics` must be a subset of this set so a pick
 * is immediately bindable via `topicRoles`.
 */
export const KNOWN_TOPICS = ['general', 'chat', 'coding', 'research', 'vision', 'embedding'] as const;
export type CatalogTopic = (typeof KNOWN_TOPICS)[number];

/**
 * One pullable Ollama model in the curated catalog. This is the *editorial*
 * part — which models are worth recommending — and changes slowly. It carries
 * NO authoritative size: the real weights size is fetched live from the Ollama
 * registry at recommend-time (see sizing.ts). `vramHintMB` is only an offline
 * fallback when the registry is unreachable.
 */
export interface ModelCatalogEntry {
  /** Ollama tag, e.g. 'llama3.2:3b-instruct-q4_K_M'. */
  id: string;
  /** Model family, e.g. 'llama3.2'. */
  family: string;
  /** Parameter count, e.g. 3e9. */
  params: number;
  quant: QuantLabel;
  /** Topic-binding targets this model is suited for. */
  topics: CatalogTopic[];
  contextWindow: number;
  /** Offline fallback VRAM estimate (MB), used only when live sizing fails. */
  vramHintMB: number;
  notes?: string;
}

/** A catalog entry hydrated with a resolved VRAM size, ready for scoring. */
export interface SizedModel extends ModelCatalogEntry {
  /** Resolved VRAM need (MB) — from the live registry manifest, or the hint. */
  vramMB: number;
  /** Where vramMB came from, for UI trust ("exact" vs "estimated"). */
  sizeSource: 'live' | 'hint';
}

/**
 * How a model sits against the host's memory:
 *   - 'fits':     within the VRAM budget — ideal, full-speed.
 *   - 'overspill': over VRAM but within total system memory — Ollama can run it
 *     by spilling weights into RAM (shared-memory APUs, or partial GPU offload);
 *     runnable but slower.
 *   - 'too-big':  exceeds even the overspill budget — not runnable here.
 */
export type FitTier = 'fits' | 'overspill' | 'too-big';

/** A sized model scored against a concrete HardwareProfile. */
export interface ScoredModel {
  entry: SizedModel;
  /** Whether the model fits the VRAM budget at full speed (=== fitTier 'fits'). */
  fits: boolean;
  /** Three-way fit classification — see {@link FitTier}. */
  fitTier: FitTier;
  /** Budget headroom in MB (negative when it does not fit). For ranking. */
  fitMargin: number;
  /** Best-in-class pick for at least one of its topics that fits the budget. */
  recommended: boolean;
  /** Honest caveat shown to the user (e.g. when nothing fits and we fall back). */
  note?: string;
  /**
   * Which root agent mode this model implies if used as the default, derived
   * from its param count. Attached by the recommend route (needs config
   * thresholds), so optional on the pure scorer output.
   */
  promptTier?: 'full' | 'lite';
  /** Plain-language explanation of what `promptTier` means for the user. */
  promptTierNote?: string;
}
