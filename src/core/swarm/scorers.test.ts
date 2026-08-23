import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Scorer,
  deriveCodeDiffScorer,
  deriveSchemaScorer,
  deriveToolOutageScorer,
  parseScorers,
  runScorers,
} from './scorers';

const ctx = { userId: 'system' as const };

async function run(scorers: Scorer[], output: unknown, notes?: string) {
  return runScorers(scorers, { output, notes }, ctx);
}

describe('deriveSchemaScorer (Phase B1)', () => {
  it('derives a json+object scorer with requiredKeys from the schema `required`', () => {
    const s = deriveSchemaScorer({ type: 'object', required: ['verdict', 'score'], properties: { verdict: {}, score: {}, notes: {} } });
    expect(s).toEqual({ kind: 'json', requiredKeys: ['verdict', 'score'], object: true });
  });

  it('does NOT promote optional properties to required (JSON-Schema is optional-by-default)', () => {
    // properties but no `required` → requiredKeys empty; object-ness still enforced.
    const s = deriveSchemaScorer({ type: 'object', properties: { a: {}, b: {} } });
    expect(s).toEqual({ kind: 'json', requiredKeys: [], object: true });
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
    expect((await run([scorer], JSON.stringify({ verdict: 'pass' }))).passed).toBe(true);
    // Conforming JSON wrapped in a ```json fence → still passes (fence tolerated).
    expect((await run([scorer], '```json\n{"verdict":"pass"}\n```')).passed).toBe(true);
  });

  it('object-ness is enforced even with no required keys (rejects bare non-objects)', async () => {
    const scorer = deriveSchemaScorer({ type: 'object' })!; // requiredKeys: []
    expect((await run([scorer], '42')).passed).toBe(false);
    expect((await run([scorer], 'null')).passed).toBe(false);
    expect((await run([scorer], '[1,2]')).passed).toBe(false);
    expect((await run([scorer], '{"anything":true}')).passed).toBe(true);
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

describe('side_effect scorer (receipt-vs-claim)', () => {
  function receipt(over: Partial<{ filesChanged: number; commandsRun: number; toolErrors: number; toolCalls: number; unavailable: string[] }> = {}) {
    return {
      schemaVersion: 1 as const,
      nodeId: 'n1',
      kind: 'agent' as const,
      status: 'ok' as const,
      sideEffects: {
        toolCalls: over.toolCalls ?? 5,
        filesChanged: over.filesChanged ?? 0,
        commandsRun: over.commandsRun ?? 0,
        approvalsRequired: 0,
        approvalsDenied: 0,
        autoApproved: 0,
        permissionDenials: 0,
        toolErrors: over.toolErrors ?? 0,
        byName: {},
      },
      tokens: { used: 1, cap: 100 },
      durationMs: 1,
      unavailable: over.unavailable ?? [],
      notCertified: ['correctness', 'security'],
    };
  }

  it('fails a confident claim contradicted by zero files changed', async () => {
    const out = await runScorers(
      [{ kind: 'side_effect', minFilesChanged: 1 }],
      { output: 'Implemented the feature successfully! All changes are in place.', receipt: receipt() },
      ctx,
    );
    expect(out.passed).toBe(false);
    expect(out.failures[0].reason).toContain('filesChanged=0');
  });

  it('passes when the evidence backs the claim', async () => {
    const out = await runScorers(
      [{ kind: 'side_effect', minFilesChanged: 1 }],
      { output: 'done', receipt: receipt({ filesChanged: 3 }) },
      ctx,
    );
    expect(out.passed).toBe(true);
  });

  it('does NOT fail when counters were unobservable — a CLI worker must not be gated on evidence it cannot emit', async () => {
    const out = await runScorers(
      [{ kind: 'side_effect', minFilesChanged: 1 }],
      { output: 'done', receipt: receipt({ unavailable: ['sideEffects: worker did not expose tool-execution counters'] }) },
      ctx,
    );
    expect(out.passed).toBe(true);
  });

  it('does NOT fail when there is no receipt at all', async () => {
    const out = await runScorers([{ kind: 'side_effect', minFilesChanged: 1 }], { output: 'done' }, ctx);
    expect(out.passed).toBe(true);
  });

  // Same false positive the pipeline evidence gate had: `filesChanged` counts
  // only file-mutating TOOL calls, so a child that wrote via `shell__run` reads
  // as zero while the files are plainly on disk.
  it('passes a shell-only writer when the workspace diff shows the files', async () => {
    const out = await runScorers(
      [{ kind: 'side_effect', minFilesChanged: 1 }],
      { output: 'wrote it with a heredoc', receipt: receipt({ commandsRun: 4 }) },
      { ...ctx, filesTouched: 2 },
    );
    expect(out.passed).toBe(true);
  });

  it('still fails when the workspace diff agrees nothing changed', async () => {
    const out = await runScorers(
      [{ kind: 'side_effect', minFilesChanged: 1 }],
      { output: 'Implemented it!', receipt: receipt() },
      { ...ctx, filesTouched: 0 },
    );
    expect(out.passed).toBe(false);
    expect(out.failures[0].reason).toContain('0 file(s) differ in the workspace');
  });

  it('an unmeasured workspace cannot rescue the miss — null is not evidence', async () => {
    const out = await runScorers(
      [{ kind: 'side_effect', minFilesChanged: 1 }],
      { output: 'Implemented it!', receipt: receipt() },
      { ...ctx, filesTouched: null },
    );
    expect(out.passed).toBe(false);
    expect(out.failures[0].reason).not.toContain('differ in the workspace');
  });

  it('checks commandsRun and toolErrors bounds', async () => {
    const noCmds = await runScorers(
      [{ kind: 'side_effect', minCommandsRun: 1 }],
      { output: 'tests pass!', receipt: receipt({ filesChanged: 2 }) },
      ctx,
    );
    expect(noCmds.passed).toBe(false);
    expect(noCmds.failures[0].reason).toContain('commandsRun=0');

    const errored = await runScorers(
      [{ kind: 'side_effect', maxToolErrors: 0 }],
      { output: 'all good', receipt: receipt({ toolErrors: 2 }) },
      ctx,
    );
    expect(errored.passed).toBe(false);
    expect(errored.failures[0].reason).toContain('toolErrors=2');
  });

  it('parses bounds and rejects malformed ones', () => {
    expect(parseScorers([{ kind: 'side_effect', minFilesChanged: 1 }])).toEqual({
      scorers: [{ kind: 'side_effect', minFilesChanged: 1 }],
    });
    expect(parseScorers([{ kind: 'side_effect' }])).toHaveProperty('error');
    expect(parseScorers([{ kind: 'side_effect', minFilesChanged: -1 }])).toHaveProperty('error');
    expect(parseScorers([{ kind: 'side_effect', minFilesChanged: 1.5 }])).toHaveProperty('error');
  });
});

describe('deriveCodeDiffScorer', () => {
  it('gates a declared code-diff deliverable on at least one file changed', () => {
    expect(deriveCodeDiffScorer('code-diff')).toEqual({ kind: 'side_effect', minFilesChanged: 1 });
  });

  it('does not gate any other shape — a summary child was never meant to write', () => {
    for (const shape of ['summary', 'markdown', 'list', 'json', undefined]) {
      expect(deriveCodeDiffScorer(shape)).toBeNull();
    }
  });
});

describe('tool-outage gate (requireWorkingTools)', () => {
  // Regression for a measured failure: a research child made 5 web searches,
  // every one failed because every search engine was blocked, and after a
  // retry the run returned a confident, entirely unsourced answer as `ok`.
  //
  // `byName` is the source of truth (the real counters derive `toolCalls`
  // from it), so the fixture takes byName and derives the total the same way.
  function receipt(over: { byName?: Record<string, number>; toolErrors?: number; unavailable?: string[] } = {}) {
    const byName = over.byName ?? {};
    return {
      schemaVersion: 1 as const,
      nodeId: 'n1',
      kind: 'agent' as const,
      status: 'ok' as const,
      sideEffects: {
        toolCalls: Object.values(byName).reduce((a, b) => a + b, 0),
        filesChanged: 0,
        commandsRun: 0,
        approvalsRequired: 0,
        approvalsDenied: 0,
        autoApproved: 0,
        permissionDenials: 0,
        toolErrors: over.toolErrors ?? 0,
        byName,
      },
      tokens: { used: 1, cap: 100 },
      durationMs: 1,
      unavailable: over.unavailable ?? [],
      notCertified: ['correctness', 'security'],
    };
  }

  it('fails a polished answer produced while every tool call was failing', async () => {
    const out = await runScorers(
      [deriveToolOutageScorer()],
      {
        output: 'Day 1: drive to Berchtesgaden, eat at Gasthof Malerwinkel...',
        receipt: receipt({ toolErrors: 5 }),
      },
      ctx,
    );
    expect(out.passed).toBe(false);
    expect(out.failures[0].reason).toContain('every tool call failed');
  });

  it('delegation does not count as a working tool — the exact shape of the measured failure', () => {
    // The real node: 5 web searches failed, spawn_child succeeded. Counting
    // that meta-call as "a tool that worked" is what let the outage through.
    return runScorers(
      [deriveToolOutageScorer()],
      { output: 'Here is your itinerary...', receipt: receipt({ byName: { spawn_child: 1 }, toolErrors: 5 }) },
      ctx,
    ).then((out) => {
      expect(out.passed).toBe(false);
      expect(out.failures[0].reason).toContain('every tool call failed');
    });
  });

  it('a real tool alongside a delegation still counts as working', async () => {
    const out = await runScorers(
      [deriveToolOutageScorer()],
      { output: 'ok', receipt: receipt({ byName: { spawn_child: 1, websearch__search: 1 }, toolErrors: 3 }) },
      ctx,
    );
    expect(out.passed).toBe(true);
  });

  it('leaves a child that never used a tool alone — reasoning is not an outage', async () => {
    const out = await runScorers(
      [deriveToolOutageScorer()],
      { output: 'the answer is 4', receipt: receipt({}) },
      ctx,
    );
    expect(out.passed).toBe(true);
  });

  it('leaves a mostly-failing-but-working child alone — one success is evidence', async () => {
    // 1 successful search out of 4 is degraded, not an outage. `maxToolErrors`
    // is the knob for "too many errors"; this gate is only about zero working.
    const out = await runScorers(
      [deriveToolOutageScorer()],
      { output: 'found it', receipt: receipt({ byName: { websearch__search: 1 }, toolErrors: 3 }) },
      ctx,
    );
    expect(out.passed).toBe(true);
  });

  it('does not gate a CLI worker that cannot emit counters', async () => {
    const out = await runScorers(
      [deriveToolOutageScorer()],
      {
        output: 'done',
        receipt: receipt({
          toolErrors: 2,
          unavailable: ['sideEffects: worker did not expose tool-execution counters'],
        }),
      },
      ctx,
    );
    expect(out.passed).toBe(true);
  });

  it('is accepted by parseScorers on its own, without any numeric bound', () => {
    expect(parseScorers([{ kind: 'side_effect', requireWorkingTools: true }])).toEqual({
      scorers: [{ kind: 'side_effect', requireWorkingTools: true }],
    });
    expect(parseScorers([{ kind: 'side_effect', requireWorkingTools: 'yes' }])).toHaveProperty('error');
  });
});

describe('command_exit_zero — parse validation', () => {
  it('accepts a plain command and an explicit timeout', () => {
    const r = parseScorers([{ kind: 'command_exit_zero', command: 'npm test', timeoutMs: 5000 }]);
    expect(r.error).toBeUndefined();
    expect(r.scorers?.[0]).toEqual({ kind: 'command_exit_zero', command: 'npm test', timeoutMs: 5000 });
  });

  it('rejects an empty command, an over-long one, and a bad timeout', () => {
    expect(parseScorers([{ kind: 'command_exit_zero', command: '   ' }]).error).toMatch(/non-empty/);
    expect(
      parseScorers([{ kind: 'command_exit_zero', command: 'x'.repeat(501) }]).error,
    ).toMatch(/at most 500/);
    expect(
      parseScorers([{ kind: 'command_exit_zero', command: 'npm test', timeoutMs: 0 }]).error,
    ).toMatch(/positive integer/);
    expect(
      parseScorers([{ kind: 'command_exit_zero', command: 'npm test', timeoutMs: 900_000 }]).error,
    ).toMatch(/at most 600000/);
  });

  it('names the new kind in the unknown-kind error', () => {
    expect(parseScorers([{ kind: 'nope' }]).error).toMatch(/command_exit_zero/);
  });
});

describe('command_exit_zero — execution', () => {
  it('passes on exit 0', async () => {
    const out = await runScorers(
      [{ kind: 'command_exit_zero', command: 'true' }],
      { output: 'x' },
      {},
    );
    expect(out.passed).toBe(true);
  });

  it('fails on a non-zero exit and quotes the output back', async () => {
    // The reason text is what lands in the retry brief, so a bare "exit 1"
    // would leave the next attempt with nothing to act on.
    const out = await runScorers(
      [{ kind: 'command_exit_zero', command: 'ls /definitely/not/here' }],
      { output: 'x' },
      {},
    );
    expect(out.passed).toBe(false);
    expect(out.failures[0].scorer).toMatch(/^command_exit_zero\(/);
    expect(out.failures[0].reason).toMatch(/exited [1-9]/);
    expect(out.failures[0].reason.length).toBeGreaterThan('exited 2'.length);
  });

  it('FAILS a command carrying shell metacharacters rather than running it', async () => {
    // The command comes from a parent LLM whose context can include untrusted
    // web/tool output. Safe-mode `tokenizeSafe` refuses the whole string, and a
    // gate that could not run must never read as one that passed.
    const out = await runScorers(
      [{ kind: 'command_exit_zero', command: 'true; echo pwned > /tmp/x' }],
      { output: 'x' },
      {},
    );
    expect(out.passed).toBe(false);
    expect(out.failures[0].reason).toMatch(/did not run/);
  });

  it('FAILS a command that does not exist', async () => {
    const out = await runScorers(
      [{ kind: 'command_exit_zero', command: 'octipus-no-such-binary' }],
      { output: 'x' },
      {},
    );
    expect(out.passed).toBe(false);
  });

  it('FAILS a command that outruns its deadline', async () => {
    const out = await runScorers(
      [{ kind: 'command_exit_zero', command: 'sleep 5', timeoutMs: 300 }],
      { output: 'x' },
      {},
    );
    expect(out.passed).toBe(false);
  }, 20_000);
});
