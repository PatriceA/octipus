import { describe, expect, test } from 'bun:test';
import {
  PipelineManager,
  QA_VERDICT_JSON_INSTRUCTION,
  QA_VERDICT_JSON_LEAD,
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
