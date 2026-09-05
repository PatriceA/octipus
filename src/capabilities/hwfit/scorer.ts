/**
 * Pure fit-scoring over sized models. Given a HardwareProfile and catalog
 * entries already hydrated with a resolved VRAM size (see sizing.ts), compute a
 * usable budget, mark which models fit, and recommend the most capable model
 * that fits per topic. No I/O, no throwing — trivially testable.
 */
import {
  type CatalogTopic,
  type FitTier,
  type HardwareProfile,
  KNOWN_TOPICS,
  type ScoredModel,
  type SizedModel,
} from './types';

/** Fraction of detected VRAM left usable after KV-cache/context headroom. */
const VRAM_HEADROOM = 0.85;
/** On CPU-only hosts, how much of system RAM we are willing to spend on weights. */
const CPU_RAM_FRACTION = 0.5;
/** Hard cap on the CPU-only budget — bigger models are too slow to recommend. */
const CPU_VRAM_CAP_MB = 6000;
/**
 * Fraction of total system RAM Ollama may spill weights into beyond the ideal
 * (VRAM) budget. Shared-memory APUs and partial GPU offload let a model run
 * past VRAM — slower, but runnable — so models up to this ceiling are surfaced
 * as 'overspill' rather than hidden as too-big.
 */
const RAM_OVERSPILL_FRACTION = 0.8;

/** Ideal (full-speed) and overspill (runnable-but-slower) budgets, in MB. */
export interface FitBudget {
  /** Within this ⇒ 'fits' (full speed): VRAM*headroom, or the CPU-only budget. */
  idealMB: number;
  /** Within this (but over ideal) ⇒ 'overspill': capped by total system RAM. */
  overspillMB: number;
  /** True when `idealMB` came from one shared pool rather than a VRAM slice. */
  unified: boolean;
}

/** Caller-supplied facts the probe cannot establish on its own. */
export interface BudgetOptions {
  /**
   * Force the unified-memory budget. The probe proves this only on Apple
   * Silicon; on Linux an APU and a discrete card expose the same sysfs
   * surface, so an APU owner sets `hwfit.unifiedMemory` and gets scored
   * against the pool their GPU actually reaches.
   */
  unifiedMemory?: boolean;
}

/**
 * Compute the fit budgets (MB) for a host.
 * - GPU with known VRAM (NVIDIA, Apple unified, AMD via rocm-smi/sysfs): the
 *   ideal budget is VRAM * headroom; overspill extends into system RAM.
 * - CPU-only (no detectable VRAM): ideal is a capped fraction of RAM; overspill
 *   allows somewhat larger (but slow) models up to the RAM ceiling.
 */
export function computeBudgetMB(hw: HardwareProfile, opts: BudgetOptions = {}): FitBudget {
  const overspillMB = Math.floor(hw.ramMB * RAM_OVERSPILL_FRACTION);

  // Unified memory: the VRAM figure is a firmware carve-out from the same DRAM
  // the GPU reaches through GTT, at the same speed, so scoring against the
  // carve-out marks a model "spills into RAM, slower" when nothing spills and
  // nothing is slower. The budget is the pool — VRAM plus what the GPU can
  // also address — bounded by the overspill ceiling so the host keeps memory
  // to run in.
  const unified = opts.unifiedMemory === true || hw.gpus.some((g) => g.unifiedMemory);
  if (unified && hw.totalVramMB > 0) {
    const shared = hw.gpus.reduce((sum, g) => sum + (g.sharedMemoryMB ?? 0), 0);
    const poolMB = Math.floor((hw.totalVramMB + shared) * VRAM_HEADROOM);
    return { idealMB: Math.max(Math.min(poolMB, overspillMB), Math.floor(hw.totalVramMB * VRAM_HEADROOM)), overspillMB, unified: true };
  }

  if (hw.totalVramMB > 0) {
    return { idealMB: Math.floor(hw.totalVramMB * VRAM_HEADROOM), overspillMB, unified: false };
  }
  const cpuIdeal = Math.floor(Math.min(hw.ramMB * CPU_RAM_FRACTION, CPU_VRAM_CAP_MB));
  return { idealMB: cpuIdeal, overspillMB: Math.max(cpuIdeal, overspillMB), unified: false };
}

/** Classify a model's VRAM need against the host's fit budgets. */
function classifyFit(vramMB: number, budget: FitBudget): FitTier {
  if (vramMB <= budget.idealMB) return 'fits';
  if (vramMB <= budget.overspillMB) return 'overspill';
  return 'too-big';
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
export function scoreCatalog(
  hw: HardwareProfile,
  sized: readonly SizedModel[],
  opts: BudgetOptions = {},
): ScoredModel[] {
  const budget = computeBudgetMB(hw, opts);

  const scored: ScoredModel[] = sized.map((entry) => {
    const fitTier = classifyFit(entry.vramMB, budget);
    return {
      entry,
      fits: fitTier === 'fits',
      fitTier,
      fitMargin: budget.idealMB - entry.vramMB,
      recommended: false,
    };
  });

  // Recommend the most capable model per topic, preferring a full-speed fit but
  // falling back to a runnable overspill model when nothing fits VRAM outright.
  for (const topic of KNOWN_TOPICS) {
    const best = pickBestForTopic(scored, topic);
    if (best) {
      best.recommended = true;
      if (best.fitTier === 'overspill' && !best.note) {
        best.note = budget.unified
          ? 'Bigger than this machine can hold comfortably; runnable but leaves little headroom.'
          : 'Bigger than VRAM — Ollama will spill into RAM; runnable but slower.';
      }
    }
  }

  // Guarantee at least one suggestion. If nothing is even overspill-runnable,
  // promote the globally smallest model and flag it honestly.
  if (!scored.some((s) => s.recommended) && scored.length > 0) {
    const smallest = scored.reduce((a, b) => (b.entry.vramMB < a.entry.vramMB ? b : a));
    smallest.recommended = true;
    smallest.note = `Exceeds this machine's ~${budget.overspillMB} MB memory budget; may not run.`;
  }

  // Sort by tier (fits → overspill → too-big), then capability desc within tier.
  const tierRank: Record<FitTier, number> = { fits: 0, overspill: 1, 'too-big': 2 };
  return scored.sort((a, b) => {
    if (a.fitTier !== b.fitTier) return tierRank[a.fitTier] - tierRank[b.fitTier];
    if (a.fitTier === 'too-big') return b.fitMargin - a.fitMargin; // closest to fitting first
    return capabilityRank(b.entry) - capabilityRank(a.entry);
  });
}

/**
 * Most capable runnable model that serves `topic`, or null if none run. Prefers
 * a full-speed fit over an overspill model regardless of capability — a smaller
 * model that runs at full speed beats a larger one that thrashes into RAM.
 */
function pickBestForTopic(scored: ScoredModel[], topic: CatalogTopic): ScoredModel | null {
  let best: ScoredModel | null = null;
  for (const s of scored) {
    if (s.fitTier === 'too-big' || !s.entry.topics.includes(topic)) continue;
    if (!best) {
      best = s;
      continue;
    }
    // A full-speed fit always wins over overspill.
    if (best.fits !== s.fits) {
      if (s.fits) best = s;
      continue;
    }
    if (capabilityRank(s.entry) > capabilityRank(best.entry)) best = s;
  }
  return best;
}
