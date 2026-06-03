import { describe, expect, test } from 'bun:test';
import { parseNvidiaSmi, probeHardware } from './probes';

describe('parseNvidiaSmi', () => {
  test('parses a single GPU line', () => {
    const out = 'NVIDIA GeForce RTX 3060, 12288\n';
    expect(parseNvidiaSmi(out)).toEqual([
      { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', vramMB: 12288 },
    ]);
  });

  test('parses multiple GPUs', () => {
    const out = 'NVIDIA A100-SXM4-40GB, 40960\nNVIDIA A100-SXM4-40GB, 40960\n';
    const gpus = parseNvidiaSmi(out);
    expect(gpus).toHaveLength(2);
    expect(gpus[0]?.vramMB).toBe(40960);
  });

  test('keeps commas inside the GPU name (splits on last comma only)', () => {
    const out = 'NVIDIA RTX A6000, Ada, 49140\n';
    expect(parseNvidiaSmi(out)).toEqual([
      { vendor: 'nvidia', name: 'NVIDIA RTX A6000, Ada', vramMB: 49140 },
    ]);
  });

  test('ignores blank and malformed lines', () => {
    const out = '\n  \nNVIDIA GeForce RTX 4090, 24564\ngarbage-no-comma\nName, notanumber\n';
    expect(parseNvidiaSmi(out)).toEqual([
      { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', vramMB: 24564 },
    ]);
  });

  test('drops non-positive VRAM', () => {
    expect(parseNvidiaSmi('Some GPU, 0\nOther GPU, -5\n')).toEqual([]);
  });

  test('returns empty for empty input', () => {
    expect(parseNvidiaSmi('')).toEqual([]);
  });
});

describe('probeHardware', () => {
  test('never throws and returns a coherent profile on this host', async () => {
    const hw = await probeHardware();
    expect(hw.ramMB).toBeGreaterThan(0);
    expect(hw.cpu.cores).toBeGreaterThan(0);
    expect(typeof hw.cpu.arch).toBe('string');
    expect(hw.source).toContain('os');
    // totalVramMB is always the sum of detected GPU VRAM.
    expect(hw.totalVramMB).toBe(hw.gpus.reduce((s, g) => s + g.vramMB, 0));
    // 0 GPUs ⇒ CPU-only (totalVramMB 0); the scorer must still cope.
    expect(hw.totalVramMB).toBeGreaterThanOrEqual(0);
  });
});
