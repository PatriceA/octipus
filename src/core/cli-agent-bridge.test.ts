import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIAgentWorker } from './cli-agent-worker';
import { createWorkPlanTools } from './agent/work-plan-tools';
import type { AgentContext } from './types';
import { addPlanFeedback, type WorkPlanState } from '@/shared/work-plan';

const fixture = vi.hoisted(() => ({ script: '', dir: '', plan: { revision: 0, current: null, previous: [] } as WorkPlanState,
  check: vi.fn(), execute: vi.fn(), cancel: vi.fn(), readFailure: false, audit: vi.fn(), status: vi.fn() }));
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: (binary: string, args: string[], opts: object) => {
    if (process.env.OCTIPUS_LIVE_CLI) return actual.spawn(binary, args, opts);
    if (binary !== 'claude') throw new Error(`Unexpected paid CLI invocation: ${binary}`);
    return actual.spawn(process.execPath, [fixture.script, ...args], opts);
  } };
});
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModel: async () => ({ metadata: {} }),
  getModelByModelId: async () => ({ supportsVision: false }) }) }));
vi.mock('@/models/quota-tracker', () => ({ getQuotaTracker: () => ({ getStatus: async () => ({ exhausted: false }) }) }));
vi.mock('@/core/agent-task-recorder', () => ({ recordAgentCompletion: async () => {} }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: {
  findById: async () => ({ id: 's', userId: 'u', context: { devMode: true, projectPath: fixture.dir, planMode: false } }),
  incrementMessageCount: async () => {},
} }));
vi.mock('@/db/repositories/work-plan-repository', () => ({ workPlanRepository: {
  read: async (sessionId: string, userId: string) => {
    if (fixture.readFailure) { fixture.readFailure = false; throw new Error('Context database unavailable'); }
    if (sessionId !== 's' || userId !== 'u') throw new Error('Wrong plan owner');
    return structuredClone(fixture.plan);
  },
  save: async (sessionId: string, userId: string, revision: number, next: WorkPlanState) => {
    if (sessionId !== 's' || userId !== 'u' || revision !== fixture.plan.revision) throw new Error('Plan conflict');
    fixture.plan = structuredClone(next);
  },
} }));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: { create: async () => ({}), findBySession: async () => [] } }));
vi.mock('@/db/repositories/agent-repository', () => ({ agentRepository: { updateStatus: fixture.status } }));
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: new Proxy({}, { get: (_target, property) => property === 'logAgentCompleted' ? fixture.audit : async () => {} }) }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: fixture.check, cancelWaits: fixture.cancel,
  requestApproval: async () => 'approval', waitForApproval: async () => false, onWaitStateChange: () => () => {} }) }));
vi.mock('@/hooks/manager', () => ({ getHookManager: () => ({ triggerToolHooks: async () => ({ decision: 'allow' }) }) }));

beforeEach(() => {
  fixture.dir = mkdtempSync(join(tmpdir(), 'octipus-cli-workflow-'));
  fixture.script = join(fixture.dir, 'fake-claude.mjs');
  fixture.plan = { revision: 0, current: null, previous: [] };
  fixture.check.mockReset().mockImplementation(async (_user: string, tool: string) => ({ level: tool === 'denied' ? 'DENY' : 'ALLOW' }));
  fixture.execute.mockReset();
  fixture.readFailure = false;
  fixture.audit.mockReset().mockResolvedValue(undefined);
  fixture.status.mockReset().mockResolvedValue(undefined);
  writeFileSync(fixture.script, `
    import { readFileSync } from 'node:fs';
    const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8'));
    if (config.mcpServers.octipus.env.OCTIPUS_API_KEY) throw new Error('Admin credential leaked');
    if (config.mcpServers.octipus.env.OCTIPUS_AGENT_KEY !== process.env.OCTIPUS_AGENT_KEY) throw new Error('Wrong capability');
    const call = async (name, args = {}) => {
      const r = await fetch(process.env.OCTIPUS_AGENT_URL + '/call', {method:'POST', headers: {Authorization:'Bearer ' + process.env.OCTIPUS_AGENT_KEY}, body: JSON.stringify({name, arguments:args})});
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    };
    const initial = await call('get_work_plan');
    await call('update_work_plan', {revision:0,title:'Sample',goal:'Check scoped tools',summary:'Start',steps:[{id:'one',title:'Check context',status:'pending',evidence:''}]});
    const write = await call('filesystem__write_file', {path:'sample.txt',content:'ok'});
    const denied = await call('denied__write', {});
    const plan = await call('get_work_plan');
    const current = JSON.parse(plan.content[0].text);
    const feedback = current.current.feedback;
    await call('update_work_plan', {revision:current.revision,title:'Sample',goal:'Check scoped tools',summary:'Done',steps:[{id:'one',title:'Check context',status:'done',evidence:'Observed sample write'}],feedbackResponses:feedback.map(f=>({id:f.id,status:'applied',response:'Checked guidance'}))});
    const final = await call('get_cli_run_context');
    console.log(JSON.stringify({type:'result',subtype:'success',result:JSON.stringify({initial,write,denied,final}),num_turns:1}));
  `);
});
afterEach(() => rmSync(fixture.dir, { recursive: true, force: true }));

describe.skipIf(!!process.env.OCTIPUS_LIVE_CLI)('CLI worker with actual subprocess and run bridge', () => {
  it('uses original identity, updates plans, delivers feedback/guidance, and enforces denial', async () => {
    const context: AgentContext = { id: 'a', sessionId: 's', userId: 'u', workspaceId: 'w', root: true,
      model: 'cli/claude-code', role: 'general', topic: 'general', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {} };
    const worker = new CLIAgentWorker(context, { maxIterations: 5, maxTokenBudget: 10000, timeout: 10000, contextWindowSize: 10000 });
    worker.registerTools(createWorkPlanTools());
    worker.registerTool({ name: 'filesystem__write_file', toolId: 'filesystem', permissionAction: 'write', description: '', parameters: { type: 'object' },
      execute: async (args, ctx) => {
        fixture.execute(ctx);
        fixture.plan = addPlanFeedback(fixture.plan, fixture.plan.current!.id, fixture.plan.revision, 'Check the labels too');
        worker.steer({ role: 'user', content: 'Also explain your check', timestamp: new Date() });
        return { path: join(fixture.dir, String(args.path)) };
      } });
    const denied = vi.fn();
    worker.registerTool({ name: 'denied__write', toolId: 'denied', description: '', parameters: { type: 'object' }, execute: denied });
    const result = JSON.parse(await worker.run('Run the sample'));
    expect(fixture.execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', userId: 'u', sessionId: 's', workspaceId: 'w' }));
    expect(denied).not.toHaveBeenCalled();
    expect(result.denied.isError).toBe(true);
    expect(JSON.stringify(result.write)).toContain('Also explain your check');
    expect(fixture.plan.current?.feedback[0].status).toBe('applied');
    expect(JSON.stringify(result.final)).toContain('Check the labels too');
    expect(worker.getSideEffectCounters()).toMatchObject({ filesChanged: 1, permissionDenials: 1 });
    expect(worker.getStatus()).toBe('completed');
    worker.stop();
    expect(worker.getStatus()).toBe('completed');
  });
});


it.runIf(!!process.env.OCTIPUS_LIVE_CLI)('live CLI login can use scoped tools and publish a completed plan', async () => {
  const provider = process.env.OCTIPUS_LIVE_CLI!;
  const worker = new CLIAgentWorker({ id: 'live-cli-check', sessionId: 's', userId: 'u', workspaceId: 'w', root: true,
    model: `cli/${provider}`, role: 'general', topic: 'general', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    { maxIterations: 12, maxTokenBudget: 500000, timeout: 180000, contextWindowSize: 100000 });
  worker.registerTools(createWorkPlanTools());
  worker.registerTool({ name: 'sample_context', description: 'Return the scoped test identity and sample sum; use for this test.', parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => { fixture.execute(ctx); return { sum: 10, sessionId: ctx.sessionId, userId: ctx.userId }; } });
  const liveEvents: unknown[] = [];
  worker.onEvent(event => liveEvents.push(event));
  const result = await worker.run('This is an isolated integration check with sample data only. Use the Octipus bridge tools: get_work_plan, publish a one-step pending plan with update_work_plan, call sample_context, then mark the step done with evidence that the returned sum is 10. Read get_cli_run_context and respond with the sum. Do not use files, other MCP servers, network, external services, or delegate.');
  writeFileSync(`/tmp/octipus-cli-live-${provider}.json`, JSON.stringify({ result, events: liveEvents }, null, 2), { mode: 0o600 });
  expect(fixture.execute, `CLI final response: ${result}`).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', sessionId: 's' }));
  expect(fixture.plan.current?.steps[0].status).toBe('done');
  expect(result).toContain('10');
}, 200000);

it.skipIf(!!process.env.OCTIPUS_LIVE_CLI)('cancellation ends the subprocess and emits one stopped terminal', async () => {
  writeFileSync(fixture.script, `console.log(JSON.stringify({type:'system',subtype:'init'})); setInterval(()=>{},1000);`);
  const worker = new CLIAgentWorker({ id: 'a', sessionId: 's', userId: 'u', root: true, model: 'cli/claude-code', role: 'general', topic: '', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    { maxIterations: 5, maxTokenBudget: 10000, timeout: 10000, contextWindowSize: 10000 });
  const terminal: string[] = [];
  worker.onEvent(event => {
    if (event.type === 'status_change') terminal.push((event.data as { status: string }).status);
    if (event.type === 'thought' && (event.data as { status?: string }).status === 'running') worker.stop();
  });
  await expect(worker.run('sample')).rejects.toThrow('aborted');
  expect(worker.getStatus()).toBe('stopped');
  expect(worker.getAbortSignal().aborted).toBe(true);
  expect(terminal.filter(s => s === 'stopped')).toHaveLength(1);
  expect(terminal).not.toContain('failed');
});

it.skipIf(!!process.env.OCTIPUS_LIVE_CLI)('already-cancelled parent prevents any CLI execution', async () => {
  const controller = new AbortController(); controller.abort();
  fixture.script = '/does/not/exist';
  const worker = new CLIAgentWorker({ id: 'a', sessionId: 's', userId: 'u', model: 'cli/claude-code', role: 'general', topic: '', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    { maxIterations: 5, maxTokenBudget: 10000, timeout: 10000, contextWindowSize: 10000 }, { parentSignal: controller.signal });
  await expect(worker.run('sample')).rejects.toThrow('aborted before starting');
  expect(fixture.status).toHaveBeenCalledWith('a', expect.objectContaining({ status: 'stopped' }));
});

function sampleWorker(): CLIAgentWorker {
  return new CLIAgentWorker({ id: 'a', sessionId: 's', userId: 'u', model: 'cli/claude-code', role: 'general', topic: '', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    { maxIterations: 5, maxTokenBudget: 10000, timeout: 10000, contextWindowSize: 10000 });
}

it.skipIf(!!process.env.OCTIPUS_LIVE_CLI)('final tool failure terminates the CLI even if it would ignore the MCP error', async () => {
  writeFileSync(fixture.script, `
    await fetch(process.env.OCTIPUS_AGENT_URL + '/call', {method:'POST', headers:{Authorization:'Bearer '+process.env.OCTIPUS_AGENT_KEY},body:JSON.stringify({name:'final_sample',arguments:{}})}).catch(()=>{});
    console.log(JSON.stringify({type:'result',subtype:'success',result:'Ignored failure',num_turns:1}));
  `);
  const worker = sampleWorker();
  worker.registerTool({ name: 'final_sample', description: '', parameters: {type:'object'}, final: true,
    execute: async () => { throw new Error('Final operation failed'); } });
  await expect(worker.run('sample')).rejects.toThrow('Final operation failed');
  expect(worker.getStatus()).toBe('failed');
});

it.skipIf(!!process.env.OCTIPUS_LIVE_CLI)('a context refresh failure preserves an already successful tool result', async () => {
  writeFileSync(fixture.script, `
    const r = await fetch(process.env.OCTIPUS_AGENT_URL + '/call', {method:'POST', headers:{Authorization:'Bearer '+process.env.OCTIPUS_AGENT_KEY},body:JSON.stringify({name:'sample_write',arguments:{}})});
    const result = await r.json();
    console.log(JSON.stringify({type:'result',subtype:'success',result:JSON.stringify(result),num_turns:1}));
  `);
  const worker = sampleWorker();
  worker.registerTool({ name:'sample_write',description:'',parameters:{type:'object'},execute:async()=>{
    fixture.readFailure = true; fixture.execute(); return {written:true};
  }});
  const result = JSON.parse(await worker.run('sample'));
  expect(result.isError).toBe(false);
  expect(result.content[0].text).toContain('"written":true');
  expect(fixture.execute).toHaveBeenCalledTimes(1);
});

it.skipIf(!!process.env.OCTIPUS_LIVE_CLI)('audit outage does not contradict successful completion', async () => {
  writeFileSync(fixture.script, `console.log(JSON.stringify({type:'result',subtype:'success',result:'done',num_turns:1}));`);
  fixture.audit.mockRejectedValue(new Error('Audit unavailable'));
  const worker = sampleWorker();
  await expect(worker.run('sample')).resolves.toBe('done');
  expect(worker.getStatus()).toBe('completed');
});


it.skipIf(!!process.env.OCTIPUS_LIVE_CLI)('ungranted approval terminates the CLI without executing the handler', async () => {
  writeFileSync(fixture.script, `
    await fetch(process.env.OCTIPUS_AGENT_URL + '/call', {method:'POST', headers:{Authorization:'Bearer '+process.env.OCTIPUS_AGENT_KEY},body:JSON.stringify({name:'approval_sample',arguments:{}})}).catch(()=>{});
    console.log(JSON.stringify({type:'result',subtype:'success',result:'Ignored denial',num_turns:1}));
  `);
  const worker = sampleWorker();
  worker.getContext().attended = true;
  worker.getContext().root = true;
  fixture.check.mockResolvedValue({level:'ASK'});
  worker.registerTool({ name:'approval_sample',toolId:'sample',description:'',parameters:{type:'object'},execute:fixture.execute });
  await expect(worker.run('sample')).rejects.toThrow('approval was not granted');
  expect(fixture.execute).not.toHaveBeenCalled();
  expect(worker.getStatus()).toBe('failed');
});

const lateGuidanceScript = `
  const r = await fetch(process.env.OCTIPUS_AGENT_URL + '/call', {method:'POST', headers:{Authorization:'Bearer '+process.env.OCTIPUS_AGENT_KEY},body:JSON.stringify({name:'sample_write',arguments:{}})});
  const result = await r.json();
  await new Promise(resolve => setTimeout(resolve, 400));
  console.log(JSON.stringify({type:'result',subtype:'success',result:JSON.stringify(result),num_turns:1}));
`;

it.skipIf(!!process.env.OCTIPUS_LIVE_CLI)('guidance after the last bridge call gets a bounded follow-up turn', async () => {
  writeFileSync(fixture.script, lateGuidanceScript);
  const worker = sampleWorker();
  let steered = false;
  worker.registerTool({ name: 'sample_write', description: '', parameters: { type: 'object' }, execute: async () => {
    fixture.execute();
    if (!steered) { steered = true; setTimeout(() => worker.steer({ role: 'user', content: 'Also check labels', timestamp: new Date() }), 100); }
    return { written: true };
  } });
  // Guidance is drained into the follow-up prompt; the second run's tool call sees an empty queue.
  const result = JSON.parse(await worker.run('sample'));
  expect(fixture.execute).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).toContain('written');
  expect(JSON.stringify(result)).not.toContain('[Octipus]');
  expect(JSON.stringify(result)).not.toContain('Also check labels');
  expect(worker.getStatus()).toBe('completed');
});

it.skipIf(!!process.env.OCTIPUS_LIVE_CLI)('late guidance with no turn budget keeps the result and reports what was not applied', async () => {
  writeFileSync(fixture.script, lateGuidanceScript);
  const worker = new CLIAgentWorker({ id: 'a', sessionId: 's', userId: 'u', model: 'cli/claude-code', role: 'general', topic: '', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    { maxIterations: 1, maxTokenBudget: 10000, timeout: 10000, contextWindowSize: 10000 });
  const thoughts: unknown[] = [];
  worker.onEvent(event => { if (event.type === 'thought') thoughts.push(event.data); });
  worker.registerTool({ name: 'sample_write', description: '', parameters: { type: 'object' }, execute: async () => {
    fixture.execute();
    setTimeout(() => worker.steer({ role: 'user', content: 'Also check labels', timestamp: new Date() }), 100);
    return { written: true };
  } });
  const result = await worker.run('sample');
  expect(fixture.execute).toHaveBeenCalledTimes(1);
  expect(result).toContain('written');
  expect(result).toContain('[Octipus] 1 guidance/feedback item arrived');
  expect(result).toContain('turn budget is exhausted');
  expect(thoughts).toContainEqual(expect.objectContaining({ type: 'guidance_pending', count: 1 }));
  expect(worker.getStatus()).toBe('completed');
});
