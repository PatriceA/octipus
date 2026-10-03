import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Elysia } from '@/api/http';
import { workPlanRepository } from '@/db/repositories/work-plan-repository';
import { createMetaTools } from '@/core/agent/meta-tools';
import { togglePlanMode } from '@/core/agent/plan-mode';
import { createWorkPlanTools } from '@/core/agent/work-plan-tools';
import type { AgentContext } from '@/core/types';
const alice = randomUUID(); const bob = randomUUID(); const sid = randomUUID();
const planSid = randomUUID(); const draftSid = randomUUID();
let app: { handle: (request: Request) => Promise<Response> };
beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-work-plan-'));
  process.env.MASTER_KEY ??= randomUUID(); process.env.JWT_SECRET ??= randomUUID(); process.env.SESSION_SECRET ??= randomUUID();
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate'); await runMigrations();
  await executeRaw(`INSERT INTO users (id, username) VALUES ('${alice}', 'plan-alice'), ('${bob}', 'plan-bob')`);
  await executeRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id, metadata) VALUES ('${sid}', '${alice}', 'webchat', 'plan', '{"keep":true}'), ('${planSid}', '${alice}', 'webchat', 'proposal', '{}'), ('${draftSid}', '${alice}', 'webchat', 'plan-only', '{}')`);
  await executeRaw(`UPDATE sessions SET context = '{"planMode":true}' WHERE id = '${planSid}'`);
  const { sessionRoutes } = await import('./sessions');
  const { principalFromUser } = await import('@/security/principal');
  app = new Elysia().derive(({ request }) => {
    const user = { id: request.headers.get('x-test-user') || alice, username: 'test', isAdmin: false };
    return { user, session: null, principal: principalFromUser(user) };
  }).group('/api', a => a.use(sessionRoutes));
});
afterAll(async () => { const { closeDb } = await import('@/db/postgres'); await closeDb(); });
const request = (method: string, path: string, body?: unknown, user = alice) => app.handle(new Request(`http://localhost/api/sessions/${sid}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: body === undefined ? undefined : JSON.stringify(body) }));
describe('plan API and agent handoff', () => {
  it('publishes with the real tool, reloads, accepts feedback, and rejects stale writes', async () => {
    const tool = createWorkPlanTools().find(t => t.name === 'update_work_plan')!;
    const context = { sessionId: sid, userId: alice } as AgentContext;
    await tool.execute({ revision: 0, title: 'Research', goal: 'Compare sources', summary: 'Initial plan', steps: [{ id: 'read', title: 'Read sources', status: 'working', evidence: '' }] }, context);
    const loaded = await (await request('GET', '/plan')).json();
    expect(loaded.current.title).toBe('Research');
    const feedback = await request('POST', '/plan/feedback', { planId: loaded.current.id, revision: 1, text: 'Include primary sources' });
    expect(feedback.status).toBe(200);
    const updated = await feedback.json();
    expect(updated.current.feedback[0].status).toBe('pending');
    expect((await request('POST', '/plan/feedback', { planId: loaded.current.id, revision: 1, text: 'stale' })).status).toBe(409);
    await expect(tool.execute({ revision: 1, title: 'Research', goal: 'Compare', summary: 'stale', steps: [{ id: 'read', title: 'Read sources', status: 'done' }] }, context)).rejects.toThrow('Plan changed');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    expect((await sessionRepository.findById(sid))!.metadata!.keep).toBe(true);
  });
  it('publishes pipeline items without a worker needing root plan tools and persists progress', async () => {
    const { executeRaw } = await import('@/db/postgres');
    const pipelineSid = randomUUID();
    await executeRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id, metadata) VALUES ('${pipelineSid}', '${alice}', 'webchat', 'pipeline-plan', '{"keep":true}')`);
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId: pipelineSid, userId: alice, title: 'Implement feature', type: 'development' });
    const [item] = await pipelineRepository.addPlanItems([{ pipelineId: pipeline.id, ordinal: 0, title: 'Implement endpoint' }]);
    const read = async () => {
      const response = await app.handle(new Request(`http://localhost/api/sessions/${pipelineSid}/plan`, { headers: { 'x-test-user': alice } }));
      expect(response.status).toBe(200);
      return response.json();
    };
    expect((await read()).current.steps[0]).toMatchObject({ id: item.id, status: 'pending' });
    await pipelineRepository.updatePlanItem(item.id, { status: 'running' });
    expect((await read()).current.steps[0].status).toBe('working');
    // Exercise the same status-write path used by the worker-failure catch.
    // The manager does not mutate the active plan item when a worker throws.
    const { PipelineManager } = await import('@/core/agent/pipeline-manager');
    const manager = new PipelineManager();
    await (manager as any).updatePipeline(pipeline.id, { status: 'failed', summary: 'QA could not run tests' });
    expect((await read()).current.steps[0]).toMatchObject({ status: 'blocked', evidence: 'QA could not run tests' });
    expect((await pipelineRepository.getPlanItems(pipeline.id))[0].status).toBe('running');
    await (manager as any).updatePipeline(pipeline.id, { status: 'running' });
    expect((await read()).current.steps[0].status).toBe('working');
    await pipelineRepository.updatePlanItem(item.id, { status: 'done', result: 'Tests passed' });
    await (manager as any).updatePipeline(pipeline.id, { status: 'completed' });
    const second = await pipelineRepository.create({ rootAgentId: 'root', sessionId: pipelineSid, userId: alice,
      title: 'Next feature', type: 'development', createdAt: new Date(pipeline.createdAt.getTime() + 1000) });
    const [secondItem] = await pipelineRepository.addPlanItems([{ pipelineId: second.id, ordinal: 0, title: 'Implement next feature' }]);
    expect((await read()).current.sourcePipelineId).toBe(second.id);
    expect((await read()).previous[0].steps[0]).toMatchObject({ id: item.id, status: 'done' });
    const state = await workPlanRepository.read(pipelineSid, alice);
    const update = createWorkPlanTools().find(tool => tool.name === 'update_work_plan')!;
    await update.execute({ revision: state.revision, title: 'Coordinator revision', goal: 'Also release', summary: 'Follow-up',
      steps: [...state.current!.steps, { id: 'release', title: 'Release check', status: 'pending', evidence: '' }],
    }, { sessionId: pipelineSid, userId: alice } as AgentContext);
    await pipelineRepository.updatePlanItem(secondItem.id, { status: 'running' });
    expect((await read()).current.title).toBe('Coordinator revision');
    expect((await read()).current.steps.map((step: { id: string }) => step.id)).toContain('release');
  });

  it('isolates other users on both routes and repository calls', async () => {
    expect((await request('GET', '/plan', undefined, bob)).status).toBe(404);
    expect((await request('POST', '/plan/feedback', { planId: 'unknown', revision: 2, text: 'other user' }, bob)).status).toBe(404);
    await expect(workPlanRepository.read(sid, bob)).rejects.toThrow('Session not found');
  });
  it('allows only one concurrent write at the same revision', async () => {
    const state = await workPlanRepository.read(sid, alice);
    const next = { ...state, revision: state.revision + 1 };
    const outcomes = await Promise.allSettled([workPlanRepository.save(sid, alice, state.revision, next), workPlanRepository.save(sid, alice, state.revision, next)]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
  });

  it('stores a plan-mode submission as pending implementation with full details', async () => {
    const update = createWorkPlanTools().find(t => t.name === 'update_work_plan')!;
    const context = { sessionId: planSid, userId: alice } as AgentContext;
    const implementation = [{
      id: 'api', title: 'Implement the API boundary', status: 'pending', evidence: '',
    }];
    await expect(update.execute({
      revision: 0, kind: 'proposal', title: 'Mobile platform', goal: 'Build the application',
      summary: 'Finished drafting', steps: [{
        id: 'design', title: 'Write the architecture plan', status: 'done', evidence: 'Plan written',
      }],
    }, context)).rejects.toThrow(/future implementation steps with pending status/i);

    const published = await update.execute({
      revision: 0, kind: 'execution', title: 'Mobile platform', goal: 'Build the application',
      summary: 'Published future implementation', steps: implementation,
    }, context);
    expect(published).toMatchObject({ kind: 'proposal', revision: 1, changedSteps: [{ id: 'api', status: 'pending' }] });

    const exit = createMetaTools({} as never).find(t => t.name === 'exit_plan_mode')!;
    const details = '# Mobile platform\n\n## API boundary\nImplement and validate the API.';
    const result = await exit.execute({ plan: details }, context) as Record<string, unknown>;
    expect(result).toMatchObject({ submitted: true, revision: 2 });
    expect(result.note).toMatch(/does not approve this plan or start implementation/i);

    const durable = await workPlanRepository.read(planSid, alice);
    expect(durable.current).toMatchObject({
      kind: 'proposal', details, steps: implementation,
    });
    expect(durable.current!.steps.every(step => step.status === 'pending')).toBe(true);
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    expect(((await sessionRepository.findById(planSid))!.context as Record<string, unknown>).planMode).toBe(true);
    const off = await togglePlanMode(planSid, 'off');
    expect(off.text).toMatch(/does not approve the current plan or start implementation/i);
    expect(((await sessionRepository.findById(planSid))!.context as Record<string, unknown>).planMode).toBe(false);
  });

  it('keeps a plan-only deliverable pending and requires its durable artifact', async () => {
    const update = createWorkPlanTools().find(t => t.name === 'update_work_plan')!;
    const context = { sessionId: draftSid, userId: alice } as AgentContext;
    const base = {
      revision: 0, kind: 'proposal', title: 'Mobile platform', goal: 'Build the application',
      summary: 'Created implementation proposal',
    };
    await expect(update.execute({
      ...base, steps: [{ id: 'plan', title: 'Write the plan', status: 'done', evidence: 'Written' }],
    }, context)).rejects.toThrow(/future implementation steps with pending status/i);
    await expect(update.execute({
      ...base, steps: [{ id: 'api', title: 'Implement the API', status: 'pending', evidence: '' }],
    }, context)).rejects.toThrow(/complete markdown artifact/i);
    await update.execute({
      ...base,
      details: '# Mobile platform\n\nImplement the API and application clients.',
      steps: [{ id: 'api', title: 'Implement the API', status: 'pending', evidence: '' }],
    }, context);
    const durable = await workPlanRepository.read(draftSid, alice);
    expect(durable.current).toMatchObject({ kind: 'proposal', revision: 1 });
    expect(durable.current!.details).toContain('Implement the API');
    expect(durable.current!.steps[0].status).toBe('pending');
  });

  it('patches through the real tool with a small receipt and preserves plan-mode restrictions', async () => {
    const update = createWorkPlanTools().find(t => t.name === 'update_work_plan')!;
    const context = { sessionId: draftSid, userId: alice } as AgentContext;
    const current = await workPlanRepository.read(draftSid, alice);
    const receipt = await update.execute({ revision: current.revision, summary: 'Clarify API',
      stepUpdates: [{ id: 'api', evidence: 'Specification clarified' }],
    }, context);
    expect(receipt).toMatchObject({ revision: current.revision + 1, kind: 'proposal', changedSteps: [{ id: 'api' }] });
    expect(JSON.stringify(receipt)).not.toContain('Specification clarified');
    const stored = await workPlanRepository.read(draftSid, alice);
    expect(stored.current!.details).toBe(current.current!.details);
    expect(stored.current!.steps[0].evidence).toBe('Specification clarified');
    await expect(update.execute({ revision: stored.revision, summary: 'Invalid progress',
      stepUpdates: [{ id: 'api', status: 'done' }],
    }, context)).rejects.toThrow(/future implementation steps with pending status/i);
  });
});

it('gateway commands show the same plan and persist terminal feedback', async () => {
  const { CommandRegistry, registerBuiltinCommands } = await import('@/core/gateway/commands');
  const registry = new CommandRegistry(); registerBuiltinCommands(registry);
  const ctx = { userId: alice, sessionId: sid, trustLevel: 'user' as const, clientType: 'tui' };
  const plan = await registry.execute('/work-plan', ctx);
  expect(plan?.text).toContain('Research');
  expect(plan?.text).toContain('Include primary sources');
  expect((await registry.execute('/plan-feedback', ctx))?.text).toContain('1–2000 characters');
  expect((await registry.execute('/plan-feedback Include dates', ctx))?.text).toContain('saved as pending');
  expect((await registry.execute('/work-plan-status', ctx))?.text).toMatch(/^Execution · Research · revision \d+ · 0\/1 steps done/);
  expect((await registry.execute('/work-plan-status', { ...ctx, sessionId: undefined }))?.text).toBe('');
  expect((await workPlanRepository.read(sid, alice)).current!.feedback.some(f => f.text === 'Include dates')).toBe(true);
  expect((await registry.execute('/work-plan', { ...ctx, userId: bob }))?.text).not.toContain('Research');
});


describe('durable learning checks', () => {
  it('queues execution milestones atomically, coalesces final completion, and scopes receipts', async () => {
    const { executeRaw } = await import('@/db/postgres');
    const learnSid = randomUUID();
    await executeRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id) VALUES ('${learnSid}', '${alice}', 'webchat', 'learn')`);
    const tool = createWorkPlanTools().find(t => t.name === 'update_work_plan')!;
    const context = { sessionId: learnSid, userId: alice } as AgentContext;
    await tool.execute({ revision: 0, title: 'Fix', goal: 'Repair', summary: 'Start', steps: [
      { id: 'a', title: 'Diagnose', status: 'working', evidence: '' }, { id: 'b', title: 'Verify', status: 'pending', evidence: '' },
    ] }, context);
    const view = async (owner = alice) => app.handle(new Request(`http://localhost/api/sessions/${learnSid}/learning`, { headers: { 'x-test-user': owner } }));
    expect((await (await view()).json()).checks).toHaveLength(0);
    await tool.execute({ revision: 1, summary: 'Diagnosed', stepUpdates: [{ id: 'a', status: 'done', evidence: 'Reproduced failure' }] }, context);
    expect((await (await view()).json()).checks).toHaveLength(1);
    await expect(tool.execute({ revision: 1, summary: 'Stale', stepUpdates: [{ id: 'b', status: 'done' }] }, context)).rejects.toThrow();
    expect((await (await view()).json()).checks).toHaveLength(1);
    await tool.execute({ revision: 2, summary: 'Verified', stepUpdates: [{ id: 'b', status: 'done', evidence: 'Tests pass' }] }, context);
    expect((await (await view()).json()).checks).toHaveLength(2);
    expect((await view(bob)).status).toBe(404);
    const { backgroundJobRepository } = await import('@/db/repositories/background-job-repository');
    const jobs = (await backgroundJobRepository.recentForUser(alice)).filter(j => j.payload.sessionId === learnSid);
    expect(jobs.map(j => j.payload.trigger)).toEqual(['plan_completed', 'steps_completed']);
    expect(jobs.every(j => j.status === 'queued')).toBe(true);
    const manual = (owner = alice) => app.handle(new Request(`http://localhost/api/sessions/${learnSid}/learning`, { method: 'POST', headers: { 'x-test-user': owner } }));
    expect((await manual(bob)).status).toBe(404);
    expect((await manual()).status).toBe(202);
    expect((await (await view()).json()).checks).toHaveLength(2); // Reuses pending work instead of charging twice.
    const { gatherEvidence } = await import('@/core/learning/evidence');
    const { agentEventRepository } = await import('@/db/repositories/agent-event-repository');
    await agentEventRepository.create({ sessionId: learnSid, agentId: 'test', userId: alice, type: 'action', data: { type: 'cli_tool_result', output: 'Observed failure then correction' } });
    await agentEventRepository.create({ sessionId: learnSid, agentId: 'test', userId: bob, type: 'action', data: { type: 'cli_tool_result', output: 'Foreign evidence' } });
    const evidence = await gatherEvidence(alice, learnSid, new Date());
    expect(evidence.some(row => row.kind === 'execution' && row.text.includes('Observed failure'))).toBe(true);
    expect(evidence.some(row => row.text.includes('Foreign evidence'))).toBe(false);
    const { enqueueTurnLearning } = await import('@/core/learning/queue');
    await enqueueTurnLearning(learnSid, alice, 'turn-after-step', new Date(0));
    expect((await (await view()).json()).checks).toHaveLength(2);
    for (let i = 0; i < 6; i++) await agentEventRepository.create({ sessionId: learnSid, agentId: 'test', userId: alice,
      type: 'action', data: { type: 'cli_tool_result', output: `Verified additional work ${i}` } });
    await enqueueTurnLearning(learnSid, alice, 'turn-after-step', new Date(0));
    expect((await (await view()).json()).checks).toHaveLength(3);
    await enqueueTurnLearning(learnSid, alice, 'turn-after-step', new Date(0));
    expect((await (await view()).json()).checks).toHaveLength(3);
  });
});
