/** Live decisions retain precedence while references are recorded for calibration. */
import { beforeEach, describe, expect, test, vi } from 'vitest';
// Not under test here: the install-model gate (install-access.isolation.test.ts) lets these fake ids through.
vi.mock('@/models/install-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/models/install-access')>()),
  mayUseInstallModels: async () => true,
  assertInstallModelAccess: async () => {},
}));
import type { DecisionAnswers, DecisionObservation } from '@/models/decision';
import type { InboxItem } from './types';

let decision: DecisionAnswers | null = null;
let observed: DecisionAnswers | null = null;
let llmFails = false;
let llmCalls = 0;
let referencePrompt = '';
vi.mock('@/models/decision', () => ({ recordShadow: vi.fn(), decide: vi.fn(async (_site, _state, _questions, observe?: (observation: DecisionObservation) => void) => {
  const answers = observed ?? decision;
  if (answers) observe?.({ model: 'local-clef', modelId: 'clef', answers, latencyMs: 12,
    minConfidence: Math.min(...Object.values(answers).map(a => a.confidence)), confident: decision !== null });
  return decision;
}) }));
vi.mock('@/db/repositories/user-repository', () => ({ userRepository: { findById: async () => ({ preferences: {} }) } }));
vi.mock('@/models/model-registry', async () => ({
  ...(await vi.importActual<typeof import('@/models/model-registry')>('@/models/model-registry')),
  getModelRegistry: () => ({ getModelForTopic: async () => ({ modelId: 'chat-model', name: 'chat-model' }), getUserBinding: async () => null }),
}));
vi.mock('@/models/litellm-client', async () => ({
  ...(await vi.importActual<typeof import('@/models/litellm-client')>('@/models/litellm-client')),
  getLiteLLMClient: () => ({ complete: async (opts: { messages: Array<{ content: string }> }) => {
    llmCalls++;
    referencePrompt = opts.messages[0].content;
    if (llmFails) throw new Error("reference unavailable");
    const ids = [...opts.messages[1].content.matchAll(/^(m\d+)\t/gm)].map((m) => m[1]);
    return { content: JSON.stringify(Object.fromEntries(ids.map((id) => [id, { priority: 'high', category: 'work', reason: 'r' }]))) };
  } }),
}));

const { triageInbox } = await import('./service');
const { recordShadow, decide } = await import('@/models/decision');
const item: InboxItem = { id: 'm1', provider: 'google', from: { email: 'a@b.c' }, subject: 's', snippet: 'x', receivedAt: '', unread: true };

describe('triageInbox with a decision model (live)', () => {
  beforeEach(() => { decision = null; observed = null; llmCalls = 0; llmFails = false; referencePrompt = ''; vi.mocked(recordShadow).mockClear(); vi.mocked(decide).mockClear(); });

  test('120 mails are triaged in batches of 30, all of them', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ ...item, id: `m${i}` }));
    const out = await triageInbox('u', many);
    expect(Object.keys(out)).toHaveLength(120);
    expect(llmCalls).toBe(4);
  });

  test('no decision model → LLM triage unchanged', async () => {
    expect(await triageInbox('u', [item])).toEqual({ m1: { priority: 'high', category: 'work', reason: 'r' } });
  });

  test('records rejected answers, both confidences, references and run correlation without mail contents', async () => {
    observed = {
      priority: { type: 'score', score: 0.1, probabilities: {}, confidence: 0.76 },
      category: { type: 'choice', choice: 'promotion', probabilities: {}, confidence: 0.92 },
    };
    await triageInbox('u', [{ ...item, subject: 'PRIVATE_SUBJECT', snippet: 'PRIVATE_SNIPPET' }]);
    const logs = vi.mocked(recordShadow).mock.calls.filter(([, kind]) => kind === 'email-evaluation').map(([entry]) => entry);
    expect(logs.find(e => e.event === 'decision')).toMatchObject({ messageId: 'm1', threshold: 0.8,
      decision: { model: 'local-clef', confident: false, priority: { value: 'low', confidence: 0.76 }, category: { value: 'promotion', confidence: 0.92 } } });
    expect(logs.find(e => e.event === 'comparison')).toMatchObject({ messageId: 'm1', referenceModel: 'chat-model', selectedSource: 'llm', reference: { priority: 'high', category: 'work' } });
    expect(new Set(logs.map(e => e.runId)).size).toBe(1);
    expect(JSON.stringify(logs)).not.toMatch(/PRIVATE_SUBJECT|PRIVATE_SNIPPET|a@b.c|"reason"/);
    await triageInbox('u', [item]);
    expect(new Set(vi.mocked(recordShadow).mock.calls.map(([e]) => e.runId)).size).toBe(2);
  });

  test('retains decision records and live answers when reference-only evaluation fails', async () => {
    decision = { priority: { type: 'score', score: 0, probabilities: {}, confidence: 0.9 },
      category: { type: 'choice', choice: 'promotion', probabilities: {}, confidence: 0.9 } };
    llmFails = true;
    expect((await triageInbox('u', [item])).m1.priority).toBe('low');
    expect(vi.mocked(recordShadow).mock.calls.some(([e]) => e.event === 'reference_failed')).toBe(true);
    decision = null;
    await expect(triageInbox('u', [item])).rejects.toThrow('reference unavailable');
  });

  test('confident decisions replace the LLM result', async () => {
    decision = {
      priority: { type: 'score', score: 0.1, probabilities: {}, confidence: 0.9 },
      category: { type: 'choice', choice: 'promotion', probabilities: {}, confidence: 0.9 },
    };
    expect((await triageInbox('u', [item])).m1).toEqual({ priority: 'low', category: 'promotion' });
    expect(llmCalls).toBe(1);
    const questions = vi.mocked(decide).mock.calls[0][2];
    expect(questions.priority.type).toBe('score');
    if (questions.priority.type !== 'score') throw new Error('Expected ordered priority criteria');
    expect(referencePrompt).toContain(questions.priority.instructions);
    for (const criterion of questions.priority.criteria) expect(referencePrompt).toContain(criterion);
    expect(vi.mocked(decide).mock.calls[0][0].minConfidence).toBe(0.8);
    const logs = vi.mocked(recordShadow).mock.calls.map(([entry]) => entry);
    expect(logs.find(e => e.event === 'comparison')).toMatchObject({ priorityRubric: 'action-required-v2', selectedSource: 'decision', reference: { priority: 'high', category: 'work' }, priorityAgreed: false, categoryAgreed: false });
  });
});
