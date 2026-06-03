/**
 * Pure fit-scoring over sized models. Given a HardwareProfile and catalog
 * entries already hydrated with a resolved VRAM size (see sizing.ts), compute a
 * usable budget, mark which models fit, and recommend the most capable model
 * that fits per topic. No I/O, no throwing — trivially testable.
 */
import { type CatalogTopic, type HardwareProfile, KNOWN_TOPICS, type ScoredModel, type SizedModel } from './types';

/** Fraction of detected VRAM left usable after KV-cache/context headroom. */
const VRAM_HEADROOM = 0.85;
/** On CPU-only hosts, how much of system RAM we are willing to spend on weights. */
const CPU_RAM_FRACTION = 0.5;
/** Hard cap on the CPU-only budget — bigger models are too slow to recommend. */
const CPU_VRAM_CAP_MB = 6000;

/**
 * Compute the usable model-weights budget (MB) for a host.
 * - GPU present (NVIDIA/AMD/Apple-unified): VRAM * headroom.
 * - CPU-only: a capped fraction of system RAM, since CPU inference is slow.
 */
export function computeBudgetMB(hw: HardwareProfile): number {
  if (hw.totalVramMB > 0) {
    return Math.floor(hw.totalVramMB * VRAM_HEADROOM);
  }
  return Math.floor(Math.min(hw.ramMB * CPU_RAM_FRACTION, CPU_VRAM_CAP_MB));
}

/** Higher is more capable, used to break ties within a topic. */
function capabilityRank(entry: SizedModel): number {
  // Bigger footprint ≈ more capable; quant/param differences fold into vramMB.
  return entry.vramMB;
}

/**
 * Score every sized model against the host. Returns entries sorted with the
 * most capable fitting models first, then non-fitting by closeness to budget.
 * Always marks at least one model `recommended` so the caller has something to
 * offer even on weak hardware (with an honest `note` when it overflows budget).
 */
export function scoreCatalog(hw: HardwareProfile, sized: readonly SizedModel[]): ScoredModel[] {
  const budget = computeBudgetMB(hw);

  const scored: ScoredModel[] = sized.map((entry) => ({
    entry,
    fits: entry.vramMB <= budget,
    fitMargin: budget - entry.vramMB,
    recommended: false,
  }));

  // Recommend the most capable fitting model per topic.
  for (const topic of KNOWN_TOPICS) {
    const best = pickBestForTopic(scored, topic);
    if (best) best.recommended = true;
  }

  // Guarantee at least one runnable suggestion. If nothing fits the budget,
  // promote the globally smallest model and flag it honestly.
  if (!scored.some((s) => s.recommended) && scored.length > 0) {
    const smallest = scored.reduce((a, b) => (b.entry.vramMB < a.entry.vramMB ? b : a));
    smallest.recommended = true;
    smallest.note = `Exceeds the detected ~${budget} MB budget; may run slowly or not at all.`;
  }

  // Sort: fitting first, then by capability desc; non-fitting by least overflow.
  return scored.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    if (a.fits) return capabilityRank(b.entry) - capabilityRank(a.entry);
    return b.fitMargin - a.fitMargin; // both negative; closest to fitting first
  });
}

/** Most capable fitting model that serves `topic`, or null if none fit. */
function pickBestForTopic(scored: ScoredModel[], topic: CatalogTopic): ScoredModel | null {
  let best: ScoredModel | null = null;
  for (const s of scored) {
    if (!s.fits || !s.entry.topics.includes(topic)) continue;
    if (!best || capabilityRank(s.entry) > capabilityRank(best.entry)) best = s;
  }
  return best;
}
