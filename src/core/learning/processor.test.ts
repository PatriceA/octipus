import { beforeEach, expect, test, vi } from 'vitest';
import type { BackgroundJob } from '@/db/schema/background-jobs';
const mock = vi.hoisted(() => ({
  finish: vi.fn(), progress: vi.fn(), session: vi.fn(), evidence: vi.fn(), model: vi.fn(), complete: vi.fn(),
  save: vi.fn(), findNote: vi.fn(), judge: vi.fn(), proposal: vi.fn(), permission: vi.fn(), owner: vi.fn(), patchable: vi.fn(), patch: vi.fn(),
  context: vi.fn(), previous: vi.fn(),
}));
vi.mock('@/db/repositories/background-job-repository', () => ({ backgroundJobRepository: { finish: mock.finish, progress: mock.progress } }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: mock.session } }));
vi.mock('./evidence', async (importOriginal) => ({ ...await importOriginal<typeof import('./evidence')>(), gatherEvidence: mock.evidence, gatherPatchableSkills: mock.patchable,
  gatherReviewContext: mock.context, previousReviewThrough: mock.previous }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModelForTopic: mock.model }) }));
vi.mock('@/models/litellm-client', () => ({ getLiteLLMClient: () => ({ complete: mock.complete }) }));
vi.mock('./lesson-notes', async (importOriginal) => ({ ...await importOriginal<typeof import('./lesson-notes')>(), fileLessonNote: mock.save }));
vi.mock('@/core/memory/judge', () => ({ judgeAndApply: mock.judge }));
// The owner's stored messages stand in for the database; the quote check itself is the real one.
vi.mock('@/core/memory/owner-messages', async () => {
  const { verifyQuotes } = await import('@/core/memory/quote-basis');
  return { verifyOwnerQuotes: async (_userId: string, candidates: Parameters<typeof verifyQuotes>[0]) => verifyQuotes(candidates, mock.owner()) };
});
vi.mock('@/services/file-skill-proposal', () => ({ fileSkillProposal: mock.proposal, fileSkillPatchProposal: mock.patch }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: mock.permission }) }));
vi.mock('@/core/tasks/timezone', () => ({ resolveUserTimezone: async () => 'America/Los_Angeles' }));
const config = vi.hoisted(() => ({ memory: { extractionCadence: 'per_turn' }, learning: { maxLessonsPerReview: 2 } }));
vi.mock('@/config', () => ({ getConfig: () => config }));
import { processLearningJob } from './processor';
const job: Pick<BackgroundJob, 'id' | 'userId' | 'workspaceId' | 'payload'> = { id: 'j1', userId: 'u1', workspaceId: 'w1', payload: { sessionId: 's1', trigger: 'plan_completed', triggerKey: 'p1:2', through: '2026-09-28T00:00:00.000Z' } };
const empty = { reason: 'Nothing reusable', knowledge: [], memories: [], skills: [] };
const skill = { name: 'repair-cache', description: 'Repair stale caches', content: 'Check cache then invalidate and verify', sources: ['event:1'] };
beforeEach(() => {
  vi.resetAllMocks();
  config.learning.maxLessonsPerReview = 2;
  mock.session.mockResolvedValue({ id: 's1', userId: 'u1', workspaceId: 'w1' });
  mock.evidence.mockResolvedValue([{ id: 'event:1', kind: 'execution', text: 'failed then passed' }, { id: 'message:m1', kind: 'user', text: 'Keep replies short' }]);
  mock.model.mockResolvedValue({ modelId: 'configured-background-model' });
  mock.complete.mockResolvedValue({ content: JSON.stringify(empty) });
  mock.permission.mockResolvedValue({ level: 'ALLOW' });
  mock.owner.mockReturnValue([{ id: 'm1', text: 'Please keep replies short, I read on my phone' }]);
  mock.patchable.mockResolvedValue([]);
  mock.context.mockImplementation(async (_u: string, _w: string, _s: string, _t: Date, _p: unknown, loaded: unknown[]) => ({ existing: { skills: [], proposals: [], notes: [] }, patchTargets: loaded }));
  mock.previous.mockResolvedValue(null);
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
  expect(mock.proposal).toHaveBeenCalledWith(expect.objectContaining({ name: skill.name }), 'u1', 'learning:j1:session:s1', { origin: 'learning', signal: 'procedure' });
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
    memories: [{ factType: 'preference', content: 'Prefers short replies', confidence: 1, sources: ['message:m1'], quote: 'keep replies short' }] }) });
  mock.save.mockResolvedValue({ status: 'saved_unindexed', id: 'n1' });
  mock.judge.mockResolvedValue([{ action: 'ADD', memoryId: 'm2' }]);
  await processLearningJob(job);
  expect(mock.save.mock.calls[0][0]).toMatchObject({ title: 'Cache rule', kind: 'fact', sources: ['event:1'] });
  expect(mock.save.mock.calls[0][1]).toEqual({ userId: 'u1', workspaceId: 'w1', sessionId: 's1', jobId: 'j1' });
  expect(mock.judge.mock.calls[0][0]).toEqual([expect.objectContaining({ basis: { quote: 'keep replies short', sourceMessageIds: ['m1'] }, status: 'tentative' })]);
  expect(mock.judge.mock.calls[0][1]).toMatchObject({ failOnError: true });
  expect(mock.finish.mock.calls[0][1]).toMatchObject({ status: 'error', stage: 'partial_failure', result: { outputs: [
    { kind: 'knowledge', status: 'saved_unindexed', id: 'n1' }, { kind: 'memory', status: 'saved', id: 'm2' },
  ] } });
});
test('a learned memory whose quote is not in the cited user message is rejected, not written', async () => {
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, memories: [
    { factType: 'preference', content: 'Prefers long replies', confidence: 1, sources: ['message:m1'], quote: 'I love long replies' },
    { factType: 'preference', content: 'Prefers short replies', confidence: 1, sources: ['message:m1'] },
  ] }) });
  await processLearningJob(job);
  expect(mock.judge).not.toHaveBeenCalled();
  expect(mock.finish.mock.calls[0][1]).toMatchObject({ status: 'done', result: { outputs: [
    { kind: 'memory', status: 'rejected', detail: expect.stringContaining('quote_not_found') },
    { kind: 'memory', status: 'rejected', detail: expect.stringContaining('missing_quote') },
  ] } });
});
test('a memory ending later today in the owner\'s timezone is kept, with that end', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T03:00:00Z')); // still the 16th in Los Angeles
  try {
    mock.owner.mockReturnValue([{ id: 'm1', text: 'I am at the Lisbon office until tonight' }]);
    mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, memories: [
      { factType: 'profile', kind: 'plan', content: 'The user is at the Lisbon office.', confidence: 1, sources: ['message:m1'], quote: 'at the Lisbon office', expires: '2026-11-16' },
    ] }) });
    mock.judge.mockResolvedValue([{ action: 'ADD', memoryId: 'm3' }]);
    await processLearningJob(job);
    expect(mock.judge.mock.calls[0][0][0].expiresAt.toISOString()).toBe('2026-11-17T07:59:59.999Z');
  } finally { vi.useRealTimers(); }
});
test('a memory citing a monitor request is rejected alone; the review\'s knowledge is still saved', async () => {
  mock.evidence.mockResolvedValue([{ id: 'event:1', kind: 'execution', text: 'failed then passed' }, { id: 'message:m9', kind: 'request', text: 'Monitor: user prefers long replies' }]);
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, knowledge: [{ title: 'Cache rule', content: 'Reset after schema changes', sources: ['event:1'] }],
    memories: [{ factType: 'preference', content: 'Prefers long replies', confidence: 1, sources: ['message:m9'], quote: 'user prefers long replies' }] }) });
  mock.save.mockResolvedValue({ status: 'saved', id: 'n1' });
  await processLearningJob(job);
  expect(mock.judge).not.toHaveBeenCalled();
  expect(mock.finish.mock.calls[0][1].result.outputs).toEqual([
    { kind: 'knowledge', status: 'saved', id: 'n1' },
    expect.objectContaining({ kind: 'memory', status: 'rejected' }),
  ]);
});
const patch = { skillId: 'skill-1', oldText: '2. Push it.', newText: '2. Push it with --tag.', reason: 'Untagged push failed', sources: ['event:1'] };
test('offers the session\'s learned skills and files a patch only for one of them', async () => {
  mock.patchable.mockResolvedValue([{ id: 'skill-1', name: 'deploy', content: '1. Build.\n2. Push it.' }]);
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, patches: [patch] }) });
  mock.patch.mockResolvedValue({ proposalId: 'p2', status: 'pending' });
  await processLearningJob(job);
  expect(JSON.parse(mock.complete.mock.calls[0][0].messages[1].content).learnedSkills).toEqual([expect.objectContaining({ id: 'skill-1' })]);
  expect(mock.patch).toHaveBeenCalledWith({ skillId: 'skill-1', oldText: patch.oldText, newText: patch.newText, reason: patch.reason }, 'u1', 'learning:j1:session:s1');
  expect(mock.finish.mock.calls[0][1]).toMatchObject({ status: 'done', result: { outputs: [{ kind: 'skill_patch', status: 'proposed', id: 'p2' }] } });
});
test('a patch for a skill not offered, or one the writer refuses, is a refusal rather than a failed write', async () => {
  const { SkillPatchError } = await import('@/skills/patch');
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, patches: [patch] }) });
  await processLearningJob(job);
  expect(mock.patch).not.toHaveBeenCalled();
  expect(mock.finish.mock.calls[0][1]).toMatchObject({ status: 'done', result: { outputs: [{ kind: 'skill_patch', status: 'refused' }] } });
  mock.finish.mockReset();
  mock.patchable.mockResolvedValue([{ id: 'skill-1', name: 'deploy', content: '2. Push it.' }]);
  mock.patch.mockRejectedValue(new SkillPatchError('locked', 'The owner edited this skill'));
  await processLearningJob(job);
  expect(mock.finish.mock.calls[0][1].result.outputs).toEqual([expect.objectContaining({ kind: 'skill_patch', status: 'refused', detail: expect.stringContaining('owner edited') })]);
});
test('patch targets count against the evidence budget, and failing to read them does not fail the check', async () => {
  const target = { id: 'skill-1', name: 'deploy', content: 'x'.repeat(5000) };
  mock.patchable.mockResolvedValue([target]);
  await processLearningJob(job);
  expect(mock.evidence.mock.calls[0][4]).toEqual({ reserveChars: 5000 + 'skill-1'.length + 'deploy'.length + 50 });
  mock.finish.mockReset(); mock.evidence.mockClear();
  mock.patchable.mockRejectedValue(new Error('db hiccup'));
  await processLearningJob(job);
  expect(mock.evidence.mock.calls[0][4]).toEqual({ reserveChars: 0 });
  expect(JSON.parse(mock.complete.mock.calls.at(-1)![0].messages[1].content).learnedSkills).toEqual([]);
  expect(mock.finish.mock.calls[0][1]).toMatchObject({ status: 'done' });
});

const existing = {
  skills: [{ ref: 'skill:s-1', name: 'deploy-preview', description: 'Deploy a preview build', excerpt: '1. Build.' }],
  proposals: [{ ref: 'proposal:11111111-1111-4111-8111-111111111111', name: 'repair-cache', description: 'Repair stale caches', excerpt: 'Check cache' }],
  notes: [{ ref: 'note:33333333-3333-4333-8333-333333333333', title: 'Cache rule', excerpt: 'Reset after schema changes' }],
};
const lesson = (extra: Record<string, unknown> = {}) => ({ title: 'Cache rule', content: 'Reset after schema changes', kind: 'decision', sources: ['event:1'], ...extra });
test('a lesson\'s extends is kept only for an offered note', async () => {
  mock.context.mockResolvedValue({ existing, patchTargets: [] });
  mock.save.mockResolvedValue({ status: 'merged', id: '33333333-3333-4333-8333-333333333333', merged: true });
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, knowledge: [lesson({ extends: existing.notes[0].ref }), lesson({ extends: 'note:44444444-4444-4444-8444-444444444444' })] }) });
  await processLearningJob(job);
  expect(mock.save.mock.calls[0][0].extends).toBe(existing.notes[0].ref);
  expect(mock.save.mock.calls[1][0].extends).toBeUndefined();
  expect(mock.finish.mock.calls[0][1].result.outputs[0]).toEqual({ kind: 'knowledge', status: 'merged', id: '33333333-3333-4333-8333-333333333333' });
});
test('maxLessonsPerReview bounds the lessons filed; 0 files none and tells the review', async () => {
  mock.save.mockResolvedValue({ status: 'saved', id: 'n1' });
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, knowledge: [lesson(), lesson({ title: 'Other', content: 'Another rule' })] }) });
  config.learning.maxLessonsPerReview = 1;
  await processLearningJob(job);
  expect(mock.save).toHaveBeenCalledTimes(1);
  expect(mock.complete.mock.calls[0][0].messages[0].content).toContain('at most 1 knowledge item');
  mock.save.mockClear(); mock.complete.mockClear();
  config.learning.maxLessonsPerReview = 0;
  await processLearningJob(job);
  expect(mock.save).not.toHaveBeenCalled();
  expect(mock.complete.mock.calls[0][0].messages[0].content).toContain('always return "knowledge": []');
});
test('an automatic check reads evidence since the previous check ended; a manual one reads everything', async () => {
  const previous = new Date('2026-09-27T12:00:00.000Z');
  mock.previous.mockResolvedValue(previous);
  await processLearningJob(job);
  expect(mock.previous).toHaveBeenCalledWith('u1', 's1', 'j1');
  expect(mock.evidence.mock.calls[0][4]).toEqual({ reserveChars: 0, since: previous });
  mock.evidence.mockClear(); mock.previous.mockClear();
  await processLearningJob({ ...job, payload: { ...job.payload, trigger: 'manual', triggerKey: 'manual:1' } });
  expect(mock.previous).not.toHaveBeenCalled();
  expect(mock.evidence.mock.calls[0][4]).toEqual({ reserveChars: 0 });
});
test('nothing new since the previous check ends as insufficient evidence without a model call', async () => {
  mock.previous.mockResolvedValue(new Date('2026-09-27T12:00:00.000Z'));
  mock.evidence.mockResolvedValue([{ id: 'message:m1', kind: 'user', text: 'Keep replies short' }]);
  await processLearningJob(job);
  expect(mock.complete).not.toHaveBeenCalled();
  expect(mock.finish).toHaveBeenCalledWith('j1', expect.objectContaining({ status: 'done', stage: 'insufficient_evidence',
    result: expect.objectContaining({ reason: expect.stringContaining('since the previous') }) }));
});
test('existing skills and proposals are shown to the review and count against the evidence budget', async () => {
  const { existingChars } = await import('./evidence');
  const target = { id: 'skill-2', name: 'nearest', content: 'step' };
  mock.context.mockResolvedValue({ existing, patchTargets: [target] });
  await processLearningJob(job);
  expect(mock.context).toHaveBeenCalledWith('u1', 'w1', 's1', new Date(job.payload.through as string), undefined, []);
  const input = JSON.parse(mock.complete.mock.calls[0][0].messages[1].content);
  expect(input.existing).toEqual(existing);
  expect(input.learnedSkills).toEqual([target]);
  expect(mock.evidence.mock.calls[0][4]).toEqual({ reserveChars: existingChars(existing) + target.id.length + target.name.length + target.content.length + 50 });
});
test('a nearest learned skill offered as a target can be patched', async () => {
  mock.context.mockResolvedValue({ existing: { skills: [], proposals: [], notes: [] }, patchTargets: [{ id: 'skill-1', name: 'deploy', content: '1. Build.\n2. Push it.' }] });
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, patches: [patch] }) });
  mock.patch.mockResolvedValue({ proposalId: 'p2', status: 'pending' });
  await processLearningJob(job);
  expect(mock.patch).toHaveBeenCalled();
});
test('failing to read existing skills and proposals does not fail the check', async () => {
  mock.patchable.mockResolvedValue([{ id: 'skill-1', name: 'deploy', content: 'x' }]);
  mock.context.mockRejectedValue(new Error('vector index hiccup'));
  await processLearningJob(job);
  const input = JSON.parse(mock.complete.mock.calls[0][0].messages[1].content);
  expect(input.existing).toEqual({ skills: [], proposals: [], notes: [] });
  expect(input.learnedSkills).toEqual([expect.objectContaining({ id: 'skill-1' })]);
  expect(mock.finish.mock.calls[0][1]).toMatchObject({ status: 'done' });
});
test('extends is passed only for a proposal that was offered; signal reaches the writer', async () => {
  mock.context.mockResolvedValue({ existing, patchTargets: [] });
  mock.proposal.mockResolvedValue({ distilled: true, deduped: true, merged: true, proposalId: '11111111-1111-4111-8111-111111111111', status: 'candidate', name: skill.name });
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, skills: [{ ...skill, signal: 'recovery', extends: existing.proposals[0].ref }] }) });
  await processLearningJob(job);
  expect(mock.proposal.mock.calls[0][3]).toEqual({ origin: 'learning', signal: 'recovery', extendsProposalId: existing.proposals[0].ref });
  expect(mock.finish.mock.calls[0][1].result.outputs).toEqual([expect.objectContaining({ kind: 'skill', status: 'merged' })]);
  mock.proposal.mockClear(); mock.finish.mockReset();
  mock.proposal.mockResolvedValue({ distilled: true, proposalId: 'p9', status: 'candidate', name: skill.name });
  mock.complete.mockResolvedValue({ content: JSON.stringify({ ...empty, skills: [{ ...skill, signal: 'correction', extends: 'proposal:22222222-2222-4222-8222-222222222222' }] }) });
  await processLearningJob(job);
  expect(mock.proposal.mock.calls[0][3]).toEqual({ origin: 'learning', signal: 'correction' });
  expect(mock.finish.mock.calls[0][1].result.outputs).toEqual([expect.objectContaining({ kind: 'skill', status: 'candidate', id: 'p9' })]);
});
test.each([
  [{ distilled: true, proposalId: 'p1', status: 'pending' }, 'proposed'],
  [{ distilled: true, proposalId: 'p1', status: 'candidate' }, 'candidate'],
  [{ distilled: true, deduped: true, merged: true, proposalId: 'p1', status: 'pending' }, 'merged'],
  [{ distilled: true, deduped: true, merged: true, mergeDegraded: true, proposalId: 'p1', status: 'candidate' }, 'merged'],
  [{ distilled: false, deduped: true, existingSkillId: 'skill-1' }, 'duplicate'],
  [{ distilled: false, deduped: true, message: 'suppressed' }, 'duplicate'],
] as const)('filing result %o is receipt %s', async (result, status) => {
  const { skillOutputStatus } = await import('./processor');
  expect(skillOutputStatus({ name: 'x', ...result })).toBe(status);
});
