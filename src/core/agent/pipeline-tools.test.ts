import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import { createPipelineRecoveryTools } from './pipeline-tools';
import { createMetaTools } from './meta-tools';
const fixture = vi.hoisted(() => ({
  find: vi.fn(), nodes: vi.fn(), items: vi.fn(), checkpoints: vi.fn(), resume: vi.fn(),
}));
vi.mock('@/db/repositories/pipeline-repository', () => ({ pipelineRepository: {
  findById: fixture.find, getNodes: fixture.nodes, getPlanItems: fixture.items, getCheckpoints: fixture.checkpoints,
} }));
vi.mock('./pipeline-manager', () => ({ getPipelineManager: () => ({ resume: fixture.resume }) }));
vi.mock('./templates', () => ({ listAvailableTemplates: async () => [{ id: 'template', name: 'Build' }] }));
const context = { userId: 'owner', sessionId: 'session', workspaceId: 'workspace' } as AgentContext;
const tool = (name: string) => createPipelineRecoveryTools().find(tool => tool.name === name)!;
beforeEach(() => {
  vi.resetAllMocks();
  fixture.find.mockResolvedValue({ id: 'pipeline', userId: 'owner', sessionId: 'session', workspaceId: 'workspace', status: 'failed' });
  fixture.nodes.mockResolvedValue([{ nodeKey: 'qa', name: 'QA', status: 'failed', output: 'Checks failed\n```handoff\n{}\n```' }]);
  fixture.items.mockResolvedValue([{ title: 'done item', status: 'done' }, { title: 'remaining item', status: 'running' }]);
  fixture.checkpoints.mockResolvedValue([{ seq: 4, nodeKey: 'qa' }, { seq: 3, nodeKey: 'implementation' }]);
});
describe('pipeline recovery tools', () => {
  it('reports remaining work and strips internal handoffs', async () => {
    const result = await tool('get_pipeline_status').execute({ id: 'pipeline' }, context);
    expect(result).toMatchObject({ remainingItems: ['remaining item'], stages: [{ output: 'Checks failed' }] });
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
    status: 'ok', output: { result: 'Verified all items' },
  });
});
