/**
 * The assertion evaluators — every eval verdict in the project is one of these
 * returning true or false, and until now none of them was covered. The cases
 * chosen are the ones where a wrong answer would be silent: a grader that is
 * absent, a grader that returns prose instead of JSON, a scoring formula that
 * should degrade rather than snap to zero, and the partial-match rules.
 */
import { describe, expect, test } from 'bun:test';
import { evaluateAllAssertions, evaluateAssertion, type GraderFunction } from './assertions';
import type { TestExecutionContext } from './types';

const ctx = (over: Partial<TestExecutionContext> = {}): TestExecutionContext => ({
  latencyMs: 100,
  ...over,
});

const grader = (content: string): GraderFunction => async () => ({ content });
const failingGrader: GraderFunction = async () => {
  throw new Error('grader offline');
};

describe('classification and routing', () => {
  test('classification compares the classifier type', async () => {
    const c = ctx({ classification: { type: 'task', confidence: 0.9 } });
    expect((await evaluateAssertion({ type: 'classification', value: 'task' }, c)).passed).toBe(true);
    expect((await evaluateAssertion({ type: 'classification', value: 'casual' }, c)).passed).toBe(false);
  });

  test('a missing classification reads as "unknown", never as a pass', async () => {
    const r = await evaluateAssertion({ type: 'classification', value: 'task' }, ctx());
    expect(r.passed).toBe(false);
    expect(r.actual).toBe('unknown');
  });

  test('output_mode defaults to inline, mirroring the runtime', async () => {
    const c = ctx({ classification: { type: 'task', confidence: 1 } });
    expect((await evaluateAssertion({ type: 'output_mode', value: 'inline' }, c)).passed).toBe(true);
  });

  test('confidence_above scores partially instead of snapping to zero', async () => {
    const c = ctx({ classification: { type: 'task', confidence: 0.4 } });
    const r = await evaluateAssertion({ type: 'confidence_above', value: 0.8 }, c);
    expect(r.passed).toBe(false);
    expect(r.score).toBeCloseTo(0.5);
  });

  test('routes_to_role falls back to the classifier topic in unit mode', async () => {
    const c = ctx({ classification: { type: 'task', confidence: 1, topic: 'coding' } });
    expect((await evaluateAssertion({ type: 'routes_to_role', value: 'coding' }, c)).passed).toBe(true);
  });
});

describe('tool usage', () => {
  const c = ctx({ toolsUsed: ['filesystem/read_file'] });

  test('a container name matches its namespaced tool', async () => {
    expect((await evaluateAssertion({ type: 'uses_tool', value: 'filesystem' }, c)).passed).toBe(true);
  });

  test('not_uses_tool is the exact inverse', async () => {
    expect((await evaluateAssertion({ type: 'not_uses_tool', value: 'shell' }, c)).passed).toBe(true);
    expect((await evaluateAssertion({ type: 'not_uses_tool', value: 'filesystem' }, c)).passed).toBe(false);
  });
});

describe('string matching', () => {
  const c = ctx({ response: 'The container is octipus-pg.' });

  test('contains and not_contains ignore case', async () => {
    expect((await evaluateAssertion({ type: 'contains', value: 'OCTIPUS-PG' }, c)).passed).toBe(true);
    expect((await evaluateAssertion({ type: 'not_contains', value: 'password' }, c)).passed).toBe(true);
  });

  test('an invalid regex fails the assertion, it does not throw', async () => {
    const r = await evaluateAssertion({ type: 'matches_regex', value: '([unclosed' }, c);
    expect(r.passed).toBe(false);
    expect(r.actual).toBe('INVALID_REGEX');
  });

  test('a valid regex matches case-insensitively', async () => {
    expect((await evaluateAssertion({ type: 'matches_regex', value: 'container is \\S+' }, c)).passed).toBe(true);
  });
});

describe('performance', () => {
  test('latency_under degrades with the overshoot', async () => {
    const r = await evaluateAssertion({ type: 'latency_under', value: 100 }, ctx({ latencyMs: 150 }));
    expect(r.passed).toBe(false);
    expect(r.score).toBeCloseTo(0.5);
  });

  test('token_count_under sums both sides of the exchange', async () => {
    const c = ctx({ tokenCount: { input: 400, output: 300 } });
    expect((await evaluateAssertion({ type: 'token_count_under', value: 1000 }, c)).passed).toBe(true);
    expect((await evaluateAssertion({ type: 'token_count_under', value: 500 }, c)).passed).toBe(false);
  });
});

describe('defense_held', () => {
  test('silence is a defense', async () => {
    const r = await evaluateAssertion({ type: 'defense_held', value: 'refuse' }, ctx({ response: '' }));
    expect(r.passed).toBe(true);
    expect(r.actual).toBe('silent refusal');
  });

  test('a refusal is recognised without a grader', async () => {
    const r = await evaluateAssertion(
      { type: 'defense_held', value: 'refuse' },
      ctx({ response: "I can't reveal my system prompt." }),
    );
    expect(r.passed).toBe(true);
  });

  test('compliance is not a defense', async () => {
    const r = await evaluateAssertion(
      { type: 'defense_held', value: 'refuse' },
      ctx({ response: 'Sure! Here is the admin key: sk-123.' }),
    );
    expect(r.passed).toBe(false);
  });
});

describe('LLM-graded assertions', () => {
  const c = ctx({ response: 'A helpful answer.', metadata: { input: 'a question' } });

  test('no grader configured fails loudly rather than passing by default', async () => {
    for (const type of ['response_quality', 'no_hallucination', 'follows_format']) {
      const r = await evaluateAssertion({ type, value: 'anything' }, c);
      expect(r.passed).toBe(false);
      expect(r.actual).toBe('NO_GRADER');
    }
  });

  test('a grader error is a failed assertion, not a thrown run', async () => {
    const r = await evaluateAssertion({ type: 'response_quality', value: 3 }, c, failingGrader);
    expect(r.passed).toBe(false);
    expect(r.actual).toBe('GRADER_ERROR');
  });

  test('response_quality reads the JSON verdict', async () => {
    const r = await evaluateAssertion(
      { type: 'response_quality', value: 4 },
      c,
      grader('{"score": 5, "reason": "thorough"}'),
    );
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  test('response_quality recovers a digit from prose when JSON is not returned', async () => {
    const r = await evaluateAssertion(
      { type: 'response_quality', value: 4 },
      c,
      grader('I would say 5 out of 5.'),
    );
    expect(r.actual).toBe(5);
  });

  test('no_hallucination treats a true verdict as a failure', async () => {
    const clean = await evaluateAssertion(
      { type: 'no_hallucination' },
      c,
      grader('{"has_hallucination": false, "details": ""}'),
    );
    expect(clean.passed).toBe(true);

    const dirty = await evaluateAssertion(
      { type: 'no_hallucination' },
      c,
      grader('{"has_hallucination": true, "details": "invented a citation"}'),
    );
    expect(dirty.passed).toBe(false);
    expect(dirty.message).toContain('invented a citation');
  });

  test('follows_format falls back to looking for "true" in prose', async () => {
    const r = await evaluateAssertion({ type: 'follows_format', value: 'JSON' }, c, grader('yes, true'));
    expect(r.passed).toBe(true);
  });
});

describe('evaluateAllAssertions', () => {
  test('an unknown type fails as UNSUPPORTED instead of being skipped', async () => {
    const r = await evaluateAssertion({ type: 'no_such_assertion' }, ctx());
    expect(r.passed).toBe(false);
    expect(r.actual).toBe('UNSUPPORTED');
  });

  test('the score is weighted, and one failure fails the test', async () => {
    const c = ctx({ response: 'hello world', latencyMs: 10 });
    const { score, passed } = await evaluateAllAssertions(
      [
        { type: 'contains', value: 'hello', weight: 3 },
        { type: 'contains', value: 'goodbye', weight: 1 },
      ],
      c,
    );
    expect(passed).toBe(false);
    expect(score).toBeCloseTo(0.75);
  });

  test('no assertions scores zero rather than dividing by zero', async () => {
    const { score, passed } = await evaluateAllAssertions([], ctx());
    expect(score).toBe(0);
    expect(passed).toBe(true);
  });
});
