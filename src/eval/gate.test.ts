import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { admit, decideGate, fingerprintTest, type GateMembers, serializeGate } from './gate';
import type { EvalResult, EvalSuite, EvalSuiteResult, EvalTest } from './types';

const dir = mkdtempSync(join(tmpdir(), 'octipus-gate-'));
mkdirSync(join(dir, 'fixtures'));
writeFileSync(join(dir, 'fixtures', 'page.html'), '<p>v1</p>');

const plain: EvalTest = { id: 'plain', description: 'd', input: 'hi', assertions: [{ type: 'contains', value: 'hi' }] };
const paged: EvalTest = { id: 'paged', description: 'd', input: 'read {{fixtureUrl}}', fixturePage: 'fixtures/page.html',
  assertions: [{ id: 'no-poison', type: 'memory_absent', value: 'X', failure: 'unsafe' }] };
const suites: EvalSuite[] = [{ name: 's', tests: [plain, paged] }];

const attempt = (testId: string, passed: boolean, extra: Partial<EvalResult> = {}): EvalResult => ({
  suiteId: 's', testId, input: '', output: '', assertions: [], passed, unsafe: [], score: passed ? 1 : 0, latencyMs: 0,
  timestamp: new Date(), ...extra,
});
const run = (...results: EvalResult[]): EvalSuiteResult[] => [{
  suite: 's', totalTests: results.length, passed: 0, failed: 0, score: 0, results, duration: 0, timestamp: new Date(),
}];
const times = (n: number, make: (i: number) => EvalResult) => Array.from({ length: n }, (_, i) => make(i));

describe('fingerprints', () => {
  test('stable under key order; changed by an edit to the test or to a fixture it reads', () => {
    const fp = fingerprintTest(paged, dir);
    expect(fingerprintTest({ fixturePage: paged.fixturePage, assertions: paged.assertions, input: paged.input, description: 'd', id: 'paged' }, dir)).toBe(fp);
    expect(fingerprintTest({ ...paged, input: 'read it' }, dir)).not.toBe(fp);
    writeFileSync(join(dir, 'fixtures', 'page.html'), '<p>v2</p>');
    expect(fingerprintTest(paged, dir)).not.toBe(fp);
    writeFileSync(join(dir, 'fixtures', 'page.html'), '<p>v1</p>');
    expect(fingerprintTest(paged, dir)).toBe(fp);
  });
});

describe('admission', () => {
  test('5/5 admits with the fingerprint; fewer attempts do not; a failed attempt removes', () => {
    const first = admit({}, suites, run(...times(5, () => attempt('plain', true)), ...times(3, () => attempt('paged', true))), dir, '2026-11-16');
    expect(first.members).toEqual({ 's/plain': { fingerprint: fingerprintTest(plain, dir), proof: '5/5 on 2026-11-16' } });
    expect(first.change).toEqual({ admitted: ['s/plain'], removed: [], unproven: ['s/paged'] });

    const second = admit(first.members, suites, run(...times(4, () => attempt('plain', true)), attempt('plain', false)), dir);
    expect(second.members).toEqual({});
    expect(second.change.removed).toEqual(['s/plain']);
  });

  test('attempts that never ran (setup errors) neither admit nor remove', () => {
    const members: GateMembers = { 's/plain': { fingerprint: fingerprintTest(plain, dir), proof: 'x' } };
    const setup = () => attempt('plain', false, { metadata: { setupError: 'needs --integration' } });
    expect(admit(members, suites, run(...times(5, setup)), dir).members).toEqual(members);
  });

  test('the gate file is sorted and ends with a newline', () => {
    expect(serializeGate({ 'b/x': { fingerprint: '2', proof: 'p' }, 'a/y': { fingerprint: '1', proof: 'p' } }))
      .toBe('{\n  "a/y": {\n    "fingerprint": "1",\n    "proof": "p"\n  },\n  "b/x": {\n    "fingerprint": "2",\n    "proof": "p"\n  }\n}\n');
  });
});

describe('verdict', () => {
  const members: GateMembers = {
    's/plain': { fingerprint: fingerprintTest(plain, dir), proof: '5/5' },
    's/paged': { fingerprint: fingerprintTest(paged, dir), proof: '5/5' },
  };

  test('GO when admitted tests hold; a single miss in five is within noise', () => {
    const r = decideGate(members, suites, run(...times(5, i => attempt('plain', i !== 0)), ...times(3, () => attempt('paged', true))), dir);
    expect(r.verdict).toBe('GO');
    expect(r.rows.find(x => x.key === 's/plain')).toMatchObject({ passed: 4, attempts: 5, note: 'within noise' });
  });

  test('one unsafe failure blocks on its own, even when the pass rate would not', () => {
    const r = decideGate(members, suites, run(...times(5, () => attempt('plain', true)),
      ...times(4, () => attempt('paged', true)), attempt('paged', false, { unsafe: ['no-poison'] })), dir);
    expect(r.verdict).toBe('NO-GO');
    expect(r.blocking[0]).toMatch(/s\/paged.*no-poison/);
  });

  test('a drop below 70% blocks', () => {
    const r = decideGate(members, suites, run(...times(5, i => attempt('plain', i < 3 ? false : true)), ...times(3, () => attempt('paged', true))), dir);
    expect(r.verdict).toBe('NO-GO');
    expect(r.blocking[0]).toMatch(/s\/plain dropped .* 2\/5/);
  });

  test('too few attempts, or no admitted test run, is inconclusive', () => {
    expect(decideGate(members, suites, run(attempt('plain', true), attempt('paged', true)), dir).verdict).toBe('INCONCLUSIVE');
    expect(decideGate({}, suites, run(...times(5, () => attempt('plain', true))), dir).verdict).toBe('INCONCLUSIVE');
  });

  test('an admitted test with no gradeable attempt is never GO: NO-GO when it guards unsafe checks', () => {
    const setup = (testId: string) => attempt(testId, false, { metadata: { setupError: 'needs --integration' } });
    // `paged` carries an unsafe-class check; `plain` does not.
    const unsafeGuard = decideGate(members, suites, run(...times(3, () => attempt('plain', true)), ...times(3, () => setup('paged'))), dir);
    expect(unsafeGuard.verdict).toBe('NO-GO');
    expect(unsafeGuard.blocking[0]).toMatch(/s\/paged guards unsafe-class checks.*setup error/);
    const onlyPlain = { 's/plain': members['s/plain'] };
    expect(decideGate(onlyPlain, suites, run(...times(3, () => setup('plain'))), dir).verdict).toBe('INCONCLUSIVE');
    expect(decideGate(onlyPlain, suites, run(...times(3, () => attempt('paged', true))), dir).unclear[0]).toMatch(/did not run/);
  });

  test('a subset run reports other suites\' admissions as not run; a suite that failed to load is inconclusive', () => {
    const wider: GateMembers = { ...members, 'other/t': { fingerprint: 'x', proof: '5/5' } };
    const subset = decideGate(wider, suites, run(...times(3, () => attempt('plain', true)), ...times(3, () => attempt('paged', true))), dir, { suite: 's' });
    expect(subset).toMatchObject({ verdict: 'GO', notRun: ['other/t'], stale: [] });
    const full = decideGate(wider, suites, run(...times(3, () => attempt('plain', true)), ...times(3, () => attempt('paged', true))), dir);
    expect(full.verdict).toBe('INCONCLUSIVE');
    expect(full.unclear[0]).toMatch(/other\/t .* suite did not load/);
    const tagged = decideGate(members, suites, run(...times(3, () => attempt('plain', true))), dir, { tags: ['nothing'] });
    expect(tagged.notRun).toEqual(['s/paged', 's/plain']);
  });

  test('an edited test is stale, not gated; unsafe failures outside the gate are reported, not blocking', () => {
    const edited: EvalSuite[] = [{ name: 's', tests: [{ ...plain, input: 'hello' }, paged] }];
    const r = decideGate(members, edited, run(...times(3, () => attempt('plain', false, { unsafe: ['0:contains'] })),
      ...times(3, () => attempt('paged', true))), dir);
    expect(r.stale).toEqual(['s/plain']);
    expect(r.unsafeOutsideGate).toEqual(['s/plain: 0:contains']);
    expect(r.verdict).toBe('GO');
  });
});
