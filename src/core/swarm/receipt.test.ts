import { describe, expect, it } from 'bun:test';
import {
  type SideEffectCounters,
  RECEIPT_NOT_CERTIFIED,
  buildReceipt,
  emptyCounters,
} from './receipt';

function counters(overrides: Partial<SideEffectCounters> = {}): SideEffectCounters {
  return { ...emptyCounters(), ...overrides };
}

describe('emptyCounters', () => {
  it('returns an all-zero, independent counter set', () => {
    const a = emptyCounters();
    const b = emptyCounters();
    expect(a).toEqual({
      toolCalls: 0,
      filesChanged: 0,
      commandsRun: 0,
      approvalsRequired: 0,
      approvalsDenied: 0,
      autoApproved: 0,
      permissionDenials: 0,
      toolErrors: 0,
      byName: {},
    });
    // Distinct instances — byName must not be shared.
    a.byName.foo = 1;
    expect(b.byName.foo).toBeUndefined();
  });
});

describe('buildReceipt', () => {
  it('carries the real counters through when the worker exposed them', () => {
    const c = counters({
      toolCalls: 5,
      filesChanged: 2,
      commandsRun: 1,
      byName: { filesystem__write_file: 2, shell__run: 1, websearch__search: 2 },
    });
    const r = buildReceipt({
      nodeId: 'n1',
      kind: 'agent',
      status: 'ok',
      counters: c,
      usedTokens: 1234,
      tokenCap: 80_000,
      durationMs: 4200,
    });

    expect(r.schemaVersion).toBe(1);
    expect(r.nodeId).toBe('n1');
    expect(r.kind).toBe('agent');
    expect(r.status).toBe('ok');
    expect(r.sideEffects).toBe(c);
    expect(r.tokens).toEqual({ used: 1234, cap: 80_000 });
    expect(r.durationMs).toBe(4200);
    expect(r.unavailable).toEqual([]);
    expect(r.notCertified).toBe(RECEIPT_NOT_CERTIFIED);
  });

  it('marks side-effects unavailable (NOT zero) when no counters were captured', () => {
    const r = buildReceipt({
      nodeId: 'n2',
      kind: 'subagent',
      status: 'ok',
      counters: null,
      usedTokens: 0,
      tokenCap: 30_000,
      durationMs: 10,
    });

    // Honesty rule: absence of evidence is recorded, not defaulted to "did nothing".
    expect(r.unavailable).toHaveLength(1);
    expect(r.unavailable[0]).toContain('sideEffects');
    // The numeric fields still exist (zeroed) so consumers don't crash, but
    // the caller is told they are not trustworthy via `unavailable`.
    expect(r.sideEffects).toEqual(emptyCounters());
  });

  it('preserves a failure status and its observed side-effects', () => {
    // A child can fail *after* doing real damage — the receipt must keep both.
    const c = counters({ toolCalls: 3, filesChanged: 1, toolErrors: 2, permissionDenials: 1 });
    const r = buildReceipt({
      nodeId: 'n3',
      kind: 'agent',
      status: 'tool_error',
      counters: c,
      usedTokens: 999,
      tokenCap: 80_000,
      durationMs: 50,
    });
    expect(r.status).toBe('tool_error');
    expect(r.sideEffects.filesChanged).toBe(1);
    expect(r.sideEffects.toolErrors).toBe(2);
    expect(r.sideEffects.permissionDenials).toBe(1);
    expect(r.unavailable).toEqual([]);
  });

  it('does not certify correctness or security', () => {
    const r = buildReceipt({
      nodeId: 'n4',
      kind: 'agent',
      status: 'ok',
      counters: emptyCounters(),
      usedTokens: 0,
      tokenCap: 1,
      durationMs: 0,
    });
    expect(r.notCertified).toContain('correctness');
    expect(r.notCertified).toContain('security');
  });
});
