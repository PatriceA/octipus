/** Live decisions retain precedence while references are recorded for calibration. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// Not under test here: the install-model gate (install-access.isolation.test.ts) lets these fake ids through.
vi.mock('@/models/install-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/models/install-access')>()),
  mayUseInstallModels: async () => true,
  assertInstallModelAccess: async () => {},
}));
import type { DecisionAnswers, DecisionObservation } from '@/models/decision';
import type { InboxItem } from './types';

let answers: DecisionAnswers | null = null;
let owner: Record<string, { priority: 'low' | 'normal' | 'high'; category: string }> = {};
let llmFails = false;
let llmCalls = 0;
let referencePrompt = '';
let referenceModel = '';
let primary: { provider?: string; modelId: string; name: string } = { modelId: 'chat-model', name: 'chat-model' };
let backup: { provider?: string; modelId: string; name: string } | null = null;
vi.mock('@/models/decision', () => ({ recordShadow: vi.fn(), decide: vi.fn(async (_site, _state, _questions, observe?: (observation: DecisionObservation) => void) => {
  if (answers) observe?.({ model: 'local-clef', modelId: 'clef', answers, latencyMs: 12,
    minConfidence: Math.min(...Object.values(answers).map(a => a.confidence)), confident: false });
  return answers;
}) }));
// The store is tested in triage-labels.test.ts; here only the gate and the flow.
vi.mock('./triage-labels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./triage-labels')>()),
  userLabels: vi.fn(async () => owner),
  examplesFor: vi.fn(async () => []),
  saveObservations: vi.fn(async () => {}),
  saveModelLabels: vi.fn(async () => {}),
  thresholdsFor: vi.fn(async () => ({ priority: 0.7, category: 0.7 })),
}));
/** Clef's answers: action/today yes-probabilities, a category, one confidence for all. */
const clef = (action: number, today: number, category: string, confidence: number): DecisionAnswers => ({
  action: { type: 'noul', p: action, confidence }, today: { type: 'noul', p: today, confidence },
  category: { type: 'choice', choice: category, probabilities: {}, confidence },
});
vi.mock('@/db/repositories/user-repository', () => ({ userRepository: { findById: async () => ({ preferences: {} }) } }));
vi.mock('@/models/model-registry', async () => ({
  ...(await vi.importActual<typeof import('@/models/model-registry')>('@/models/model-registry')),
  getModelRegistry: () => ({ getModelForTopic: async () => primary, getBackupModelForTopic: async () => backup, getUserBinding: async () => null }),
}));
vi.mock('@/models/litellm-client', async () => ({
  ...(await vi.importActual<typeof import('@/models/litellm-client')>('@/models/litellm-client')),
  getLiteLLMClient: () => ({ complete: async (opts: { model: string; messages: Array<{ content: string }> }) => {
    llmCalls++;
    referenceModel = opts.model;
    referencePrompt = opts.messages[0].content;
    if (llmFails) throw new Error("reference unavailable");
    const ids = [...opts.messages[1].content.matchAll(/^(m\d+)\t/gm)].map((m) => m[1]);
    return { content: JSON.stringify(Object.fromEntries(ids.map((id) => [id, { priority: 'high', category: 'work', reason: 'r' }]))) };
  } }),
}));

const { triageInbox } = await import('./service');
const { recordShadow, decide } = await import('@/models/decision');
const { saveModelLabels, saveObservations } = await import('./triage-labels');
const item: InboxItem = { id: 'm1', provider: 'google', from: { email: 'a@b.c' }, subject: 's', snippet: 'x', receivedAt: '', unread: true };

describe('triageInbox with a decision model (live)', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => { primary = { modelId: 'chat-model', name: 'chat-model' }; backup = null; answers = null; owner = {}; llmCalls = 0; llmFails = false; referencePrompt = ''; vi.mocked(recordShadow).mockClear(); vi.mocked(decide).mockClear(); vi.mocked(saveModelLabels).mockClear(); vi.mocked(saveObservations).mockClear(); });

  test('120 mails are triaged in batches of 30, all of them', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ ...item, id: `m${i}` }));
    const out = await triageInbox('u', many);
    expect(Object.keys(out)).toHaveLength(120);
    expect(llmCalls).toBe(4);
  });

  test('a CLI agent that cannot answer one-shot requests hands triage to the backup, else says why', async () => {
    primary = { provider: 'cli', modelId: 'cli/codex', name: 'codex' };
    await expect(triageInbox('u', [item])).rejects.toThrow(/codex, a CLI agent .* backup/);
    expect(llmCalls).toBe(0);
    backup = { provider: 'litellm', modelId: 'api-model', name: 'api-model' };
    expect((await triageInbox('u', [item])).m1.priority).toBe('high');
    expect(referenceModel).toBe('api-model');
  });

  test('no decision model → LLM triage unchanged', async () => {
    expect(await triageInbox('u', [item])).toEqual({ m1: { priority: 'high', category: 'work', reason: 'r', source: 'llm' } });
  });

  test('owner labels win without asking any model', async () => {
    owner = { m1: { priority: 'high', category: 'finance' } };
    expect(await triageInbox('u', [item])).toEqual({ m1: { priority: 'high', category: 'finance', source: 'owner' } });
    expect(llmCalls).toBe(0);
    expect(decide).not.toHaveBeenCalled();
  });

  test('records rejected answers, both confidences, references and run correlation without mail contents', async () => {
    answers = clef(0.2, 0.1, 'promotion', 0.6);
    await triageInbox('u', [{ ...item, subject: 'PRIVATE_SUBJECT', snippet: 'PRIVATE_SNIPPET' }]);
    const logs = vi.mocked(recordShadow).mock.calls.filter(([, kind]) => kind === 'email-evaluation').map(([entry]) => entry);
    expect(logs.find(e => e.event === 'decision')).toMatchObject({ messageId: 'm1', thresholds: { priority: 0.7, category: 0.7 },
      decision: { model: 'local-clef', priority: { value: 'low', confidence: 0.6 }, category: { value: 'promotion', confidence: 0.6 } } });
    expect(logs.find(e => e.event === 'comparison')).toMatchObject({ messageId: 'm1', referenceModel: 'chat-model', selectedSource: 'llm', reference: { priority: 'high', category: 'work' } });
    expect(new Set(logs.map(e => e.runId)).size).toBe(1);
    expect(JSON.stringify(logs)).not.toMatch(/PRIVATE_SUBJECT|PRIVATE_SNIPPET|a@b.c|"reason"/);
    // The training set gets Clef's answer and the reference label.
    expect(vi.mocked(saveObservations).mock.calls[0][3]).toMatchObject({ m1: { priority: 'low', category: 'promotion', rubric: 'action-split-v4' } });
    expect(vi.mocked(saveModelLabels).mock.calls[0][3]).toMatchObject({ m1: { priority: 'high', category: 'work' } });
    await triageInbox('u', [item]);
    expect(new Set(vi.mocked(recordShadow).mock.calls.map(([e]) => e.runId)).size).toBe(2);
  });

  test('retains decision records and live answers when reference-only evaluation fails', async () => {
    answers = clef(0.05, 0.05, 'promotion', 0.9);
    llmFails = true;
    vi.spyOn(Math, 'random').mockReturnValue(0); // audited
    expect((await triageInbox('u', [item])).m1.priority).toBe('low');
    expect(vi.mocked(recordShadow).mock.calls.some(([e]) => e.event === 'reference_failed')).toBe(true);
    answers = null;
    await expect(triageInbox('u', [item])).rejects.toThrow('reference unavailable');
  });

  test('confident decisions replace the LLM result; the gate is per question', async () => {
    answers = clef(0.9, 0.2, 'promotion', 0.9);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect((await triageInbox('u', [item])).m1).toEqual({ priority: 'normal', category: 'promotion', source: 'decision' });
    expect(llmCalls).toBe(0); // decided, not audited: no LLM call
    random.mockReturnValue(0); // audited: the LLM labels it, the decision still wins
    expect((await triageInbox('u', [item])).m1).toEqual({ priority: 'normal', category: 'promotion', source: 'decision' });
    expect(llmCalls).toBe(1);
    const questions = vi.mocked(decide).mock.calls[0][2];
    expect(Object.keys(questions)).toEqual(['action', 'today', 'category']);
    expect(vi.mocked(decide).mock.calls[0][1]).toMatchObject({ mail: { subject: 's' } });
    const logs = vi.mocked(recordShadow).mock.calls.map(([entry]) => entry);
    expect(logs.find(e => e.event === 'comparison')).toMatchObject({ priorityRubric: 'action-split-v4', selectedSource: 'decision', priorityAgreed: false, categoryAgreed: false });
    // One answer under its threshold → the LLM's answer.
    answers = { ...clef(0.9, 0.2, 'promotion', 0.9), today: { type: 'noul', p: 0.4, confidence: 0.5 } };
    expect((await triageInbox('u', [item])).m1).toMatchObject({ priority: 'high', category: 'work' });
  });
});

describe('triageInbox on an IMAP / POP3 mailbox', () => {
  beforeEach(() => { primary = { modelId: 'chat-model', name: 'chat-model' }; backup = null; answers = null; owner = {}; llmCalls = 0; llmFails = false; vi.mocked(saveModelLabels).mockClear(); vi.mocked(saveObservations).mockClear(); });

  test('labels, answers and the training set are keyed by the mailbox, not by a provider', async () => {
    const { userLabels } = await import('./triage-labels');
    vi.mocked(userLabels).mockClear();
    const box = 'imap:0b9d3c55-5f2c-4c37-9a3e-6d1f00000001' as const;
    const imapMail: InboxItem = { ...item, provider: 'imap', mailbox: box };
    expect((await triageInbox('u', [imapMail])).m1).toMatchObject({ priority: 'high', source: 'llm' });
    expect(vi.mocked(userLabels).mock.calls[0][1]).toBe(box);
    expect(vi.mocked(saveModelLabels).mock.calls[0][1]).toBe(box);
  });

  test('IMAP mail without its mailbox is refused rather than filed under a provider', async () => {
    await expect(triageInbox('u', [{ ...item, provider: 'imap' }])).rejects.toThrow(/must name its mailbox/);
    expect(llmCalls).toBe(0);
  });
});
