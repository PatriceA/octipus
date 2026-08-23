import { describe, expect, test } from 'vitest';
import { getStats, ringBufferStream } from './log-stream';

// Feed newline-delimited JSON the way pino's multistream does.
function emit(records: Array<Record<string, unknown>>): void {
  ringBufferStream.write(`${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

describe('getStats rollups', () => {
  test('aggregates per-tool calls, errors and avg duration', () => {
    emit([
      { level: 30, msg: 'Tool executed', tool: 'unit-test-tool', durationMs: 100 },
      { level: 30, msg: 'Tool executed', tool: 'unit-test-tool', durationMs: 300 },
      { level: 50, msg: 'Tool failed', tool: 'unit-test-tool', durationMs: 200 },
    ]);
    const stats = getStats();
    const tool = stats.tools.find((t) => t.tool === 'unit-test-tool');
    expect(tool).toBeDefined();
    expect(tool?.calls).toBe(3);
    expect(tool?.errors).toBe(1);
    expect(tool?.avgMs).toBe(200);
    expect(tool?.errorRate).toBeCloseTo(1 / 3, 5);
  });

  test('aggregates per-provider calls and errors', () => {
    emit([
      { level: 30, msg: 'ok', provider: 'unit-test-provider' },
      { level: 50, msg: 'model boom', provider: 'unit-test-provider' },
    ]);
    const stats = getStats();
    const p = stats.providers.find((x) => x.provider === 'unit-test-provider');
    expect(p?.calls).toBe(2);
    expect(p?.errors).toBe(1);
  });

  test('tracks top error messages by count', () => {
    emit([
      { level: 50, msg: 'unit-test-unique-error' },
      { level: 50, msg: 'unit-test-unique-error' },
    ]);
    const stats = getStats();
    const e = stats.topErrors.find((x) => x.msg === 'unit-test-unique-error');
    expect(e?.count).toBe(2);
  });
});
