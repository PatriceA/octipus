import { afterEach, describe, expect, it } from 'vitest';
import { gateDecision, resolveDataPolicy, validateAnswers, type DecisionQuestion } from './decision';
import { TypeSafeProvider, normalizeAnswer } from './providers/typesafe-provider';

const row = (provider: string, modelId: string, metadata = {}) => ({ provider, modelId, metadata });

describe('privacy gate', () => {
  const local = resolveDataPolicy(row('ollama', 'qwen3:8b'));
  const direct = resolveDataPolicy(row('typesafe', 'jev-1.13.0'));
  const gateway = resolveDataPolicy(row('typesafe', 'typesafe-ai/jev'));
  const unknown = resolveDataPolicy(row('openrouter', 'x/y'));
  const zdrContract = resolveDataPolicy(row('typesafe', 'jev-1.13.0', { dataPolicy: { hosting: 'remote', retention: 'none', trainsOnInput: false } }));

  it('local runs everything, unredacted', () => {
    for (const s of ['public', 'personal', 'secret'] as const) expect(gateDecision(s, local)).toEqual({ allowed: true, zeroDataRetention: false, redactPII: false });
  });

  it('secret never leaves the machine', () => {
    for (const p of [direct, gateway, zdrContract]) expect(gateDecision('secret', p).allowed).toBe(false);
  });

  it('personal: gateway forces ZDR, direct needs opt-in, contract ZDR passes, unknown remote refused', () => {
    expect(gateDecision('personal', gateway)).toEqual({ allowed: true, zeroDataRetention: true, redactPII: true });
    expect(gateDecision('personal', direct).allowed).toBe(false);
    expect(gateDecision('personal', direct, true)).toEqual({ allowed: true, zeroDataRetention: false, redactPII: true });
    expect(gateDecision('personal', zdrContract)).toEqual({ allowed: true, zeroDataRetention: false, redactPII: true });
    expect(gateDecision('personal', unknown, true).allowed).toBe(false); // may train on input: opt-in can't override
  });

  it('public goes anywhere without ZDR', () => {
    expect(gateDecision('public', direct)).toEqual({ allowed: true, zeroDataRetention: false, redactPII: false });
  });
});

describe('answer validation', () => {
  const q: Record<string, DecisionQuestion> = {
    urgent: { type: 'noul', instructions: 'urgent?' },
    cat: { type: 'choice', instructions: 'category', criteria: { bill: 'billing', other: 'anything else' } },
    prio: { type: 'score', instructions: 'priority', criteria: ['low', 'mid', 'high'] },
  };
  const good = {
    urgent: normalizeAnswer({ type: 'noul', noul: 0.9 }),
    cat: normalizeAnswer({ type: 'choice', choice: 'bill', probabilities: { bill: 0.8, other: 0.2 } }),
    prio: normalizeAnswer({ type: 'score', score: 1.4, probabilities: { 0: 0.1, 1: 0.5, 2: 0.4 }, confidence: 0.7 }),
  };

  it('accepts well-formed answers and derives confidence', () => {
    expect(validateAnswers(q, good)).toBeNull();
    expect(good.urgent.confidence).toBeCloseTo(0.9);
    expect(good.cat.confidence).toBe(0.8);
    expect(good.prio.confidence).toBe(0.7);
  });

  it('rejects missing, off-schema and out-of-range answers', () => {
    expect(validateAnswers(q, { ...good, urgent: undefined as never })).toMatch(/missing/);
    expect(validateAnswers(q, { ...good, cat: { ...good.cat, choice: 'toString' } as never })).toMatch(/not an option/);
    expect(validateAnswers(q, { ...good, prio: { ...good.prio, score: 3 } as never })).toMatch(/score/);
    expect(validateAnswers(q, { ...good, urgent: normalizeAnswer({ type: 'boolean', probability: 1.2 }) })).toMatch(/range/);
  });
});

describe('TypeSafeProvider.decide wire shapes', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.AI_GATEWAY_API_KEY; delete process.env.TYPESAFE_API_KEY; });

  const capture = (answers: unknown) => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ answers, usage: { inputTokens: 10, outputTokens: 0 } }), { status: 200 });
    }) as typeof fetch;
    return calls;
  };

  it('gateway: noul→boolean, ZDR in providerOptions, boolean answer normalized', async () => {
    process.env.AI_GATEWAY_API_KEY = 'k';
    const calls = capture({ u: { type: 'boolean', probability: 0.2 } });
    const out = await new TypeSafeProvider().decide({ model: 'typesafe-ai/jev', state: 's', questions: { u: { type: 'noul', instructions: 'x' } }, zeroDataRetention: true });
    expect(calls[0].url).toBe('https://ai-gateway.vercel.sh/v1/evaluate');
    expect(calls[0].body.questions.u.type).toBe('boolean');
    expect(calls[0].body.providerOptions.gateway.zeroDataRetention).toBe(true);
    expect(out.u).toEqual({ type: 'noul', p: 0.2, confidence: 0.8 });
  });

  it('direct: native shape, no providerOptions; refuses a ZDR request it cannot enforce', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    const calls = capture({ u: { type: 'noul', noul: 0.7 } });
    const p = new TypeSafeProvider();
    await p.decide({ model: 'jev-1.13.0', state: 's', questions: { u: { type: 'noul', instructions: 'x' } }, zeroDataRetention: false });
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0].body.questions.u.type).toBe('noul');
    expect(calls[0].body.providerOptions).toBeUndefined();
    await expect(p.decide({ model: 'jev-1.13.0', state: 's', questions: {}, zeroDataRetention: true })).rejects.toThrow(/cannot enforce/);
  });
});

describe('decide() never throws and caches "unbound"', () => {
  it('registry failure → null; unbound → one lookup per TTL', async () => {
    const { vi } = await import('vitest');
    const registry = await import('@/models/model-registry');
    const { decide } = await import('./decision');
    const site = { id: 't', sensitivity: 'public' as const, minConfidence: 0 };
    const spy = vi.spyOn(registry, 'getModelRegistry').mockReturnValueOnce({ getModelForTopic: async () => { throw new Error('db down'); } } as never);
    expect(await decide(site, 's', {})).toBeNull();
    const lookup = vi.fn(async () => null);
    spy.mockReturnValue({ getModelForTopic: lookup } as never);
    await decide(site, 's', {});
    await decide(site, 's', {});
    expect(lookup).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
