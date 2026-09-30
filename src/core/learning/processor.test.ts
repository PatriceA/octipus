import { beforeEach, expect, test, vi } from 'vitest';
import type { BackgroundJob } from '@/db/schema/background-jobs';
const mock = vi.hoisted(() => ({
  finish: vi.fn(), progress: vi.fn(), session: vi.fn(), evidence: vi.fn(), model: vi.fn(), complete: vi.fn(),
  save: vi.fn(), findNote: vi.fn(), judge: vi.fn(), proposal: vi.fn(), permission: vi.fn(),
}));
vi.mock('@/db/repositories/background-job-repository', () => ({ backgroundJobRepository: { finish: mock.finish, progress: mock.progress } }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: mock.session } }));
vi.mock('./evidence', () => ({ gatherEvidence: mock.evidence }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModelForTopic: mock.model }) }));
vi.mock('@/models/litellm-client', () => ({ getLiteLLMClient: () => ({ complete: mock.complete }) }));
vi.mock('@/core/knowledge/notes', () => ({ getNoteService: () => ({ save: mock.save }) }));
vi.mock('@/db/repositories/note-repository', () => ({ getNoteRepository: () => ({ getBySlug: mock.findNote }) }));
vi.mock('@/core/memory/judge', () => ({ judgeAndApply: mock.judge }));
vi.mock('@/services/file-skill-proposal', () => ({ fileSkillProposal: mock.proposal }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: mock.permission }) }));
vi.mock('@/config', () => ({ getConfig: () => ({ memory: { extractionCadence: 'per_turn' } }) }));
import { processLearningJob } from './processor';
const job: Pick<BackgroundJob, 'id' | 'userId' | 'workspaceId' | 'payload'> = { id: 'j1', userId: 'u1', workspaceId: 'w1', payload: { sessionId: 's1', trigger: 'plan_completed', triggerKey: 'p1:2', through: '2026-09-28T00:00:00.000Z' } };
const empty = { reason: 'Nothing reusable', knowledge: [], memories: [], skills: [] };
const skill = { name: 'repair-cache', description: 'Repair stale caches', content: 'Check cache then invalidate and verify', sources: ['event:1'] };
beforeEach(() => {
  vi.resetAllMocks();
  mock.session.mockResolvedValue({ id: 's1', userId: 'u1', workspaceId: 'w1' });
  mock.evidence.mockResolvedValue([{ id: 'event:1', kind: 'execution', text: 'failed then passed' }, { id: 'message:m1', kind: 'user', text: 'Keep replies short' }]);
  mock.model.mockResolvedValue({ modelId: 'configured-background-model' });
  mock.complete.mockResolvedValue({ content: JSON.stringify(empty) });
  mock.permission.mockResolvedValue({ level: 'ALLOW' });
});
test('quiet runs are reviewed using execution evidence and report deliberate no-op', async () => {
  await processLearningJob(job);
  expect(mock.complete.mock.calls[0][0].messages[1].content).toContain('failed then passed');
  expect(mock.finish).toHaveBeenCalledWith('j1', expect.objectContaining({ status: 'done', stage: 'nothing_reusable' }));
});
test('reports absent evidence without spending model tokens', async () => {
  mock.evidence.mockResolvedValue([]); await processLearningJob(job);
  expect(mock.complete).not.toHaveBeenCalled();
  expect(mock.finish).toHaveBeenCalledWith('j1', expect.objectContaining({ stage: 'insufficient_evidence' }));
});

test('uses the configured output budget and retries truncation once before writes', async () => {
  mock.model.mockResolvedValue({ name: 'reviewer', modelId: 'openrouter/reviewer', defaultMaxTokens: 16384, maxTokens: 131072 });
  mock.complete.mockResolvedValueOnce({ content: '', finishReason: 'length', usage: { reasoningTokens: 16384 } })
    .mockResolvedValueOnce({ content: JSON.stringify(empty), finishReason: 'stop' });
  await processLearningJob(job);
  expect(mock.complete.mock.calls.map(([options]) => options.maxTokens)).toEqual([16384, 32768]);
  expect(mock.complete.mock.calls[0][0].modelConfigName).toBe('reviewer');
  expect(mock.finish).toHaveBeenCalledWith('j1', expect.objectContaining({ status: 'done' }));
});

test('caps output at the provider ceiling and reports exhausted budget', async () => {
  mock.model.mockResolvedValue({ name: 'small', modelId: 'small', defaultMaxTokens: 16384, maxTokens: 8192 });
  mock.complete.mockResolvedValue({ content: '', finishReason: 'length', usage: { outputTokens: 8192, reasoningTokens: 8100 } });
  await processLearningJob(job);
  expect(mock.complete).toHaveBeenCalledTimes(1);
  expect(mock.complete.mock.calls[0][0].maxTokens).toBe(8192);
  expect(mock.finish.mock.calls[0][1].error).toContain('reasoning 8100');
  expect(mock.save).not.toHaveBeenCalled();
});
test.each(['malformed', 'missing-model', 'truncated'])('reports %s as failure', async mode => {
  if (mode === 'missing-model') mock.model.mockResolvedValue(null);
  else mock.complete.mockResolvedValue({ content: mode === 'malformed' ? 'oops' : JSON.stringify(empty), finishReason: mode === 'truncated' ? 'length' : 'stop' });
  await processLearningJob(job);
  expect(mock.finish).toHaveBeenCalledWith('j1', expect.objectContaining({ status: 'error' }));
});
test('refuses foreign sessions before reading evidence', async () => {
  mock.session.mockResolvedValue({ userId: 'other', workspaceId: 'w1' }); await processLearningJob(job);
  expect(mock.evidence).not.toHaveBeenCalled();
  expect(mock.finish).toHaveBeenCalledWith('j1', expect.objectContaining({ status: 'error' }));
});
test('files only a pending skill through the existing dedup writer', async () => {
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, skills: [skill] }) });
  mock.proposal.mockResolvedValue({ proposalId: 'p1', distilled: true });
  await processLearningJob(job);
  expect(mock.proposal).toHaveBeenCalledWith(expect.objectContaining({ name: skill.name }), 'u1', 'learning:j1:session:s1');
  expect(mock.finish.mock.calls[0][1].result.outputs).toEqual([expect.objectContaining({ kind: 'skill', status: 'proposed', id: 'p1' })]);
});
test.each(['DENY', 'ASK'])('respects %s without approving a background write', async level => {
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, skills: [skill] }) });
  mock.permission.mockResolvedValue({ level }); await processLearningJob(job);
  expect(mock.proposal).not.toHaveBeenCalled();
  expect(mock.finish.mock.calls[0][1].status).toBe('error');
});
test('keeps partial write receipts and reports an indexing failure', async () => {
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, knowledge: [{ title: 'Cache rule', content: 'Reset after schema changes', sources: ['event:1'] }],
    memories: [{ factType: 'preference', content: 'Prefers short replies', confidence: 1, sources: ['message:m1'] }] }) });
  mock.save.mockResolvedValue({ created: true, indexed: false, note: { id: 'n1' } });
  mock.judge.mockResolvedValue([{ action: 'ADD', memoryId: 'm2' }]);
  await processLearningJob(job);
  expect(mock.save.mock.calls[0][0].workspaceId).toBe('w1');
  expect(mock.judge.mock.calls[0][1]).toMatchObject({ sourceMessageId: 'm1', failOnError: true });
  expect(mock.finish.mock.calls[0][1]).toMatchObject({ status: 'error', stage: 'partial_failure', result: { outputs: [
    { kind: 'knowledge', status: 'saved_unindexed', id: 'n1' }, { kind: 'memory', status: 'saved', id: 'm2' },
  ] } });
});
