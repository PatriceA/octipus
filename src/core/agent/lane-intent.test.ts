import { describe, expect, test } from 'vitest';
import { classifyMessage } from './classifier';
import { asLane, LANE_CONFIDENCE_FLOOR, selectLane } from './lane-intent';

/** Route a message the way the runtime does: classify it, then pick the lane. */
const route = (message: string) => selectLane(message, classifyMessage(message));

describe('selectLane', () => {
  test('a plain greeting goes to the cheap lane', () => {
    expect(route('hello there').lane).toBe('everyday');
    expect(route('Reply with exactly the word PONG and nothing else.').lane).toBe('everyday');
  });

  test('implementation work goes to build', () => {
    for (const m of [
      'implement the retry logic in the client',
      'refactor this module so the parser is testable',
      'debug why the unit test fails',
    ]) {
      expect(route(m).lane, m).toBe('build');
    }
  });

  test('a message that names a file is an artefact signal even with no keyword', () => {
    // The fail-up half of the rule: a weak model here ships something plausible
    // and nothing downstream catches it, so ambiguity costs money, not quality.
    const choice = route('have a look at ledger.py and tell me what you make of it');
    expect(choice.lane).toBe('build');
    expect(choice.reason).toMatch(/file|trace|diff/);
  });

  test.each([
    ['```ts\nconst x = 1\n```'],
    ['src/core/agent/roles.ts is doing too much'],
    ['Traceback (most recent call last): ValueError: bad input'],
    ['git diff says the migration moved'],
  ])('artefact signal: %s', (m) => {
    expect(selectLane(m, { type: 'ambiguous', confidence: 0.2 }).lane).toBe('build');
  });

  test('research keeps its own lane rather than collapsing into build', () => {
    // It is the highest-token work in the system; the point of its lane is that
    // it can be pinned somewhere cheap without dragging everyday down.
    expect(selectLane('x', { type: 'task', confidence: 0.9, topic: 'research' }).lane).toBe('research');
  });

  test('a low-confidence category is not acted on', () => {
    const weak = { type: 'task', confidence: LANE_CONFIDENCE_FLOOR - 0.01, topic: 'coding' } as const;
    expect(selectLane('something vague', weak).lane).toBe('everyday');
  });

  test('a category with no lane of its own falls through to the message', () => {
    // canonicalTopic passes unknown values through unchanged; an unknown topic
    // must not be handed to getModelForTopic as if it were a lane.
    const odd = { type: 'task', confidence: 0.9, topic: 'made-up-topic' } as const;
    expect(selectLane('plain words', odd).lane).toBe('everyday');
    expect(selectLane('see src/thing.ts', odd).lane).toBe('build');
  });

  test('every choice explains itself', () => {
    for (const m of ['hello', 'implement the thing', 'look at main.py']) {
      expect(route(m).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('the four arena tasks land where they should', () => {
  const PROMPTS = {
    ping: 'Reply with exactly the word PONG and nothing else.',
    fix: 'The unit tests in this directory fail. Read README.md for the contract they encode, then fix ledger.py until `python3 -m unittest discover` passes with every test green. Do not modify test_ledger.py or README.md — only ledger.py.',
    explain: 'Do not create, edit or delete any file. Read the code and answer in prose: in at most ten lines, what does this package do, and what is wrong with or missing from ledger.py? List each defect on its own line.',
    module: 'Read BRIEF.md. Write your implementation plan to PLAN.md first, then build what the brief describes in this directory. Keep working until it is finished and you believe it is correct. Do not modify BRIEF.md.',
  };

  test('the two that produce code go to build, the two that produce an answer do not', () => {
    expect(route(PROMPTS.fix).lane).toBe('build');
    expect(route(PROMPTS.module).lane).toBe('build');
    expect(route(PROMPTS.ping).lane).toBe('everyday');
    // `explain` is read-only analysis: it leaves no artefact and its answer is
    // checkable line by line, which is the definition of the cheap lane. The
    // same reasoning the pipeline tool ships ("not for a read-only audit").
    expect(route(PROMPTS.explain).lane).toBe('everyday');
  });

  test('the fix brief routes on the classifier, not on the fallback', () => {
    // It scores 0.375 — exactly the floor. At 0.4 the category was discarded
    // and only the mention of ledger.py kept it out of the cheap lane, which is
    // a brief one rename away from breaking.
    expect(route(PROMPTS.fix).reason).toMatch(/classified "coding"/);
  });
});

describe('asLane — what a parent may send a child to', () => {
  test('canonical lanes pass', () => {
    for (const l of ['build', 'verify', 'everyday', 'research']) {
      expect(asLane(l)).toBe(l);
    }
  });

  test('a retired name resolves to its lane', () => {
    expect(asLane('coding')).toBe('build');
    expect(asLane('qa')).toBe('verify');
    expect(asLane('chat')).toBe('everyday');
  });

  test('free text is a label, not a routing instruction', () => {
    // `topic` on the spawn schema has always also carried things like
    // "oauth/pkce" for the topic path; handed to the registry as a lane it
    // resolves to nothing and fails the spawn.
    for (const junk of ['oauth/pkce', 'benchmark results', '', undefined, null]) {
      expect(asLane(junk)).toBeUndefined();
    }
  });

  test('background is not somewhere a parent may send a child', () => {
    // It is the lane for memory extraction and summarisation, bound to the
    // cheapest thing on the box, and nothing asks it to do a task.
    expect(asLane('background')).toBeUndefined();
    expect(asLane('memory_extraction')).toBeUndefined();
  });
});
