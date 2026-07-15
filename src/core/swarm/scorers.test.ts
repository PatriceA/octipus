import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Scorer, deriveSchemaScorer, parseScorers, runScorers } from './scorers';

const ctx = { userId: 'system' as const };

async function run(scorers: Scorer[], output: unknown, notes?: string) {
  return runScorers(scorers, { output, notes }, ctx);
}

describe('deriveSchemaScorer (Phase B1)', () => {
  it('derives a json scorer with requiredKeys from the schema `required`', () => {
    const s = deriveSchemaScorer({ type: 'object', required: ['verdict', 'score'], properties: { verdict: {}, score: {}, notes: {} } });
    expect(s).toEqual({ kind: 'json', requiredKeys: ['verdict', 'score'] });
  });

  it('falls back to all property names when no `required` is declared', () => {
    const s = deriveSchemaScorer({ type: 'object', properties: { a: {}, b: {} } });
    expect(s).toEqual({ kind: 'json', requiredKeys: ['a', 'b'] });
  });

  it('returns null for a non-object / absent schema', () => {
    expect(deriveSchemaScorer(undefined)).toBeNull();
    expect(deriveSchemaScorer(null)).toBeNull();
    expect(deriveSchemaScorer('nope')).toBeNull();
    expect(deriveSchemaScorer([1, 2])).toBeNull();
  });

  it('enforces the shape end-to-end: prose fails, matching JSON passes', async () => {
    const scorer = deriveSchemaScorer({ required: ['verdict'], properties: { verdict: {} } })!;
    // A child that ignored the schema and returned prose → gate fails (loud).
    const prose = await run([scorer], 'The task looks fine to me.');
    expect(prose.passed).toBe(false);
    expect(prose.failures[0].reason).toMatch(/not valid JSON/);
    // Valid JSON missing the required key → still fails.
    const missing = await run([scorer], JSON.stringify({ other: 1 }));
    expect(missing.passed).toBe(false);
    expect(missing.failures[0].reason).toMatch(/missing required keys: verdict/);
    // Conforming JSON → passes.
    const ok = await run([scorer], JSON.stringify({ verdict: 'pass' }));
    expect(ok.passed).toBe(true);
  });
});

describe('runScorers — non_empty', () => {
  it('passes for non-empty output, fails for empty/whitespace', async () => {
    expect((await run([{ kind: 'non_empty' }], 'hello')).passed).toBe(true);
    const empty = await run([{ kind: 'non_empty' }], '   ');
    expect(empty.passed).toBe(false);
    expect(empty.failures[0].reason).toContain('empty');
  });

  it('treats a JSON-stringified object as non-empty', async () => {
    expect((await run([{ kind: 'non_empty' }], { a: 1 })).passed).toBe(true);
  });

  it('FAILS for null/undefined output (not a false pass on the JSON encoding)', async () => {
    expect((await run([{ kind: 'non_empty' }], null)).passed).toBe(false);
    expect((await run([{ kind: 'non_empty' }], undefined)).passed).toBe(false);
  });
});

describe('runScorers — contains', () => {
  it('checks output by default and notes when targeted', async () => {
    expect((await run([{ kind: 'contains', value: 'PASS' }], 'result: PASS')).passed).toBe(true);
    expect((await run([{ kind: 'contains', value: 'PASS' }], 'result: FAIL')).passed).toBe(false);
    expect(
      (await run([{ kind: 'contains', value: 'note', on: 'notes' }], 'x', 'a note here')).passed,
    ).toBe(true);
  });
});

describe('runScorers — regex', () => {
  it('matches a pattern with flags', async () => {
    expect((await run([{ kind: 'regex', pattern: '^\\d{3}$' }], '123')).passed).toBe(true);
    expect((await run([{ kind: 'regex', pattern: 'hello', flags: 'i' }], 'HELLO world')).passed).toBe(true);
    expect((await run([{ kind: 'regex', pattern: 'zzz' }], 'abc')).passed).toBe(false);
  });

  it('fails (does not throw) on an invalid regex pattern', async () => {
    const out = await run([{ kind: 'regex', pattern: '(' }], 'anything');
    expect(out.passed).toBe(false);
    expect(out.failures[0].reason).toContain('invalid regex');
  });
});

describe('runScorers — json', () => {
  it('passes for valid JSON string and rejects invalid JSON', async () => {
    expect((await run([{ kind: 'json' }], '{"a":1}')).passed).toBe(true);
    const bad = await run([{ kind: 'json' }], 'not json');
    expect(bad.passed).toBe(false);
    expect(bad.failures[0].reason).toContain('not valid JSON');
  });

  it('accepts an already-parsed object', async () => {
    expect((await run([{ kind: 'json' }], { a: 1 })).passed).toBe(true);
  });

  it('enforces requiredKeys', async () => {
    expect((await run([{ kind: 'json', requiredKeys: ['a', 'b'] }], { a: 1, b: 2 })).passed).toBe(true);
    const missing = await run([{ kind: 'json', requiredKeys: ['a', 'b'] }], { a: 1 });
    expect(missing.passed).toBe(false);
    expect(missing.failures[0].reason).toContain('b');
  });

  it('fails requiredKeys when output is an array or scalar', async () => {
    expect((await run([{ kind: 'json', requiredKeys: ['a'] }], [1, 2])).passed).toBe(false);
    expect((await run([{ kind: 'json', requiredKeys: ['a'] }], '5')).passed).toBe(false);
  });
});

describe('runScorers — file_exists', () => {
  it('passes when the file exists in the workspace and fails when it does not', async () => {
    // `system` user → flat workspace root from config. Use an absolute path
    // inside a temp dir, which the sandbox accepts via the resolver only if
    // under an allowed root; to keep the test hermetic we assert the negative
    // (missing file) deterministically and the positive via an allowed tmp path.
    const dir = mkdtempSync(join(tmpdir(), 'assistant-scorer-'));
    const file = join(dir, 'report.md');
    writeFileSync(file, '# done');

    // The legacy `/tmp/assistant-` prefix is an allowed extra root in the
    // WorkspaceFS sandbox, so an absolute path there resolves and exists.
    const present = await run([{ kind: 'file_exists', path: file }], 'x');
    expect(present.passed).toBe(true);

    const absent = await run([{ kind: 'file_exists', path: join(dir, 'missing.md') }], 'x');
    expect(absent.passed).toBe(false);
    expect(absent.failures[0].reason).toContain('does not exist');
  });
});

describe('runScorers — aggregation', () => {
  it('passes only when ALL scorers pass and reports every failure', async () => {
    const out = await run(
      [{ kind: 'non_empty' }, { kind: 'contains', value: 'X' }, { kind: 'json' }],
      'plain text',
    );
    expect(out.passed).toBe(false);
    expect(out.ran).toBe(3);
    // contains(X) and json both fail; non_empty passes.
    expect(out.failures).toHaveLength(2);
  });

  it('returns passed=true with no failures for an empty scorer list', async () => {
    const out = await run([], 'anything');
    expect(out.passed).toBe(true);
    expect(out.ran).toBe(0);
  });
});

describe('parseScorers — validation', () => {
  it('returns an empty list for missing input (opt-in)', () => {
    expect(parseScorers(undefined)).toEqual({ scorers: [] });
    expect(parseScorers(null)).toEqual({ scorers: [] });
  });

  it('parses every valid kind', () => {
    const result = parseScorers([
      { kind: 'non_empty' },
      { kind: 'contains', value: 'a', on: 'notes' },
      { kind: 'regex', pattern: 'x', flags: 'i' },
      { kind: 'json', requiredKeys: ['k'] },
      { kind: 'file_exists', path: 'f.md' },
    ]);
    expect('scorers' in result && result.scorers).toHaveLength(5);
  });

  it('drops an unknown `on` to undefined rather than erroring', () => {
    const result = parseScorers([{ kind: 'contains', value: 'a', on: 'bogus' }]);
    expect('scorers' in result).toBe(true);
    if ('scorers' in result) expect((result.scorers[0] as { on?: string }).on).toBeUndefined();
  });

  it('rejects non-array input', () => {
    expect(parseScorers({ kind: 'non_empty' })).toEqual({ error: 'scorers must be an array' });
  });

  it('rejects malformed entries with a specific message', () => {
    expect(parseScorers([{ kind: 'contains' }])).toHaveProperty('error');
    expect(parseScorers([{ kind: 'regex' }])).toHaveProperty('error');
    expect(parseScorers([{ kind: 'file_exists' }])).toHaveProperty('error');
    expect(parseScorers([{ kind: 'unknown_kind' }])).toHaveProperty('error');
    expect(parseScorers([{ kind: 'json', requiredKeys: [1, 2] }])).toHaveProperty('error');
  });

  it('caps the number of scorers', () => {
    const many = Array.from({ length: 21 }, () => ({ kind: 'non_empty' as const }));
    expect(parseScorers(many)).toEqual({ error: 'too many scorers (max 20)' });
  });

  it('rejects catastrophic-backtracking regex patterns (ReDoS)', () => {
    const r = parseScorers([{ kind: 'regex', pattern: '(a+)+$' }]);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('catastrophic backtracking');
    // A benign pattern is still accepted.
    expect('scorers' in parseScorers([{ kind: 'regex', pattern: '^\\d+$' }])).toBe(true);
  });

  it('rejects an over-long regex pattern', () => {
    const long = 'a'.repeat(201);
    expect(parseScorers([{ kind: 'regex', pattern: long }])).toHaveProperty('error');
  });
});
