/**
 * What the ROOT agent is told about delegating, and what it is told about the
 * keyword classifier's guess.
 *
 * Three defects are pinned here. The delegation policy used to be emitted only
 * when the keyword table matched a topic, so an unclassified message — the kind
 * most likely to need a specialist — arrived with no delegation guidance at
 * all. The topic was handed to every model as an instruction ("use this as the
 * child role"), which replaces a capable model's read of the whole request with
 * a regex table's read of it. And the policy told the root to delegate anything
 * substantive because the root held no tools — the hop Phase 9 deleted. The
 * root now holds the general toolset, and the policy has to say so, or half of
 * every turn is still a spawn for work the root could have done itself.
 */
import { describe, expect, test } from 'vitest';
import { assembleSystemPrompt, buildDelegationPolicy, buildTopicHint } from './orchestrator-runner';
import { splitVolatileSystem } from '@/models/providers/prompt-cache';

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

  test('both tiers tell the root to do the work itself — the Phase 9 invariant', () => {
    // The root holds the general toolset now. A policy that reads "delegate
    // anything substantive" reinstates the hop this phase deleted: a model
    // spawning a whole specialist to read one file.
    for (const tier of [true, false]) {
      const p = buildDelegationPolicy(tier);
      expect(p).toMatch(/yourself/i);
      expect(p).toMatch(/your own tools|you hold/i);
    }
  });

  test('both tiers say a missing capability is a tool call or a spawn, never a refusal', () => {
    // Measured on the live bench: asked what Octipus uses for a vector store,
    // the root — which held only `profiles` by design — answered "Octipus has
    // no searchable knowledge base", a claim about the PRODUCT read off its own
    // toolset. It now holds `knowledge`; the rule survives for what it does not.
    for (const tier of [true, false]) {
      const p = buildDelegationPolicy(tier);
      expect(p).toMatch(/capability is missing/i);
    }
  });

  test('full keeps the multi-spawn and pipeline surface lite must not see', () => {
    const full = buildDelegationPolicy(false);
    expect(full).toContain('parallel');
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

describe('assembleSystemPrompt', () => {
  // The orchestrator's static prefix is what the Anthropic cache breakpoint
  // covers. Long-term memory, the security reminder, the classifier's topic
  // hint and the output directive all vary per turn, and all four used to be
  // concatenated ahead of the breakpoint — which meant the ~6k-token prefix
  // was re-written rather than read on most turns.
  const base = 'ORCHESTRATOR PROMPT. '.repeat(600); // comfortably over the cache floor
  const date = '\n\nCURRENT DATE & TIME: Sat, 23 Aug 2026 00:00:00 GMT';

  test('the cacheable prefix is exactly the static tier', () => {
    const prompt = assembleSystemPrompt([base], [date, '\n\nRELEVANT MEMORIES:\n- likes tea']);
    const split = splitVolatileSystem(prompt);
    expect(split).not.toBeNull();
    expect(split!.staticPart).toBe(base);
    expect(split!.volatilePart).toContain('likes tea');
  });

  test('the prefix does not move when the turn-derived blocks change', () => {
    const a = splitVolatileSystem(assembleSystemPrompt([base], [date, 'memory A', 'hint A']));
    const b = splitVolatileSystem(assembleSystemPrompt([base], [date, 'memory B']));
    expect(a!.staticPart).toBe(b!.staticPart);
  });

  test('empty parts do not open a gap in the prefix', () => {
    expect(assembleSystemPrompt([base, ''], ['', date])).toBe(base + date);
  });
});
