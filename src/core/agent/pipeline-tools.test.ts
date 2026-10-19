import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import { createPipelineRecoveryTools } from './pipeline-tools';
import { createMetaTools } from './meta-tools';
const fixture = vi.hoisted(() => ({
  history: vi.fn(), stop: vi.fn(), edit: vi.fn(), find: vi.fn(), nodes: vi.fn(), items: vi.fn(), checkpoints: vi.fn(), resume: vi.fn(),
  updateItem: vi.fn(), updatePipeline: vi.fn(), ask: vi.fn(), approve: vi.fn(), deny: vi.fn(),
}));
vi.mock('@/db/repositories/pipeline-repository', () => ({ pipelineRepository: {
  getStageHistory: fixture.history, queueItemEdit: fixture.edit, findById: fixture.find, getNodes: fixture.nodes, getPlanItems: fixture.items, getCheckpoints: fixture.checkpoints,
  updatePlanItem: fixture.updateItem, updatePipeline: fixture.updatePipeline,
} }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ approve: fixture.approve, deny: fixture.deny }) }));
vi.mock('./service', () => ({ getAgentService: () => ({ requestApproval: fixture.ask }) }));
vi.mock('./pipeline-manager', () => ({ getPipelineManager: () => ({ resume: fixture.resume, stop: fixture.stop }) }));
vi.mock('./templates', () => ({ listAvailableTemplates: async () => [{ id: 'template', name: 'Build' }] }));
const context = { userId: 'owner', sessionId: 'session', workspaceId: 'workspace' } as AgentContext;
const tool = (name: string) => createPipelineRecoveryTools().find(tool => tool.name === name)!;
beforeEach(() => {
  vi.resetAllMocks();
  fixture.history.mockResolvedValue([]);
  fixture.deny.mockResolvedValue(true);
  fixture.find.mockResolvedValue({ id: 'pipeline', userId: 'owner', sessionId: 'session', workspaceId: 'workspace', status: 'failed' });
  fixture.nodes.mockResolvedValue([{ nodeKey: 'qa', name: 'QA', status: 'failed', output: 'Checks failed\n```handoff\n{}\n```' }]);
  fixture.items.mockResolvedValue([{ title: 'done item', status: 'done' }, { title: 'remaining item', status: 'running' }]);
  fixture.checkpoints.mockResolvedValue([{ seq: 4, nodeKey: 'qa' }, { seq: 3, nodeKey: 'implementation' }]);
});
describe('pipeline recovery tools', () => {
  it('returns a resume handle before replay approval is answered', async () => {
    fixture.resume.mockImplementation(async (_id, options) => { await Promise.resolve(); options.onAccepted(); return new Promise(() => {}); });
    const track = vi.fn();
    const resume = createPipelineRecoveryTools(track).find(t => t.name === 'resume_pipeline')!;
    await expect(resume.execute({ id: 'pipeline' }, context)).resolves.toMatchObject({ status: 'resuming' });
    expect(track).toHaveBeenCalledOnce();
  });
  it('bounds a stalled status read without taking a runner lock', async () => {
    vi.useFakeTimers();
    try {
      fixture.nodes.mockImplementation(() => new Promise(() => {}));
      const read = tool('get_pipeline_status').execute({ id: 'pipeline' }, context);
      const rejected = expect(read).rejects.toThrow('15 seconds');
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(fixture.resume).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('derives running summaries from the live item, retaining per-item attempt history', async () => {
    fixture.find.mockResolvedValue({ ...context, id: 'pipeline', status: 'running', currentNodeKey: 'qa', summary: 'Waiting for old approval' });
    fixture.items.mockResolvedValue([{ id: 'i2', title: 'Phase 2', status: 'running' }]);
    fixture.history.mockResolvedValue([{ seq: 1, subjectId: 'qa', event: 'node_completed', payload: { itemId: 'i1', attemptId: 'a1', output: 'P1 passed' } },
      { seq: 2, subjectId: 'qa', event: 'spawn', payload: { itemId: 'i2', attemptId: 'a2' } }]);
    const result = await tool('get_pipeline_status').execute({ id: 'pipeline' }, context);
    expect(result).toMatchObject({ summary: 'Running at "QA" for "Phase 2".', items: [{ stages: [{ attemptId: 'a2' }] }] });
    expect(tool('get_pipeline_status').replaySafety).toBe('read_only');
  });
  it('queues session-owned plan edits without rewriting the visible work plan', async () => {
    fixture.find.mockResolvedValue({ ...context, id: 'pipeline', status: 'running' });
    await expect(tool('update_pipeline_items').execute({ id: 'pipeline', skip: ['old'], add: [{ title: 'Replacement' }], evidence: 'User replaced the old scope' }, context)).resolves.toMatchObject({ queued: true });
    expect(fixture.edit).toHaveBeenCalledWith('pipeline', expect.objectContaining({ skip: ['old'], add: [{ title: 'Replacement' }] }));
    expect(fixture.updateItem).not.toHaveBeenCalled();
  });
  it('stops a same-session pipeline started by an earlier root', async () => {
    fixture.stop.mockResolvedValue(true);
    await expect(tool('stop_pipeline').execute({ id: 'pipeline' }, context)).resolves.toMatchObject({ stopped: true, status: 'stopped', resumable: true });
    expect(fixture.stop).toHaveBeenCalledWith('pipeline');
  });
  it('reports remaining work and strips internal handoffs', async () => {
    const result = await tool('get_pipeline_status').execute({ id: 'pipeline' }, context);
    expect(result).toMatchObject({ remainingItems: ['remaining item'], stages: [{ output: 'Checks failed' }] });
  });
  it('omits the history query when polling current state', async () => {
    await expect(tool('get_pipeline_status').execute({ id: 'pipeline', includeHistory: false }, context)).resolves.toMatchObject({ historyIncluded: false });
    expect(fixture.history).not.toHaveBeenCalled();
  });
  it.each([{ userId: 'other' }, { sessionId: 'other' }, { workspaceId: 'other' }])('rejects a handle outside the caller scope: %o', async mismatch => {
    await expect(tool('resume_pipeline').execute({ id: 'pipeline' }, { ...context, ...mismatch })).rejects.toThrow('not found');
    expect(fixture.resume).not.toHaveBeenCalled();
  });
  it('returns once resume is accepted without waiting for execution', async () => {
    fixture.resume.mockImplementation((_id, options) => { options.onResumed(); return new Promise(() => {}); });
    expect(await tool('resume_pipeline').execute({ id: 'pipeline', fromStage: 'QA' }, context)).toMatchObject({ status: 'running', fromStage: 'qa' });
    expect(fixture.resume).toHaveBeenCalledWith('pipeline', expect.objectContaining({ fromSeq: 4 }));
  });
  it('surfaces resume validation errors without claiming the run started', async () => {
    fixture.resume.mockRejectedValue(new Error('Membership revoked'));
    await expect(tool('resume_pipeline').execute({ id: 'pipeline' }, context)).rejects.toThrow('Membership revoked');
  });
  it('does not rewind an unknown stage', async () => {
    await expect(tool('resume_pipeline').execute({ id: 'pipeline', fromStage: 'unknown' }, context)).rejects.toThrow('Unknown stage');
    expect(fixture.resume).not.toHaveBeenCalled();
  });
  it.each(['create_pipeline', 'invoke_recipe'])('returns a handle from %s while execution is still pending', async name => {
    const createAndRunPipeline = vi.fn(async (_title, _template, _description, _context, options) => {
      await Promise.resolve();
      options.onCreated('pipeline');
      return new Promise(() => {});
    });
    const create = createMetaTools({ createAndRunPipeline } as never).find(tool => tool.name === name)!;
    expect(await create.execute({ title: 'Test', templateName: 'Build', recipeName: 'Build', description: 'Build it' }, context)).toMatchObject({ id: 'pipeline', status: 'running' });
    expect(create.final).not.toBe(true);
  });
});

it('keeps the pipeline outcome available for coordinator synthesis after returning its handle', async () => {
  let finish!: (result: unknown) => void;
  const finished = new Promise(resolve => { finish = resolve; });
  const registerPendingChild = vi.fn();
  const createAndRunPipeline = vi.fn(async (_title, _template, _description, _context, options) => {
    await Promise.resolve(); options.onCreated('pipeline'); return finished;
  });
  const create = createMetaTools({ createAndRunPipeline } as never, {
    swarmRefs: { detachHookRef: { current: { registerPendingChild, pendingDetachedCount: () => 0 } }, workerRef: { current: null } },
  }).find(tool => tool.name === 'create_pipeline')!;
  await create.execute({ title: 'Build', templateName: 'Build', description: 'Implement' }, context);
  expect(registerPendingChild).toHaveBeenCalledOnce();
  fixture.find.mockResolvedValue({ status: 'completed' });
  finish({ pipelineId: 'pipeline', result: 'Verified all items' });
  expect(await registerPendingChild.mock.calls[0][0].promise).toMatchObject({
    status: 'ok', output: 'Verified all items',
  });
});

describe('a stage parked on an approval (#24)', () => {
  const pendingApproval = { requestId: 'request', stage: 'QA', nodeKey: 'qa', itemId: 'i2', item: 'remaining item',
    toolId: 'cli-native:Bash', action: 'Bash', toolName: 'Bash', subject: 'docker compose build', reason: 'Approval was not received within 5 minutes.' };
  beforeEach(() => {
    fixture.find.mockResolvedValue({ id: 'pipeline', userId: 'owner', sessionId: 'session', workspaceId: 'workspace', status: 'awaiting_approval', metadata: { pendingApproval } });
  });
  it('reports what it waits on in get_pipeline_status', async () => {
    expect(await tool('get_pipeline_status').execute({ id: 'pipeline' }, context)).toMatchObject({
      status: 'awaiting_approval', pendingApproval: { requestId: 'request', stage: 'QA', item: 'remaining item', subject: 'docker compose build' },
    });
  });
  it('does not fabricate a denial after an unanswered prompt', async () => {
    fixture.ask.mockResolvedValue({ approved: false, reason: 'Approval timed out' });
    await expect(tool('answer_pipeline_approval').execute({ id: 'pipeline' }, context)).resolves.toMatchObject({ decided: false, status: 'awaiting_approval' });
    expect(fixture.deny).not.toHaveBeenCalled();
    expect(fixture.approve).not.toHaveBeenCalled();
    expect(fixture.ask.mock.calls[0][2].metadata.approvalTimeoutMs).toBe(300_000);
  });
  it('answer_pipeline_approval forwards the question; only the user answer resolves the request', async () => {
    fixture.ask.mockResolvedValue({ approved: true, response: 'Approve' });
    fixture.approve.mockResolvedValue(true);
    expect(await tool('answer_pipeline_approval').execute({ id: 'pipeline' }, context)).toMatchObject({ approved: true, stage: 'QA' });
    expect(fixture.ask.mock.calls[0][0]).toContain('docker compose build');
    expect(fixture.approve).toHaveBeenCalledWith('request', 'owner', expect.any(String));
    fixture.ask.mockResolvedValue({ approved: true, response: 'Deny' });
    expect(await tool('answer_pipeline_approval').execute({ id: 'pipeline' }, context)).toMatchObject({ approved: false });
    expect(fixture.deny).toHaveBeenCalledWith('request', 'owner', expect.any(String));
    expect(fixture.resume).not.toHaveBeenCalled();
  });
  it('after a restart, approving grants the blocked call to the blocked attempt and resumes that attempt', async () => {
    const parked = { ...pendingApproval, attemptId: 'attempt-1', fingerprint: 'f'.repeat(64), hostServices: false, workerRequestId: 'worker-request' };
    // The boot sweep paused the run; the request row is still pending, so settling it succeeds.
    fixture.find.mockResolvedValue({ id: 'pipeline', userId: 'owner', sessionId: 'session', workspaceId: 'workspace', status: 'paused', metadata: { pendingApproval: parked } });
    fixture.checkpoints.mockResolvedValue([{ seq: 9, nodeKey: 'qa', state: { attemptId: 'attempt-2' } }, { seq: 7, nodeKey: 'qa', state: { attemptId: 'attempt-1' } }]);
    fixture.ask.mockResolvedValue({ approved: true, response: 'Approve' });
    fixture.approve.mockResolvedValue(true);
    fixture.resume.mockImplementation((_id, options) => { options.onResumed(); return new Promise(() => {}); });
    await tool('answer_pipeline_approval').execute({ id: 'pipeline' }, context);
    expect(fixture.updatePipeline).toHaveBeenCalledWith('pipeline', { metadata: { approvedCalls: [{
      toolId: 'cli-native:Bash', toolName: 'Bash', action: 'Bash', fingerprint: parked.fingerprint, nodeKey: 'qa', attemptId: 'attempt-1', hostServices: false,
    }] } });
    expect(fixture.resume).toHaveBeenCalledWith('pipeline', expect.objectContaining({ fromSeq: 7 }));
  });
});

it('resume_pipeline marks items already delivered as skipped, with evidence (#23)', async () => {
  fixture.items.mockResolvedValue([{ id: 'i1', title: 'done item', status: 'done' }, { id: 'i2', title: 'fixed earlier', status: 'pending' }]);
  fixture.resume.mockImplementation((_id, options) => { options.onResumed(); return new Promise(() => {}); });
  await expect(tool('resume_pipeline').execute({ id: 'pipeline', skipItems: ['i2'] }, context)).rejects.toThrow('evidence');
  await tool('resume_pipeline').execute({ id: 'pipeline', skipItems: ['i2'], evidence: 'bc453de, npm test exit 0' }, context);
  expect(fixture.updateItem).toHaveBeenCalledWith('i2', { status: 'skipped', result: expect.stringContaining('bc453de') });
  fixture.updateItem.mockClear();
  await expect(tool('resume_pipeline').execute({ id: 'pipeline', skipItems: ['i2', 'nope'], evidence: 'bc453de' }, context)).rejects.toThrow("'nope'");
  expect(fixture.updateItem).not.toHaveBeenCalled();
});
