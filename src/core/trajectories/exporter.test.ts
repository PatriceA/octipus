import { describe, expect, test } from 'vitest';
import { exportFromJsonl, shouldExport, toTrainingExample } from './exporter';
import type { TrajectoryRecord } from './types';

function record(over: Partial<TrajectoryRecord> = {}): TrajectoryRecord {
  return {
    schemaVersion: 1,
    rootSessionId: 's1',
    userId: 'u1',
    startedAt: '2026-07-10T12:00:00.000Z',
    endedAt: '2026-07-10T12:00:05.000Z',
    userMessage: 'hello',
    classification: { confidence: 0.9, topic: 'coding', complexity: 'moderate' },
    steps: [{ timestamp: '2026-07-10T12:00:01.000Z', kind: 'llm_call' }],
    finalResponse: 'hi there',
    outcome: 'success',
    totalTokens: 100,
    modelsUsed: ['m1'],
    expertsUsed: [],
    piiRedacted: false,
    ...over,
  };
}

describe('shouldExport', () => {
  test('outcome filter keeps only matching runs', () => {
    expect(shouldExport(record({ outcome: 'success' }), { outcome: 'success' })).toBe(true);
    expect(shouldExport(record({ outcome: 'failure' }), { outcome: 'success' })).toBe(false);
  });

  test('date range filters on startedAt (inclusive bounds)', () => {
    const r = record({ startedAt: '2026-07-10T12:00:00.000Z' });
    expect(shouldExport(r, { from: new Date('2026-07-01'), to: new Date('2026-07-31') })).toBe(true);
    expect(shouldExport(r, { from: new Date('2026-07-11') })).toBe(false);
    expect(shouldExport(r, { to: new Date('2026-07-09') })).toBe(false);
  });

  test('no filters ⇒ everything passes', () => {
    expect(shouldExport(record(), {})).toBe(true);
  });
});

describe('toTrainingExample', () => {
  test('produces a user→assistant chat pair with metadata', () => {
    const ex = toTrainingExample(record());
    expect(ex.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    expect(ex.meta.outcome).toBe('success');
    expect(ex.meta.topic).toBe('coding');
    expect(ex.meta.steps).toBe(1);
    expect(ex.meta.totalTokens).toBe(100);
  });

  test('re-runs the PII filter at export time (belt and braces)', () => {
    const ex = toTrainingExample(
      record({ userMessage: 'my ssn is 123-45-6789', finalResponse: 'email me at a@b.com' }),
    );
    expect(ex.messages[0].content).not.toContain('123-45-6789');
    expect(ex.messages[1].content).not.toContain('a@b.com');
  });
});

describe('exportFromJsonl', () => {
  test('parses, filters, and counts — malformed lines are counted not thrown', () => {
    const body = [
      JSON.stringify(record({ outcome: 'success' })),
      JSON.stringify(record({ outcome: 'failure' })),
      '{ not valid json',
      '',
    ].join('\n');

    const res = exportFromJsonl(body, { outcome: 'success' });
    expect(res.scanned).toBe(3); // blank line skipped before counting
    expect(res.malformed).toBe(1);
    expect(res.filtered).toBe(1); // the failure run
    expect(res.examples).toHaveLength(1);
    expect(res.examples[0].meta.outcome).toBe('success');
  });
});
