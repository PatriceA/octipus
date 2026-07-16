import { describe, expect, test } from 'bun:test';
import { QA_VERDICT_JSON_INSTRUCTION } from './pipeline-manager';

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
