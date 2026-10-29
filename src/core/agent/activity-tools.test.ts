import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentActivityTools } from './activity-tools';
import { runDelegationAttempt, type DelegationAttempt } from '../swarm/attempt-history';
import type { AgentContext } from '../types';

process.env.MASTER_KEY ??= 'synthetic-test-master-key-activity';
process.env.JWT_SECRET ??= 'synthetic-test-jwt-key-activity';
process.env.SESSION_SECRET ??= 'synthetic-test-session-key-activity';
const owner = randomUUID(), sessionId = randomUUID(), workspaceId = randomUUID(), otherWorkspace = randomUUID();
const dispatchId = randomUUID();
const canary = 'synthetic-credential-activity-canary-only';
const primary = 'beddffb1000000000000000000000000', backup = 'backupagent0000000000000000000000';
const context = { id: 'parent', userId: owner, sessionId, workspaceId } as AgentContext;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-activity-'));
  const { initializeDb, queryRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate'); await runMigrations();
  const { initializeVault, getVault } = await import('@/security/vault'); await initializeVault();
  await queryRaw('INSERT INTO users (id,username) VALUES ($1,$2)', [owner, `activity-${owner}`]);
  await queryRaw('INSERT INTO workspaces (id,user_id,slug,name,files_dir) VALUES ($1,$2,$3,$4,$5)', [workspaceId, owner, `activity-${workspaceId}`, 'Activity', workspaceId]);
  await queryRaw('INSERT INTO sessions (id,user_id,workspace_id,channel_type,channel_id) VALUES ($1,$2,$3,$4,$5)', [sessionId, owner, workspaceId, 'api', 'activity']);
  await getVault().store(owner, 'activity_canary', canary, { credentialType: 'api_key' });
  for (const id of [primary, backup]) await queryRaw('INSERT INTO agents (id,session_id,user_id,workspace_id,model,metadata) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, sessionId, owner, workspaceId, id === primary ? 'cli/claude-code' : 'cli/antigravity', JSON.stringify({ delegationDispatchId: dispatchId })]);
});
afterAll(async () => { const { closeDb } = await import('@/db/postgres'); await closeDb(); });

test('parent retrieves primary and fallback failure records after collect, with UI identities and redaction', async () => {
  const history: DelegationAttempt[] = [];
  const error = new Error(`Primary failed with auth ${canary}`);
  await expect(runDelegationAttempt({ dispatchId, agentId: primary, uiAgentId: primary,
    requestedModel: 'cli/claude-code', selectedModel: 'cli/claude-code', selectedModelName: 'Claude', route: 'primary' },
    history, async () => { throw error; }, context)).rejects.toThrow('Primary failed');
  await expect(runDelegationAttempt({ dispatchId, agentId: backup, uiAgentId: backup,
    requestedModel: 'cli/claude-code', selectedModel: 'cli/antigravity', selectedModelName: 'Backup', route: 'backup', fallbackReason: history[0].error },
    history, async () => { throw Object.assign(new Error('Fallback quota exhausted'), { cliDiagnostics: { exitCode: 1, stderr: `token=${canary}` } }); }, context)).rejects.toThrow('Fallback quota');
  const [tool] = createAgentActivityTools();
  const result = await tool.execute({ dispatchId }, context) as { agents: Array<{ agentId: string; uiPath: string; attempts: DelegationAttempt[] }> };
  expect(result.agents).toHaveLength(2);
  const attempts = result.agents.flatMap(row => row.attempts).sort((a,b) => a.startedAt.localeCompare(b.startedAt));
  expect(attempts.map(attempt => attempt.route)).toEqual(['primary', 'backup']);
  expect(attempts[0].error).toContain('Primary failed');
  expect(attempts[1]).toMatchObject({ error: 'Fallback quota exhausted', exitCode: 1 });
  expect(JSON.stringify(result)).not.toContain(canary);
  expect(JSON.stringify(history)).not.toContain(canary);
  expect(result.agents.find(row => row.agentId === primary)?.uiPath).toBe(`/agents/view?id=${primary}`);
  expect(await tool.execute({ agentId: 'beddffb1' }, context)).toMatchObject({ agents: [{ agentId: primary }] });
  expect(await tool.execute({ dispatchId }, { ...context, workspaceId: otherWorkspace })).toMatchObject({ error: 'Workspace scope mismatch' });
});

test('short UI identities report ambiguity without returning event data', async () => {
  const { queryRaw } = await import('@/db/postgres');
  await queryRaw('INSERT INTO agents (id,session_id,user_id,workspace_id) VALUES ($1,$2,$3,$4)', ['beddffb1111111111111111111111111',sessionId,owner,workspaceId]);
  expect(await createAgentActivityTools()[0].execute({ agentId: 'beddffb1', includeEvents: true }, context))
    .toMatchObject({ error: 'Ambiguous agent id prefix', candidates: expect.any(Array) });
});

test('supported remediation removes current and historical copies without touching another owner or vault', async () => {
  const { queryRaw } = await import('@/db/postgres');
  const { redactCredentialRecords } = await import('@/db/repositories/credential-remediation');
  const otherOwner = randomUUID(), otherSession = randomUUID();
  await queryRaw('INSERT INTO users (id,username) VALUES ($1,$2)', [otherOwner, `other-${otherOwner}`]);
  await queryRaw('INSERT INTO sessions (id,user_id,channel_type,channel_id) VALUES ($1,$2,$3,$4)', [otherSession,otherOwner,'api','other']);
  await queryRaw('INSERT INTO messages (session_id,role,content) VALUES ($1,$2,$3),($4,$2,$3)',
    [sessionId,'assistant',`${canary}\n${Buffer.from(canary).toString('base64')}`,otherSession]);
  const dry = await redactCredentialRecords(owner, [canary]);
  expect(dry.records).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'messages', applied: false })]));
  const applied = await redactCredentialRecords(owner, [canary], true);
  expect(applied.records.every(row => row.applied)).toBe(true);
  expect((await redactCredentialRecords(owner, [canary])).records).toHaveLength(0);
  const foreign = await queryRaw('SELECT content FROM messages WHERE session_id=$1', [otherSession]);
  expect(foreign.rows[0].content).toContain(canary);
  const { getVault } = await import('@/security/vault');
  expect(await getVault().getByName(owner, 'activity_canary')).toBe(canary);
});

test('remediation advances plan versions and recomputes note hashes, rejecting stale writers', async () => {
  const { queryRaw } = await import('@/db/postgres');
  const { redactCredentialRecords } = await import('@/db/repositories/credential-remediation');
  const { emptyWorkPlan, reviseWorkPlan } = await import('@/shared/work-plan');
  const { workPlanRepository } = await import('@/db/repositories/work-plan-repository');
  const { createHash } = await import('node:crypto');
  const plan = reviseWorkPlan(emptyWorkPlan(), { revision: 0, newPlan: false, feedbackResponses: [], title: 'Synthetic plan', goal: 'Validate cleanup', summary: 'Pending work',
    kind: 'execution', steps: [{ id: 'one', title: 'Still pending', status: 'pending', evidence: '' }], details: canary });
  await queryRaw('UPDATE sessions SET metadata=$1::jsonb WHERE id=$2', [JSON.stringify({ workPlan: plan }), sessionId]);
  const noteId = randomUUID(), oldSha = createHash('sha256').update(canary).digest('hex');
  await queryRaw('INSERT INTO notes (id,user_id,workspace_id,slug,title,body,body_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [noteId,owner,workspaceId,'synthetic-exposure','Synthetic exposure',canary,oldSha]);
  const { rows: [revision] } = await queryRaw('INSERT INTO note_revisions (note_id,workspace_id,body,body_sha256,origin) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [noteId,workspaceId,canary,oldSha,'external']);
  await redactCredentialRecords(owner, [canary], true);
  const cleaned = await workPlanRepository.read(sessionId, owner);
  expect(cleaned.revision).toBe(plan.revision + 1);
  expect(cleaned.current?.revision).toBe(cleaned.revision);
  expect(cleaned.current?.steps[0].status).toBe('pending');
  await expect(workPlanRepository.save(sessionId, owner, plan.revision, plan)).rejects.toThrow('Plan changed');
  for (const [table, id] of [['notes',noteId],['note_revisions',revision.id]]) {
    const { rows: [row] } = await queryRaw(`SELECT body,body_sha256 FROM "${table}" WHERE id=$1`, [id]);
    expect(row.body).not.toContain(canary);
    expect(row.body_sha256).toBe(createHash('sha256').update(row.body).digest('hex'));
    expect((await queryRaw(`UPDATE "${table}" SET body=$1 WHERE id=$2 AND body_sha256=$3 RETURNING id`, [canary,id,oldSha])).rows).toHaveLength(0);
  }
});

test('history pagination skips inaccessible sessions without returning a lookahead row twice', async () => {
  const { queryRaw } = await import('@/db/postgres');
  const foreign = randomUUID(), foreignSession = randomUUID();
  await queryRaw('INSERT INTO users (id,username) VALUES ($1,$2)', [foreign, `hidden-${foreign}`]);
  await queryRaw('INSERT INTO sessions (id,user_id,workspace_id,channel_type,channel_id) VALUES ($1,$2,$3,$4,$5)', [foreignSession,foreign,workspaceId,'api','hidden']);
  await queryRaw('INSERT INTO agents (id,session_id,user_id,workspace_id,metadata) VALUES ($1,$2,$3,$4,$5),($6,$7,$3,$4,$5)',
    ['00000000-hidden',foreignSession,owner,workspaceId,JSON.stringify({delegationDispatchId:'pagination-test'}),'00000001-visible',sessionId]);
  const tool = createAgentActivityTools()[0];
  const first = await tool.execute({dispatchId:'pagination-test',limit:1},context) as any;
  expect(first.agents.map((row:any)=>row.agentId)).toEqual(['00000001-visible']);
  expect(first.nextAgentCursor).toBe('00000001-visible');
  expect(JSON.stringify(first)).not.toContain('00000000-hidden');
  const next = await tool.execute({dispatchId:'pagination-test',limit:1,afterAgentId:first.nextAgentCursor},context) as any;
  expect(next.agents).toHaveLength(0);
  expect(next.hasMoreAgents).toBe(false);
  expect(await tool.execute({agentId:'beddffb1',limit:1},context)).toMatchObject({error:'Ambiguous agent id prefix'});
});

test('sanitized delegated failures preserve classification without raw stacks, causes or metadata', async () => {
  const { ClassifiedError, FailoverReason, RecoveryAction } = await import('@/core/errors/classification');
  const history: DelegationAttempt[] = [];
  const failure = new ClassifiedError({ reason: FailoverReason.QUOTA_EXHAUSTED,
    recovery: RecoveryAction.FALLBACK_PROVIDER, message: `Primary failed ${canary}`, metadata: { token: canary }, cause: new Error(`Nested failure ${canary}`) });
  let caught: unknown;
  try {
    await runDelegationAttempt({dispatchId,agentId:primary,uiAgentId:primary,requestedModel:'cli/claude-code',
      selectedModel:'cli/claude-code',selectedModelName:'Claude',route:'primary'},history,async()=>{throw failure;},context);
  } catch(error) { caught = error; }
  expect(caught).toBeInstanceOf(ClassifiedError);
  expect((caught as InstanceType<typeof ClassifiedError>).reason).toBe(FailoverReason.QUOTA_EXHAUSTED);
  expect(JSON.stringify({stack:(caught as Error).stack,cause:(caught as Error).cause,error:caught})).not.toContain(canary);
});

test('an authorized managed MCP parent retrieves failed provider history through its run bridge', async () => {
  const { startCliToolBridge } = await import('@/core/cli-tool-bridge');
  const tool = createAgentActivityTools()[0];
  const bridge = await startCliToolBridge({ active: () => true, tools: () => [tool], advertisedTools: () => [],
    execute: async (_name,args) => ({ content: [{ type: 'text', text: JSON.stringify(await tool.execute(args,context)) }] }) });
  try {
    const response = await fetch(`${bridge.url}/call`, { method: 'POST',
      headers: { Authorization: `Bearer ${bridge.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({name:'call_discovered_tool',arguments:{name:'get_agent_activity',arguments:{dispatchId}}}) });
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    const history = JSON.parse(result.content[0].text);
    expect(history.attempts.some((attempt:any) => attempt.route==='primary' && /Primary failed/.test(attempt.error))).toBe(true);
    expect(history.attempts.some((attempt:any) => attempt.route==='backup' && /Fallback quota/.test(attempt.error))).toBe(true);
    expect(history.agents.find((row:any)=>row.agentId===primary).uiPath).toBe(`/agents/view?id=${primary}`);
    expect(JSON.stringify(history)).not.toContain(canary);
  } finally { await bridge.close(); }
});
