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
    }, context) as Awaited<ReturnType<typeof workPlanRepository.read>>;
    expect(published.current).toMatchObject({ kind: 'proposal', steps: implementation });

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
