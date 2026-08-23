import { describe, expect, test } from 'vitest';
import type { HardwareProfile } from '@/setup/probes';
import { MODEL_CATALOG } from './catalog';
import { computeBudgetMB, scoreCatalog } from './scorer';
import { KNOWN_TOPICS, type CatalogTopic, type SizedModel } from './types';

/** Hydrate the catalog using the offline hint (deterministic, no network). */
const SIZED: SizedModel[] = MODEL_CATALOG.map((m) => ({ ...m, vramMB: m.vramHintMB, sizeSource: 'hint' }));
const score = (hw: HardwareProfile) => scoreCatalog(hw, SIZED);

function gpuHost(vramMB: number, ramMB = 32000): HardwareProfile {
  return {
    gpus: [{ vendor: 'nvidia', name: 'Test GPU', vramMB }],
    totalVramMB: vramMB,
    ramMB,
    cpu: { cores: 16, arch: 'x64' },
    platform: 'linux',
    source: ['nvidia-smi', 'os'],
  };
}

function appleHost(ramMB: number): HardwareProfile {
  const vram = Math.floor(ramMB * 0.75);
  return {
    gpus: [{ vendor: 'apple', name: 'Apple Silicon (unified memory)', vramMB: vram }],
    totalVramMB: vram,
    ramMB,
    cpu: { cores: 10, arch: 'arm64' },
    platform: 'darwin',
    source: ['apple-metal', 'os'],
  };
}

function cpuHost(ramMB: number): HardwareProfile {
  return {
    gpus: [],
    totalVramMB: 0,
    ramMB,
    cpu: { cores: 8, arch: 'x64' },
    platform: 'linux',
    source: ['os'],
  };
}

const PROFILES: Record<string, HardwareProfile> = {
  '24GB GPU': gpuHost(24564),
  '12GB GPU': gpuHost(12288),
  '8GB GPU': gpuHost(8192),
  '4GB GPU': gpuHost(4096),
  'Apple 32GB unified': appleHost(32000),
  'CPU-only 16GB': cpuHost(16000),
  'CPU-only 4GB': cpuHost(4000),
};

describe('computeBudgetMB', () => {
  test('GPU ideal budget applies 0.85 headroom', () => {
    expect(computeBudgetMB(gpuHost(12288)).idealMB).toBe(Math.floor(12288 * 0.85));
  });

  test('GPU overspill budget extends into system RAM', () => {
    // Ideal is VRAM-bound; overspill is 0.8 * RAM, letting bigger models spill.
    const budget = computeBudgetMB(gpuHost(12288, 32000));
    expect(budget.overspillMB).toBe(Math.floor(32000 * 0.8));
    expect(budget.overspillMB).toBeGreaterThan(budget.idealMB);
  });

  test('CPU-only ideal budget is capped regardless of large RAM', () => {
    // 64GB RAM * 0.5 = 32000, but the cap holds it at 6000.
    expect(computeBudgetMB(cpuHost(64000)).idealMB).toBe(6000);
  });

  test('CPU-only small RAM uses the RAM fraction', () => {
    expect(computeBudgetMB(cpuHost(8000)).idealMB).toBe(4000);
  });
});

describe('scoreCatalog', () => {
  test('every profile yields at least one recommended runnable model', () => {
    for (const [name, hw] of Object.entries(PROFILES)) {
      const scored = score(hw);
      const recs = scored.filter((s) => s.recommended);
      expect(recs.length, `${name} should have >=1 recommendation`).toBeGreaterThanOrEqual(1);
    }
  });

  test('fits flag and tier match the computed budget', () => {
    const hw = gpuHost(8192);
    const budget = computeBudgetMB(hw);
    for (const s of score(hw)) {
      expect(s.fits).toBe(s.entry.vramMB <= budget.idealMB);
      const expectedTier =
        s.entry.vramMB <= budget.idealMB ? 'fits' : s.entry.vramMB <= budget.overspillMB ? 'overspill' : 'too-big';
      expect(s.fitTier).toBe(expectedTier);
    }
  });

  test('overspill tier surfaces models over VRAM but within RAM', () => {
    // Small VRAM, huge RAM: bigger models should land in the overspill tier
    // (runnable but slower) rather than too-big.
    const scored = score(gpuHost(8192, 64000));
    const overspill = scored.filter((s) => s.fitTier === 'overspill');
    expect(overspill.length).toBeGreaterThan(0);
    for (const s of overspill) {
      expect(s.entry.vramMB).toBeGreaterThan(Math.floor(8192 * 0.85));
      expect(s.entry.vramMB).toBeLessThanOrEqual(Math.floor(64000 * 0.8));
    }
  });

  test('a full-speed fit is preferred over a larger overspill model', () => {
    // 8GB VRAM but plenty of RAM — the chat pick must still be a VRAM-fitting
    // model, not a larger one that only runs via overspill.
    const hw = gpuHost(8192, 64000);
    const rec = topicRec(score(hw), 'chat');
    expect(rec).toBeTruthy();
    expect(rec!.fits).toBe(true);
  });

  test('a big GPU recommends a more capable chat model than a small GPU', () => {
    const bigRec = topicRec(score(gpuHost(24564)), 'chat');
    const smallRec = topicRec(score(gpuHost(4096)), 'chat');
    expect(bigRec).toBeTruthy();
    expect(smallRec).toBeTruthy();
    expect(bigRec!.entry.vramMB).toBeGreaterThan(smallRec!.entry.vramMB);
  });

  test('every recommended fitting model stays within budget', () => {
    for (const hw of Object.values(PROFILES)) {
      const budget = computeBudgetMB(hw);
      for (const s of score(hw)) {
        // A recommendation either fits the budget, or is the honest fallback with a note.
        if (s.recommended && !s.fits) {
          expect(s.note, 'non-fitting recommendation must carry a note').toBeTruthy();
        }
        if (s.recommended && s.fits) {
          expect(s.entry.vramMB).toBeLessThanOrEqual(budget.idealMB);
        }
      }
    }
  });

  test('weak hardware falls back to the smallest model with a note', () => {
    const scored = score(cpuHost(200)); // ~100 MB budget — below even embeddings
    const rec = scored.find((s) => s.recommended);
    expect(rec).toBeTruthy();
    expect(rec!.note).toBeTruthy();
    // Fallback is the globally smallest model.
    const smallest = Math.min(...MODEL_CATALOG.map((m) => m.vramHintMB));
    expect(rec!.entry.vramMB).toBe(smallest);
  });

  test('fitting models sort ahead of non-fitting ones', () => {
    const scored = score(gpuHost(8192));
    const firstNonFit = scored.findIndex((s) => !s.fits);
    if (firstNonFit !== -1) {
      // Nothing fitting appears after the first non-fitting entry.
      expect(scored.slice(firstNonFit).every((s) => !s.fits)).toBe(true);
    }
  });
});

function topicRec(scored: ReturnType<typeof scoreCatalog>, topic: CatalogTopic) {
  return scored.find((s) => s.recommended && s.entry.topics.includes(topic)) ?? null;
}

// Sanity: KNOWN_TOPICS is the set the recommender iterates.
test('KNOWN_TOPICS is non-empty', () => {
  expect(KNOWN_TOPICS.length).toBeGreaterThan(0);
});
