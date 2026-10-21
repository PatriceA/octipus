import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSystemOneAnswer, systemOneDecide } from './systemone-decision';
import type { DecisionQuestion, DecisionRequest } from './decision';
import fixture from './fixtures/clef-systemone.json';

vi.mock('./providers/instrumented', () => ({ recordProviderUsage: vi.fn() }));
const q: DecisionQuestion = { type: 'noul', instructions: 'Is a service down?' };
const req: DecisionRequest = { model: 'local-decision', state: 'Checkout is down.', zeroDataRetention: false, questions: { outage: q } };
const reply = (answers: unknown) => new Response(JSON.stringify({ answers }));
afterEach(() => vi.restoreAllMocks());

describe('native SystemOne', () => {
  it('accepts the recorded llama.cpp responses for all three question types', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture.response)));
    // Each request receives a fresh body while reusing the captured server envelope.
    fetcher.mockImplementation(async () => new Response(JSON.stringify(fixture.response)));
    const answers = await systemOneDecide('http://tower/v1/systemone', {}, { ...fixture.request, zeroDataRetention: false, questions: fixture.request.questions as Record<string, DecisionQuestion> }, fetcher);
    expect(answers.outage).toEqual({ type: 'noul', p: fixture.response.answers.outage.noul, confidence: fixture.response.answers.outage.noul });
    expect(answers.team).toEqual(fixture.response.answers.team);
    expect(answers.urgency).toMatchObject({ type: 'score', score: fixture.response.answers.urgency.score, probabilities: fixture.response.answers.urgency.probabilities, confidence: fixture.response.answers.urgency.confidence });
  });
  it('normalizes scalar and typed noul without changing probabilities', () => {
    for (const raw of [0.1, { type: 'noul', noul: 0.1 }]) expect(normalizeSystemOneAnswer(q, raw)).toEqual({ type: 'noul', p: 0.1, confidence: 0.9 });
  });
  it('retains native choice confidence instead of replacing it with the top probability', () => {
    const question: DecisionQuestion = { type: 'choice', instructions: 'Team?', criteria: { technical: 'Bugs', billing: 'Invoices' } };
    expect(normalizeSystemOneAnswer(question, { choice: 'technical', probabilities: { technical: 0.8, billing: 0.2 }, confidence: 0.6 })).toEqual({ type: 'choice', choice: 'technical', probabilities: { technical: 0.8, billing: 0.2 }, confidence: 0.6 });
    for (const probabilities of [{ technical: 0.8 }, { technical: 1.1, billing: -0.1 }, { technical: 0.2, billing: 0.2 }, { technical: 0.8, other: 0.2 }]) {
      expect(() => normalizeSystemOneAnswer(question, { choice: 'technical', probabilities, confidence: 0.6 })).toThrow();
    }
    expect(() => normalizeSystemOneAnswer(question, { choice: 'unknown', probabilities: { technical: 0.8, billing: 0.2 }, confidence: 0.6 })).toThrow();
  });
  it('accepts a fractional score and rejects out-of-range scores', () => {
    const question: DecisionQuestion = { type: 'score', instructions: 'Urgency?', criteria: ['Low', 'Medium', 'High'] };
    const raw = { type: 'score', score: 1.4, probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 }, confidence: 0.7 };
    expect(normalizeSystemOneAnswer(question, raw)).toEqual(raw);
    expect(() => normalizeSystemOneAnswer(question, { ...raw, score: 3 })).toThrow();
  });
  it('rejects contradictory choices and scores even with high confidence', () => {
    const question: DecisionQuestion = { type: 'choice', instructions: 'Pick one', criteria: { a: 'A', b: 'B' } };
    expect(() => normalizeSystemOneAnswer(question, { choice: 'a', probabilities: { a: 0.01, b: 0.99 }, confidence: 0.99 })).toThrow('maximal probability');
    expect(() => normalizeSystemOneAnswer({ type: 'score', instructions: 'Urgency', criteria: ['low', 'high'] }, { score: 1, probabilities: { 0: 1, 1: 0 }, confidence: 1 })).toThrow('probability-weighted level');
  });
  it('allows ties and rounding differences while preserving native confidence', () => {
    const question: DecisionQuestion = { type: 'choice', instructions: 'Pick one', criteria: { a: 'A', b: 'B' } };
    for (const probabilities of [{ a: 0.5, b: 0.5 }, { a: 0.4998, b: 0.5002 }]) {
      expect(normalizeSystemOneAnswer(question, { choice: 'a', probabilities, confidence: 0 })).toMatchObject({ choice: 'a', confidence: 0 });
    }
    expect(normalizeSystemOneAnswer({ type: 'score', instructions: 'Urgency', criteria: ['low', 'medium', 'high'] }, { score: 1.4004, probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 }, confidence: 0.7 })).toMatchObject({ score: 1.4004, confidence: 0.7 });
  });
  it('resolves a single category locally while still evaluating email priority', async () => {
    const priority: DecisionQuestion = { type: 'score', instructions: 'Urgency?', criteria: ['low', 'high'] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ priority: { score: 0.9, probabilities: { 0: 0.1, 1: 0.9 }, confidence: 0.8 } }));
    const answers = await systemOneDecide('http://tower/v1/systemone', {}, { ...req, questions: {
      category: { type: 'choice', instructions: 'Category?', criteria: { other: 'Everything else' } }, priority,
    } }, fetcher);
    expect(answers.category).toEqual({ type: 'choice', choice: 'other', probabilities: { other: 1 }, confidence: 1 });
    expect(answers.priority).toMatchObject({ type: 'score', score: 0.9, confidence: 0.8 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).questions).toEqual({ priority });
  });
  it('still rejects empty choices before any inference', async () => {
    const fetcher = vi.fn();
    await expect(systemOneDecide('http://tower/v1/systemone', {}, { ...req, questions: { category: { type: 'choice', instructions: 'Category?', criteria: {} } } }, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends keyed questions sequentially, with auth, timeout and redirects disabled', async () => {
    let finishFirst!: (r: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; })).mockResolvedValueOnce(reply({ second: 0.8 }));
    const headers = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };
    const pending = systemOneDecide('http://tower/v1/systemone', headers, { ...req, questions: { outage: q, second: q } }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://tower/v1/systemone');
    expect(init).toMatchObject({ headers, redirect: 'error', method: 'POST' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({ model: req.model, state: req.state, questions: { outage: q } });
    finishFirst(reply({ outage: { type: 'noul', noul: 0.95 } }));
    expect(await pending).toEqual({ outage: { type: 'noul', p: 0.95, confidence: 0.95 }, second: { type: 'noul', p: 0.8, confidence: 0.8 } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects missing answers, malformed envelopes and non-2xx responses', async () => {
    for (const response of [reply({}), new Response('{}'), reply({ outage: 1.1 }), reply({ outage: { type: 'choice', noul: 0.9 } })]) {
      await expect(systemOneDecide('http://tower/v1/systemone', {}, req, vi.fn().mockResolvedValue(response))).rejects.toThrow();
    }
    await expect(systemOneDecide('http://tower/v1/systemone', {}, req, vi.fn().mockResolvedValue(new Response('private state', { status: 503 })))).rejects.toThrow('SystemOne decide HTTP 503');
    await expect(systemOneDecide('http://tower/v1/systemone', {}, req, vi.fn().mockRejectedValue(new Error('offline')))).rejects.toThrow('offline');
  });
  it('validates every question before sending any request', async () => {
    const fetcher = vi.fn();
    await expect(systemOneDecide('http://tower/v1/systemone', {}, { ...req, questions: { outage: q, invalid: { type: 'noul', instructions: '' } } }, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
