import { afterEach, describe, expect, it } from 'vitest';
import { gateDecision, resolveDataPolicy, validateAnswers, type DecisionQuestion } from './decision';
import { TypeSafeProvider, normalizeAnswer } from './providers/typesafe-provider';

const row = (provider: string, modelId: string, metadata = {}, endpoint: string | null = null) => ({ provider, modelId, metadata, endpoint });

describe('privacy gate', () => {
  const local = resolveDataPolicy(row('ollama', 'qwen3:8b'), 'http://localhost:11434');
  const direct = resolveDataPolicy(row('typesafe', 'jev-1.13.0'));
  const gateway = resolveDataPolicy(row('typesafe', 'typesafe-ai/jev'));
  const unknown = resolveDataPolicy(row('openrouter', 'x/y'));
  const zdrContract = resolveDataPolicy(row('typesafe', 'jev-1.13.0', { dataPolicy: { hosting: 'remote', retention: 'none', trainsOnInput: false } }));

  it('local runs everything, unredacted', () => {
    for (const s of ['public', 'personal', 'secret'] as const) expect(gateDecision(s, local)).toEqual({ allowed: true, zeroDataRetention: false, redactPII: false });
  });

  it('ollama is local only on a private endpoint', () => {
    for (const url of ['http://127.0.0.1:11434', 'http://ollama:11434', 'http://192.168.1.5:11434', 'http://gpu.lan:11434', 'http://[::1]:11434'])
      expect(resolveDataPolicy(row('ollama', 'm'), url).hosting).toBe('local');
    for (const url of ['https://ollama.com', 'http://8.8.8.8:11434', 'https://my.ollama.example.com', 'http://[2001:db8::1]:11434', 'http://localhost.evil.com', undefined])
      expect(resolveDataPolicy(row('ollama', 'm'), url).hosting).toBe('remote');
    expect(resolveDataPolicy(row('ollama', 'm', {}, 'https://ollama.com'), 'http://localhost:11434').hosting).toBe('remote'); // row endpoint wins
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

describe('preferDecision', () => {
  const site = { id: 't', sensitivity: 'public' as const, minConfidence: 0 };
  it('live: decision wins and the LLM is not called; no decision → LLM', async () => {
    const { preferDecision } = await import('./decision');
    let calls = 0;
    const llm = async () => { calls++; return 'b'; };
    expect(await preferDecision(site, true, async () => 'a', llm)).toBe('a');
    expect(calls).toBe(0);
    expect(await preferDecision(site, true, async () => null, llm)).toBe('b');
  });
  it('shadow: returns the LLM result without waiting for a hung decision', async () => {
    const { preferDecision } = await import('./decision');
    const never = () => new Promise<string | null>(() => {});
    expect(await preferDecision(site, false, never, async () => 'b')).toBe('b');
  });
});

describe('decide() gate wiring', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const wire = async (row: Record<string, unknown>) => {
    const { vi } = await import('vitest');
    const registry = await import('@/models/model-registry');
    const providers = await import('@/models/providers');
    const sent = vi.fn(async (req: any) => Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: 'noul', p: 0.9, confidence: 0.9 }])));
    const r = vi.spyOn(registry, 'getModelRegistry').mockReturnValue({ getModelForTopic: async () => ({ name: 'm', metadata: {}, endpoint: null, ...row }) } as never);
    const p = vi.spyOn(providers, 'getProviderRouter').mockReturnValue({ getProviderByName: () => ({ decide: sent }) } as never);
    // Step past any "unbound" cache an earlier test left behind.
    const now = Date.now() + 3_600_000;
    const d = vi.spyOn(Date, 'now').mockReturnValue(now);
    return { sent, restore: () => { r.mockRestore(); p.mockRestore(); d.mockRestore(); } };
  };
  const q = { x: { type: 'noul' as const, instructions: 'x' } };

  it('an Ollama cloud model behind localhost never gets secret data', async () => {
    const { decide } = await import('./decision');
    const byName = await wire({ provider: 'ollama', modelId: 'gpt-oss:120b-cloud', endpoint: 'http://localhost:11434' });
    expect(await decide({ id: 's', sensitivity: 'secret', minConfidence: 0 }, 'k', q)).toBeNull();
    expect(byName.sent).not.toHaveBeenCalled();
    byName.restore();

    // Renamed cloud model: only /api/show knows.
    globalThis.fetch = (async () => new Response(JSON.stringify({ remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' }))) as typeof fetch;
    const renamed = await wire({ provider: 'ollama', modelId: 'mymodel:latest', endpoint: 'http://localhost:11434' });
    expect(await decide({ id: 's', sensitivity: 'secret', minConfidence: 0 }, 'k', q)).toBeNull();
    expect(renamed.sent).not.toHaveBeenCalled();
    renamed.restore();

    globalThis.fetch = (async () => new Response(JSON.stringify({ details: {} }))) as typeof fetch;
    const local = await wire({ provider: 'ollama', modelId: 'qwen3:8b', endpoint: 'http://localhost:11434' });
    expect(await decide({ id: 's', sensitivity: 'secret', minConfidence: 0 }, 'k', q)).not.toBeNull();
    local.restore();
  });

  it('PII in question criteria is redacted before a remote call; option keys survive', async () => {
    const { decide } = await import('./decision');
    const w = await wire({ provider: 'typesafe', modelId: 'typesafe-ai/jev' });
    await decide({ id: 'p', sensitivity: 'personal', minConfidence: 0 }, 'link text', {
      m: { type: 'choice', instructions: 'pick', criteria: { '1': 'Notes for alice@example.com', none: 'none' } },
    }).catch(() => null);
    const sentQ = w.sent.mock.calls[0][0].questions.m;
    expect(Object.keys(sentQ.criteria)).toEqual(['1', 'none']);
    expect(sentQ.criteria['1']).not.toContain('alice@example.com');
    w.restore();
  });
});
