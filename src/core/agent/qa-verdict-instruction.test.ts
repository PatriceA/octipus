import { describe, expect, test } from 'vitest';
import { thinVerdictFailure } from './audit-coverage';
import {
  aliasVerdict,
  isVerdictRepair,
  PipelineManager,
  qaVerdictCorrectionInput,
  QA_VERDICT_JSON_INSTRUCTION,
  QA_VERDICT_JSON_LEAD,
  VERDICT_REPAIR_LIMIT,
  withQaVerdictContract,
} from './pipeline-manager';

// parseQAResult is private + pure (no DB) — reach it through the class.
const parseQA = (out: string) => (new PipelineManager() as unknown as { parseQAResult(o: string): unknown }).parseQAResult(out);

// Guards the B2 QA-verdict instruction wording. parseQAResult (private) has
// three tiers: (1) strict JSON in a ```json fence, (2) inline "passed": true|false,
// (3) prose fallback. The instruction must drive tier 1 without being self-
// parseable if a model echoes it verbatim (the B3 anti-echo lesson).
describe('QA_VERDICT_JSON_INSTRUCTION (Phase B2)', () => {
  test('names every field parseQAResult reads', () => {
    for (const field of ['passed', 'confidence', 'issues', 'feedback']) {
      expect(QA_VERDICT_JSON_INSTRUCTION).toContain(field);
    }
  });

  test('is anti-echo: contains no literal ```json fence and no inline "passed": bool', () => {
    // If echoed, tier-1 (first ```json fence) must not grab a placeholder, and
    // tier-2 (/"passed"\s*:\s*(true|false)/) must not match the description.
    expect(QA_VERDICT_JSON_INSTRUCTION).not.toContain('```json');
    expect(/"passed"\s*:\s*(true|false)/.test(QA_VERDICT_JSON_INSTRUCTION)).toBe(false);
  });
});

// The contract wrapper. The failure it exists for: on 2026-08-07 the auditor
// omitted the verdict block three runs in a row with the requirement appended
// after a ~3000-word prompt, so every retry was spent on formatting and the
// substance was never re-judged.
describe('withQaVerdictContract', () => {
  test('states the requirement before the work AND specifies it after', () => {
    const wrapped = withQaVerdictContract('THE STAGE PROMPT');
    expect(wrapped.indexOf(QA_VERDICT_JSON_LEAD)).toBe(0);
    expect(wrapped.indexOf('THE STAGE PROMPT')).toBeLessThan(
      wrapped.indexOf(QA_VERDICT_JSON_INSTRUCTION),
    );
  });

  test('a rejection notice leads, so a retry cannot bury why it is retrying', () => {
    const wrapped = withQaVerdictContract('THE STAGE PROMPT', 'no verdict block');
    expect(wrapped).toContain('YOUR PREVIOUS VERDICT WAS REJECTED — no verdict block');
    expect(wrapped.indexOf('REJECTED')).toBeLessThan(wrapped.indexOf('THE STAGE PROMPT'));
  });

  test('the whole wrapper stays anti-echo — an echoed contract is not a verdict', () => {
    // The real regression risk: adding a friendlier filled-in example to the
    // lead would make an echoing model's own prompt parse as its verdict.
    expect(parseQA(withQaVerdictContract('a prompt'))).toBeNull();
  });
});

describe('parseQAResult — verdict block selection (B2 review fix)', () => {
  test('parses the verdict fence even when a code block precedes it', () => {
    const out =
      'Here is the failing snippet:\n```js\nconst x = 1,2,3\n```\n\nVerdict:\n' +
      '```json\n{"passed": false, "confidence": "high", "issues": ["syntax error"], "feedback": "fix it"}\n```';
    const r = parseQA(out) as { passed: boolean; issues: string[]; confidence?: string } | null;
    expect(r?.passed).toBe(false);
    expect(r?.issues).toEqual(['syntax error']);
    expect(r?.confidence).toBe('high');
  });

  test('parses bare JSON with no fence', () => {
    const r = parseQA('{"passed": true}') as { passed: boolean } | null;
    expect(r?.passed).toBe(true);
  });

  test('returns null for output with no verdict at all', () => {
    expect(parseQA('just some prose with a ```js\ncode\n``` block')).toBeNull();
  });
});

// The failure this closes, measured on the live stack 2026-08-21: a QA stage
// ended with a fenced `json` block of its own shape — `verdict: "approve"`,
// `blockers: []`, `summary: …` — and the gate read it as "no machine-readable
// verdict", re-ran the entire audit three times at ~430k tokens a visit, and
// killed the run on the token pool with zero plan items finished.
describe('aliasVerdict — incidental JSON is not a verdict', () => {
  // Tier 1b runs BEFORE the prose tiers, so anything it accepts overrides a
  // verdict the auditor actually wrote in prose. A report that ends with a
  // pasted tool payload used to have its real FAIL replaced by that payload's
  // "success" — and the resulting PASS was then coverage-rejected into the
  // auditor-only retry loop, so the failure never reached the implementer.
  test('a test-runner payload is not a passing audit', () => {
    expect(aliasVerdict({ result: 'success', summary: '12 tests passed' })).toBeNull();
  });

  test('a health-check payload is not a passing audit', () => {
    expect(aliasVerdict({ status: 'ok', notes: 'service up' })).toBeNull();
  });

  test('a linter payload with an empty issues list is not a passing audit', () => {
    // `issues` is tool vocabulary too. A PASS is held to a higher bar than a
    // FAIL because the two mistakes do not cost the same: a stray FAIL costs a
    // retry, a stray PASS overwrites a real failure and ships the work.
    expect(aliasVerdict({ result: 'success', issues: [] })).toBeNull();
    expect(aliasVerdict({ status: 'ok', issues: [] })).toBeNull();
  });

  test('a failing alias may stand on issues alone — it can only tighten the gate', () => {
    expect(aliasVerdict({ status: 'rejected', blockers: ['tests fail'] })?.passed).toBe(false);
  });

  test('a passing alias needs a field an incidental payload does not carry', () => {
    expect(aliasVerdict({ verdict: 'approve', issues: [], feedback: 'checked every stage' })?.passed).toBe(true);
    expect(aliasVerdict({ verdict: 'approve', whatIDidNotCheck: ['perf'] })?.passed).toBe(true);
  });

  test('audit vocabulary is what makes it a verdict', () => {
    // The measured real case: a QA stage emitting its own field names.
    const v = aliasVerdict({ verdict: 'approve', blockers: [], summary: 'looks right' });
    expect(v?.passed).toBe(true);
  });

  test('confidence alone is audit vocabulary too', () => {
    expect(aliasVerdict({ verdict: 'fail', confidence: 'low' })?.passed).toBe(false);
  });
});

describe('aliasVerdict — a null alias does not shadow a real one', () => {
  // Models routinely emit the whole contract with the fields they did not fill
  // set to null. Selecting on key PRESENCE let the null win, so a stated
  // verdict read as "no verdict" and stated blockers were silently dropped.
  test('a null primary verdict field falls through to the one that is set', () => {
    const v = aliasVerdict({ passed: null, verdict: 'fail', issues: ['x'], feedback: 'nope' });
    expect(v).not.toBeNull();
    expect(v?.passed).toBe(false);
  });

  test('a null issues alias does not swallow the blockers that follow it', () => {
    const v = aliasVerdict({ verdict: 'fail', issues: null, blockers: ['migration missing'], feedback: 'x' });
    expect(v?.issues).toEqual(['migration missing']);
  });

  test('a present-but-empty value is a real answer and still wins', () => {
    const v = aliasVerdict({ verdict: 'fail', issues: [], blockers: ['ignored'], feedback: 'x' });
    expect(v?.issues).toEqual([]);
  });
});

describe('aliasVerdict — a verdict under different field names', () => {
  const observed = {
    verdict: 'approve',
    summary: 'strkit passes full QA: 171/171 unit tests, packaging install verified.',
    blockers: [],
    recommendations: ['Lock the packaging contract with an __all__ test.'],
  };

  test('reads the shape a real QA stage emitted', () => {
    const v = aliasVerdict(observed);
    expect(v?.passed).toBe(true);
    expect(v?.feedback).toContain('171/171');
    expect(v?.source).toBe('json');
  });

  test('parseQAResult finds it inside the report', () => {
    const out = `## Test Results\nAll green.\n\n\`\`\`json\n${JSON.stringify(observed)}\n\`\`\``;
    expect((parseQA(out) as { passed: boolean }).passed).toBe(true);
  });

  test('a literal `passed` block still wins over an alias one', () => {
    const out =
      `\`\`\`json\n${JSON.stringify({ verdict: 'approve' })}\n\`\`\`\n` +
      `\`\`\`json\n${JSON.stringify({ passed: false, issues: ['ReDoS in slugify'] })}\n\`\`\``;
    const v = parseQA(out) as { passed: boolean; issues: string[] };
    expect(v.passed).toBe(false);
    expect(v.issues).toEqual(['ReDoS in slugify']);
  });

  test('reads the negative words too', () => {
    expect(aliasVerdict({ status: 'rejected', blockers: ['tests fail'] })?.passed).toBe(false);
    expect(aliasVerdict({ result: 'needs work', issues: ['flaky suite'] })?.passed).toBe(false);
  });

  test('a verdict word alone is not a verdict — incidental JSON is not read as one', () => {
    // A QA report quotes payloads. Without more of the contract answered,
    // `{"status":"ok"}` from a health check is just a payload.
    expect(aliasVerdict({ status: 'ok' })).toBeNull();
    expect(aliasVerdict({ result: 'success', tests: 171 })).toBeNull();
    expect(aliasVerdict({ status: 'ok', confidence: 'high' })?.passed).toBe(true);
  });

  test('a tool payload carrying issues AND a summary is still not a passing verdict', () => {
    // The shape that cleared the old two-incidental-keys bar in one go: a test
    // runner emits all three fields itself, and this tier runs before the prose
    // tiers, so reading it as a PASS overwrites a genuine FAIL written above it.
    expect(aliasVerdict({ result: 'success', issues: [], summary: '171/171 tests passed' })).toBeNull();
    expect(aliasVerdict({ status: 'ok', issues: [], notes: 'service up' })).toBeNull();
    // The same payload pointing the other way may still stand on `issues`:
    // reading a stray payload as a FAIL costs one retry and nothing worse.
    expect(aliasVerdict({ result: 'failed', issues: ['timeout'] })?.passed).toBe(false);
    // And audit vocabulary still passes — the shape a real QA stage emitted.
    expect(aliasVerdict({ verdict: 'approve', blockers: [], recommendations: ['x'] })?.passed).toBe(true);
  });

  test('the LAST verdict block wins — the contract puts it at the end', () => {
    const out =
      `\`\`\`json\n${JSON.stringify({ result: 'success', issues: [] })}\n\`\`\`\n` +
      `\`\`\`json\n${JSON.stringify({ verdict: 'reject', blockers: ['ReDoS'] })}\n\`\`\``;
    const v = parseQA(out) as { passed: boolean; issues: string[] };
    expect(v.passed).toBe(false);
    expect(v.issues).toEqual(['ReDoS']);
  });

  test('refuses to guess: no verdict field, or a value that is neither', () => {
    expect(aliasVerdict({ summary: 'looks fine to me', blockers: [] })).toBeNull();
    expect(aliasVerdict({ verdict: 'partially, with caveats', issues: [] })).toBeNull();
    expect(aliasVerdict({ verdict: 42, issues: [] })).toBeNull();
    expect(aliasVerdict(['approve'])).toBeNull();
    expect(aliasVerdict(null)).toBeNull();
  });

  test('stays in the structured tier, so the thin-verdict rules still apply', () => {
    const v = aliasVerdict(observed)!;
    expect(v.source).toBe('json');
    expect(v.whatIDidNotCheck).toEqual([]);
    expect(v.confidence).toBeUndefined();
    expect(thinVerdictFailure(v)).not.toBeNull();
  });
});

describe('qaVerdictCorrectionInput', () => {
  const input = qaVerdictCorrectionInput('REPORT BODY', 'the verdict named no stage');

  test('hands the auditor its own report and the reason', () => {
    expect(input).toContain('REPORT BODY');
    expect(input).toContain('the verdict named no stage');
  });

  test('asks for the block only — not another audit', () => {
    expect(input).toMatch(/Do NOT re-run the audit/i);
    expect(input).toContain(QA_VERDICT_JSON_INSTRUCTION);
  });
});

describe('parseQAResult tier 1b — LAST fenced block wins', () => {
  // This pins the last-block rule itself, which is what protects a verdict from
  // an incidental `{"status": "ok"}` earlier in the reply.
  //
  // It deliberately does NOT claim to guard the accompanying slice fix (the
  // reversal used to cover the bare-output fallback too, putting it first
  // instead of last). That reordering is unobservable by construction — the
  // fallback is the whole reply, and a reply containing fences never parses as
  // bare JSON — so no test can fail on it. The fix stands because the code
  // should mean what its comment says, not because a guard proves it.
  const parse = (out: string) =>
    (new PipelineManager() as unknown as { parseQAResult: (o: string) => { passed: boolean } | null })
      .parseQAResult(out);

  test('an incidental alias block above the verdict does not win', () => {
    const out = [
      '```json',
      '{"status": "ok", "result": "success"}',
      '```',
      'Here is the verdict.',
      '```json',
      '{"verdict": "fail", "blockers": ["migration missing"], "summary": "not ready"}',
      '```',
    ].join('\n');
    expect(parse(out)?.passed).toBe(false);
  });
});

// Harmless variation in HOW the block is written must not cost a verdict
// repair; a block missing what the contract asks for must still be refused.
describe('parseQAResult — tolerant of the wrapper, strict about the fields', () => {
  const VERDICT = '{"passed": false, "confidence": "high", "issues": ["no test for 0"], "feedback": "Implementation: fails on 0.", "whatIDidNotCheck": ["perf"]}';
  const parse = (out: string) => parseQA(out) as { passed: boolean; source?: string; issues: string[] } | null;

  test.each(['JSON', 'jsonc', 'json5', 'js', ''])('a fence tagged %j is still the json tier', (tag) => {
    const r = parse(`Report.\n\n\`\`\`${tag}\n${VERDICT}\n\`\`\``);
    expect(r).toMatchObject({ passed: false, source: 'json', issues: ['no test for 0'] });
  });

  test('a one-line fence with the tag and the object together parses', () => {
    expect(parse(`Report.\n\`\`\`json ${VERDICT}\`\`\``)?.source).toBe('json');
  });

  test('prose after the fenced block does not hide it', () => {
    expect(parse(`Report.\n\`\`\`json\n${VERDICT}\n\`\`\`\n\nLet me know if you want more detail.`)?.source).toBe('json');
  });

  test('an unfenced object with prose around it is the json tier', () => {
    const r = parse(`My report.\n\n${VERDICT}\n\nThat is my verdict — happy to elaborate.`);
    expect(r).toMatchObject({ passed: false, source: 'json' });
  });

  test('a brace inside a string value does not cut the bare object short', () => {
    const v = '{"passed": false, "issues": ["returns {} on empty"], "feedback": "Implementation: see }", "confidence": "low", "whatIDidNotCheck": ["x"]}';
    expect(parse(`Report.\n${v}\nThanks.`)?.issues).toEqual(['returns {} on empty']);
  });

  test('a block under another tag is not read as the verdict', () => {
    expect(parse(`\`\`\`handoff\n${VERDICT}\n\`\`\``)?.source).not.toBe('json');
    expect(parse(`\`\`\`python\n${VERDICT}\n\`\`\``)?.source).not.toBe('json');
  });

  test('missing fields are not filled in — a pass without them stays thin', () => {
    const r = parseQA('```JSON\n{"passed": true, "issues": [], "feedback": "Implementation: ok."}\n```') as never;
    expect(thinVerdictFailure(r)).not.toBeNull();
  });

  test('the contract stays inert when echoed, even through the bare-object scan', () => {
    expect(parseQA(`${QA_VERDICT_JSON_INSTRUCTION}\n\nTrailing prose.`)).toBeNull();
  });
});

describe('isVerdictRepair', () => {
  test('a missing or incomplete block is a repair; a coverage fault and a real failure are not', () => {
    expect(isVerdictRepair({ auditGateFailed: true, auditGateReason: 'unparseable' })).toBe(true);
    expect(isVerdictRepair({ auditGateFailed: true, auditGateReason: 'report' })).toBe(true);
    expect(isVerdictRepair({ auditGateFailed: true, auditGateReason: 'coverage' })).toBe(false);
    expect(isVerdictRepair({})).toBe(false);
  });

  test('its bound is its own and small', () => {
    expect(VERDICT_REPAIR_LIMIT).toBeGreaterThan(0);
    expect(VERDICT_REPAIR_LIMIT).toBeLessThanOrEqual(3);
  });
});
