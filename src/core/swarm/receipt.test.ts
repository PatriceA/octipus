import { describe, expect, it } from 'bun:test';
import {
  type SideEffectCounters,
  RECEIPT_NOT_CERTIFIED,
  buildReceipt,
  emptyCounters,
  mergeCounters,
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

// A pipeline STAGE is a tree: a worker that delegates records `spawn_child` and
// nothing else, while the shell commands live in its children's receipts.
describe('mergeCounters', () => {
  it('sums every tally and the per-tool breakdown', () => {
    const parent = counters({ toolCalls: 1, byName: { spawn_child: 1 } });
    const child = counters({
      toolCalls: 5, commandsRun: 3, filesChanged: 2, toolErrors: 1,
      byName: { shell__run: 3, filesystem__write_file: 2 },
    });
    const merged = mergeCounters(parent, child);
    expect(merged.toolCalls).toBe(6);
    expect(merged.commandsRun).toBe(3);
    expect(merged.filesChanged).toBe(2);
    expect(merged.toolErrors).toBe(1);
    expect(merged.byName).toEqual({ spawn_child: 1, shell__run: 3, filesystem__write_file: 2 });
  });

  it('adds counts for a tool both sides used', () => {
    const merged = mergeCounters(
      counters({ commandsRun: 2, byName: { shell__run: 2 } }),
      counters({ commandsRun: 4, byName: { shell__run: 4 } }),
    );
    expect(merged.byName.shell__run).toBe(6);
    expect(merged.commandsRun).toBe(6);
  });

  it('does not mutate either input', () => {
    const a = counters({ toolCalls: 1, byName: { x: 1 } });
    const b = counters({ toolCalls: 2, byName: { y: 2 } });
    mergeCounters(a, b);
    expect(a.byName).toEqual({ x: 1 });
    expect(b.byName).toEqual({ y: 2 });
    expect(a.toolCalls).toBe(1);
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
