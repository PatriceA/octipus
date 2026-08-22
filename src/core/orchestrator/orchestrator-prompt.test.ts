/**
 * What the orchestrator is told about delegating, and what it is told about the
 * keyword classifier's guess.
 *
 * Two defects are pinned here. The delegation policy used to be emitted only
 * when the keyword table matched a topic, so an unclassified message — the kind
 * most likely to need a specialist — arrived with no delegation guidance at
 * all. And the topic was handed to every model as an instruction ("use this as
 * the child role"), which replaces a capable model's read of the whole request
 * with a regex table's read of it.
 */
import { describe, expect, test } from 'bun:test';
import { buildDelegationPolicy, buildTopicHint } from './orchestrator-runner';

describe('buildDelegationPolicy', () => {
  test('is emitted for both tiers, with no dependency on a classified topic', () => {
    expect(buildDelegationPolicy(false)).toContain('spawn_child');
    expect(buildDelegationPolicy(true)).toContain('spawn_child');
  });

  test('lite never contradicts its own "delegate ONCE" prompt', () => {
    const lite = buildDelegationPolicy(true);
    expect(lite).toContain('EXACTLY ONCE');
    expect(lite).not.toContain('one or more calls per turn');
    // The lite spawn schema does not expose it, so advertising it wastes a turn.
    expect(lite).not.toContain('create_pipeline');
  });

  test('full keeps the multi-spawn and pipeline surface lite must not see', () => {
    const full = buildDelegationPolicy(false);
    expect(full).toContain('one or more calls per turn');
    expect(full).toContain('create_pipeline');
  });
});

describe('buildTopicHint', () => {
  const classified = { topic: 'research', confidence: 0.82 };

  test('a capable orchestrator is told nothing about the keyword guess', () => {
    expect(buildTopicHint(false, classified)).toBe('');
  });

  test('lite gets it, as a hint the request itself can override', () => {
    const hint = buildTopicHint(true, classified);
    expect(hint).toContain('research');
    // A hint, not an instruction: the old text said "Use this as the child role".
    expect(hint).toContain('unless the request plainly says otherwise');
  });

  test('nothing to say when the table matched nothing', () => {
    expect(buildTopicHint(true, { topic: undefined, confidence: 0 })).toBe('');
  });
});
