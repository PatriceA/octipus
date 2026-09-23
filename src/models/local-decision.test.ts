import { describe, expect, it } from 'vitest';
import { buildPrompt, scoreLogprobs } from './local-decision';
import type { DecisionQuestion } from './decision';

const lp = (entries: Array<[string, number]>) => entries.map(([token, p]) => ({ token, logprob: Math.log(p) }));

describe('local decision (logprob scoring)', () => {
  it('choice: letters map to option keys, variants like " A" merge, mass normalizes', () => {
    const q: DecisionQuestion = { type: 'choice', instructions: 'route', criteria: { billing: 'money', shipping: 'parcels', other: 'else' } };
    const a = scoreLogprobs(q, lp([['A', 0.6], [' A', 0.1], ['B', 0.2], ['<think>', 0.05]]));
    expect(a.type === 'choice' && a.choice).toBe('billing');
    expect(a.confidence).toBeCloseTo(0.7 / 0.9);
  });

  it('noul: p is P(A = true); score: probability-weighted level', () => {
    expect(scoreLogprobs({ type: 'noul', instructions: 'x' }, lp([['A', 0.2], ['B', 0.8]]))).toMatchObject({ type: 'noul', p: 0.2, confidence: 0.8 });
    const s = scoreLogprobs({ type: 'score', instructions: 'x', criteria: ['low', 'mid', 'high'] }, lp([['B', 0.5], ['C', 0.5]]));
    expect(s.type === 'score' && s.score).toBeCloseTo(1.5);
  });

  it('refuses when the model wanted to say something else, or options exceed the alphabet', () => {
    expect(() => scoreLogprobs({ type: 'noul', instructions: 'x' }, lp([['I', 0.2], ['<think>', 0.7]]))).toThrow(/mass/);
    const many = Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`o${i}`, 'x']));
    expect(() => buildPrompt('s', { type: 'choice', instructions: 'x', criteria: many })).toThrow(/at most 26/);
  });

  it('letters outside the option range are ignored', () => {
    const a = scoreLogprobs({ type: 'noul', instructions: 'x' }, lp([['A', 0.5], ['C', 0.4], ['B', 0.1]]));
    expect(a.type === 'noul' && a.p).toBeCloseTo(0.5 / 0.6);
  });
});
