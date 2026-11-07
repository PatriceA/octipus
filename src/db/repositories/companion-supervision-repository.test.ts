import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { getDb } from '@/db/postgres';
import { CompanionService } from '@/core/companion/service';
import { CompanionSupervisionRepository } from './companion-supervision-repository';
import { CompanionDispatcher } from '@/core/companion/dispatcher';
import { tickCompanionObservation } from '@/core/companion/observation';
import { companionStallSuspected, scanCompanionStalls, COMPANION_STALL_SILENCE_MS } from '@/core/companion/stalls';
import { recordCompanionOwnerStop } from '@/core/companion/user-control';
import { persistCompanionSource } from '@/core/companion/provenance';
import { observeFlow, resetFlowLabels } from '@/security/flow-guard';
import { raiseSessionLevel, resetSessionLevels } from '@/core/protection/session-level';

const runtime = vi.hoisted(() => ({ db: undefined as unknown, handle: vi.fn(), canSteer: vi.fn(), steer: vi.fn(), publish: vi.fn(), stop: vi.fn(), guard: vi.fn(), model: vi.fn(), worker: vi.fn() }));
vi.mock('@/db/postgres', () => ({ getDb: () => runtime.db }));
vi.mock('@/core/agent/service', () => ({ getAgentService: () => ({ handleMessage: runtime.handle, canSteer: runtime.canSteer, steer: runtime.steer, publishResponse: runtime.publish }) }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ get: runtime.worker, stopSession: runtime.stop, getBySession: () => [{ getStatus: () => 'running', getContext: () => ({ root: true, model: 'fixture-model', modelName: 'fixture-model' }) }] }) }));
vi.mock('@/models/resolve-model', () => ({ resolveModel: runtime.model }));
vi.mock('@/core/protection/routing', () => ({ assertMayLeave: runtime.guard }));

const userId = randomUUID(), otherUserId = randomUUID();
const workspaceId = randomUUID(), secondWorkspaceId = randomUUID(), otherWorkspaceId = randomUUID(), sharedWorkspaceId = randomUUID();
const sessionId = randomUUID(), otherSessionId = randomUUID(), secondSessionId = randomUUID(), roomId = randomUUID(), groupSessionId = randomUUID();
const pipelineId = randomUUID(), otherPipelineId = randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'octipus-companion-db-'));
let pg: PGlite;
let db: ReturnType<typeof drizzle>;
const connection = () => db as unknown as ReturnType<typeof getDb>;
const repository = (user = userId, workspace = workspaceId) => new CompanionSupervisionRepository({ userId: user, workspaceId: workspace }, connection);
const service = () => new CompanionService({ userId, workspaceId }, repository());
const request = (extra: Record<string, unknown> = {}) => ({ requestKey: randomUUID(), title: 'Finish Life²', request: 'Continue the existing roadmap',
  outcome: 'The agreed milestone is verified', acceptanceCriteria: ['Tests pass'], ...extra });
const adoption = (extra: Record<string, unknown> = {}) => ({ expectedRevision: 0, sessionId, pipelineId, purpose: 'Continue the existing pipeline', ...extra });

beforeAll(async () => {
  pg = new PGlite(dir);
  await pg.exec(`
    CREATE TABLE users(id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true, kind text NOT NULL DEFAULT 'local');
    CREATE TABLE workspaces(id uuid PRIMARY KEY, user_id uuid REFERENCES users(id), kind text NOT NULL DEFAULT 'personal', archived_at timestamptz);
    CREATE TABLE sessions(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), workspace_id uuid, kind text NOT NULL DEFAULT 'chat',
      group_channel_id uuid, protection_level smallint, flow_label jsonb, context jsonb DEFAULT '{}', metadata jsonb DEFAULT '{}', status text DEFAULT 'active',
      title text, channel_type text, channel_id text, updated_at timestamptz DEFAULT now());
    ALTER TABLE sessions ADD COLUMN thread_id text;
    ALTER TABLE sessions ADD COLUMN room_visibility text;
    ALTER TABLE sessions ADD COLUMN message_count integer DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN token_count integer DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN pinned boolean DEFAULT false;
    ALTER TABLE sessions ADD COLUMN created_at timestamptz DEFAULT now();
    ALTER TABLE sessions ADD COLUMN completed_at timestamptz;
    CREATE TABLE pipelines(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), workspace_id uuid, session_id uuid NOT NULL REFERENCES sessions(id), status text DEFAULT 'running');
    CREATE TABLE tasks(id uuid PRIMARY KEY, user_id uuid REFERENCES users(id), workspace_id uuid);
    CREATE TABLE verification_evidence(id uuid PRIMARY KEY, session_id uuid, pipeline_id uuid, passed boolean,
      kind text DEFAULT 'pre_verify', confidence text, stage text, node_id text, detail jsonb, created_at timestamptz DEFAULT now());
    CREATE TABLE agents(id text PRIMARY KEY, session_id uuid, status text, user_id text, workspace_id uuid, role text, model text, error text, metadata jsonb DEFAULT '{}', parent_agent_id text, total_tokens integer DEFAULT 0, billable_tokens integer, completed_at timestamptz, created_at timestamptz DEFAULT now());
    CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, role text, content text, metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now());
    ALTER TABLE pipelines ADD COLUMN title text;
    ALTER TABLE pipelines ADD COLUMN summary text;
    ALTER TABLE pipelines ADD COLUMN current_node_key text;
    ALTER TABLE pipelines ADD COLUMN created_at timestamptz DEFAULT now();
    ALTER TABLE pipelines ADD COLUMN updated_at timestamptz DEFAULT now();
    ALTER TABLE pipelines ADD COLUMN metadata jsonb DEFAULT '{}';
    CREATE TABLE agent_events(id serial PRIMARY KEY,agent_id text,user_id text,created_at timestamptz DEFAULT now());
    CREATE TABLE tool_actions(id uuid PRIMARY KEY,agent_id text,user_id text,status text,created_at timestamptz DEFAULT now());
    CREATE TABLE cost_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,workspace_id uuid,agent_id text,session_id uuid,input_tokens integer,output_tokens integer,cached_input_tokens integer DEFAULT 0,request_type text,created_at timestamptz DEFAULT now());
    CREATE TABLE notifications(id uuid PRIMARY KEY,user_id uuid,workspace_id uuid,type text,title text,body text,metadata jsonb,read boolean DEFAULT false,delivered_channels text[] DEFAULT '{}',created_at timestamptz DEFAULT now());
    CREATE TABLE permission_requests(id uuid PRIMARY KEY,agent_id text,status text,expires_at timestamptz);
  `);
  await pg.exec(readFileSync('src/db/migrations/0160_companion_supervision.sql', 'utf8'));
  await pg.exec(readFileSync('src/db/migrations/0161_companion_actions.sql', 'utf8'));
  await pg.exec(readFileSync('src/db/migrations/0162_companion_observation.sql', 'utf8'));
  await pg.exec(readFileSync('src/db/migrations/0163_companion_recovery.sql', 'utf8'));
  await pg.exec(readFileSync('src/db/migrations/0164_companion_maintenance.sql', 'utf8'));
  await pg.exec(readFileSync('src/db/migrations/0165_companion_coordination.sql','utf8'));
  await pg.exec(readFileSync('src/db/migrations/0166_companion_sources.sql','utf8'));
  await pg.exec(readFileSync('src/db/migrations/0167_companion_wake_usage.sql','utf8'));
  await pg.exec(readFileSync('src/db/migrations/0168_companion_briefings.sql','utf8'));
  db = drizzle(pg);
  runtime.db = db;
}, 30_000);
afterAll(async () => { await pg.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  await pg.exec('TRUNCATE cost_log,notifications, companion_wakes,companion_events,companion_settings,companion_actions, companion_session_links, companion_goals, verification_evidence, tasks, pipelines, sessions, workspaces, users, agents, messages,agent_events,tool_actions,permission_requests CASCADE');
  vi.clearAllMocks(); resetFlowLabels(); resetSessionLevels();
  runtime.canSteer.mockReturnValue(false); runtime.steer.mockReturnValue(true); runtime.guard.mockResolvedValue(undefined);
  runtime.worker.mockReturnValue(undefined);
  runtime.model.mockImplementation(async ({ name }: { name: string }) => ({ name, modelId: name, supportsTools: true, provider: 'cli' }));
  runtime.handle.mockImplementation(async (_session, _user, _message, _channel, _files, _mode, beforeStart) => { await beforeStart(); return { outcome: 'success', response: 'Checked result' }; });
  await pg.query('INSERT INTO users(id) VALUES ($1), ($2)', [userId, otherUserId]);
  await pg.query(`INSERT INTO workspaces(id,user_id,kind) VALUES ($1,$2,'personal'),($3,$2,'personal'),($4,$5,'personal'),($6,NULL,'shared')`,
    [workspaceId, userId, secondWorkspaceId, otherWorkspaceId, otherUserId, sharedWorkspaceId]);
  for (const [id, user, workspace, kind, group] of [
    [sessionId, userId, workspaceId, 'chat', null], [otherSessionId, otherUserId, otherWorkspaceId, 'chat', null],
    [secondSessionId, userId, secondWorkspaceId, 'chat', null], [roomId, userId, workspaceId, 'room', null],
    [groupSessionId, userId, workspaceId, 'chat', randomUUID()],
  ]) await pg.query('INSERT INTO sessions(id,user_id,workspace_id,kind,group_channel_id) VALUES ($1,$2,$3,$4,$5)', [id, user, workspace, kind, group]);
  await pg.query('INSERT INTO pipelines(id,user_id,workspace_id,session_id) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)',
    [pipelineId, userId, workspaceId, sessionId, otherPipelineId, otherUserId, otherWorkspaceId, otherSessionId]);
});

test('creation is durable and concurrent retries create one goal without undoing later edits', async () => {
  const input = request();
  const results = await Promise.all(Array.from({ length: 4 }, () => service().createGoal(input)));
  expect(new Set(results.map(row => row.id)).size).toBe(1);
  const goal = results[0];
  await service().updateGoal(goal.id, { expectedRevision: 0, priority: 3 });
  expect(await service().createGoal(input)).toMatchObject({ id: goal.id, priority: 3, revision: 1 });
  expect(await repository().list()).toHaveLength(1);
  await expect(service().createGoal({ ...input, outcome: 'Different outcome' })).rejects.toMatchObject({ code: 'conflict' });
});

test('all reads and mutations are scoped to the exact owner and personal workspace', async () => {
  const goal = await service().createGoal(request());
  for (const repo of [repository(otherUserId, otherWorkspaceId), repository(userId, secondWorkspaceId)]) {
    expect(await repo.list()).toEqual([]);
    await expect(repo.read(goal.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(repo.update(goal.id, { expectedRevision: 0, state: 'cancelled' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(repo.adopt(goal.id, adoption())).rejects.toMatchObject({ code: 'not_found' });
  }
  for (const repo of [repository(userId, otherWorkspaceId), repository(userId, sharedWorkspaceId)]) {
    await expect(repo.list()).rejects.toMatchObject({ code: 'scope_unavailable' });
    await expect(repo.create(request())).rejects.toMatchObject({ code: 'scope_unavailable' });
  }
});

test('workspace archival and user deactivation revoke an already constructed service', async () => {
  const supervisor = service();
  const goal = await supervisor.createGoal(request());
  await pg.query('UPDATE workspaces SET archived_at=now() WHERE id=$1', [workspaceId]);
  await expect(supervisor.readGoal(goal.id)).rejects.toMatchObject({ code: 'scope_unavailable' });
  await pg.query('UPDATE workspaces SET archived_at=NULL WHERE id=$1', [workspaceId]);
  await pg.query('UPDATE users SET is_active=false WHERE id=$1', [userId]);
  await expect(supervisor.updateGoal(goal.id, { expectedRevision: 0, state: 'active' })).rejects.toMatchObject({ code: 'scope_unavailable' });
});

test('source task and work plan links require the same personal scope', async () => {
  const taskId = randomUUID(), foreignTaskId = randomUUID();
  await pg.query('INSERT INTO tasks VALUES ($1,$2,$3),($4,$5,$6)', [taskId, userId, workspaceId, foreignTaskId, otherUserId, otherWorkspaceId]);
  await pg.query(`UPDATE sessions SET metadata='{"workPlan":{"revision":1}}', protection_level=4 WHERE id=$1`, [sessionId]);
  expect(await service().createGoal(request({ taskId, workPlanSessionId: sessionId }))).toMatchObject({ taskId, workPlanSessionId: sessionId, protectionLevel: 4 });
  for (const extra of [{ taskId: foreignTaskId }, { workPlanSessionId: otherSessionId }, { workPlanSessionId: secondSessionId }]) {
    await expect(service().createGoal(request(extra))).rejects.toMatchObject({ code: 'not_found' });
  }
});

test('retrying creation with a work plan can race adoption without changing the source or duplicating the goal', async () => {
  await pg.query(`UPDATE sessions SET metadata='{"workPlan":{"revision":1}}' WHERE id=$1`, [sessionId]);
  const input = request({ workPlanSessionId: sessionId });
  const goal = await service().createGoal(input);
  const results = await Promise.all([service().createGoal(input), service().adoptExecution(goal.id, adoption())]);
  expect(results[0].id).toBe(goal.id);
  expect((await service().readGoal(goal.id)).links).toHaveLength(1);
  expect(await service().listGoals()).toHaveLength(1);
});

test('adoption links existing work once and does not change or restart the pipeline', async () => {
  const goal = await service().createGoal(request());
  const first = await service().adoptExecution(goal.id, adoption());
  const retry = await service().adoptExecution(goal.id, adoption());
  expect(retry.link.id).toBe(first.link.id);
  expect(retry.goal.revision).toBe(1);
  expect((await service().readGoal(goal.id)).links).toHaveLength(1);
  const { rows } = await pg.query('SELECT count(*)::int AS count FROM pipelines');
  expect(rows).toEqual([{ count: 2 }]);
  const pipeline = await pg.query('SELECT status FROM pipelines WHERE id=$1', [pipelineId]);
  expect(pipeline.rows).toEqual([{ status: 'running' }]);
});

test('foreign sessions, shared conversations and mismatched pipeline references cannot be adopted', async () => {
  const goal = await service().createGoal(request());
  for (const extra of [{ sessionId: otherSessionId }, { sessionId: secondSessionId }, { sessionId: roomId },
    { sessionId: groupSessionId }, { pipelineId: otherPipelineId }]) {
    await expect(service().adoptExecution(goal.id, adoption(extra))).rejects.toMatchObject({ code: 'not_found' });
  }
  expect((await service().readGoal(goal.id)).links).toEqual([]);
});

test('competing goals cannot own the same execution; observers can reference it', async () => {
  const a = await service().createGoal(request()), b = await service().createGoal(request());
  const results = await Promise.allSettled([service().adoptExecution(a.id, adoption()), service().adoptExecution(b.id, adoption())]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }]);
  const loser = results[0].status === 'rejected' ? a : b;
  expect((await service().adoptExecution(loser.id, adoption({ ownership: 'observer' }))).link.ownership).toBe('observer');
});

test.each([true, false])('whole-session ownership conflicts with another goal owning its pipeline in either order: %s', async sessionFirst => {
  const a = await service().createGoal(request()), b = await service().createGoal(request());
  await service().adoptExecution(a.id, adoption({ pipelineId: sessionFirst ? null : pipelineId }));
  await expect(service().adoptExecution(b.id, adoption({ pipelineId: sessionFirst ? pipelineId : null }))).rejects.toMatchObject({ code: 'conflict' });
});

test('optimistic revisions reject stale edits and invalid lifecycle transitions', async () => {
  const goal = await service().createGoal(request());
  const edits = await Promise.allSettled([service().updateGoal(goal.id, { expectedRevision: 0, state: 'active' }),
    service().updateGoal(goal.id, { expectedRevision: 0, priority: 3 })]);
  expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(edits.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }]);
  const current = (await service().readGoal(goal.id)).goal;
  await expect(service().updateGoal(goal.id, { expectedRevision: current.revision, state: 'queued' })).rejects.toMatchObject({ code: 'conflict' });
});

test('pausing retains ownership; cancelling releases it without stopping adopted work', async () => {
  const a = await service().createGoal(request()), b = await service().createGoal(request());
  await service().adoptExecution(a.id, adoption());
  await service().updateGoal(a.id, { expectedRevision: 1, state: 'paused' });
  expect((await service().readGoal(a.id)).links[0].active).toBe(true);
  await expect(service().adoptExecution(b.id, adoption())).rejects.toMatchObject({ code: 'conflict' });
  await service().updateGoal(a.id, { expectedRevision: 2, state: 'cancelled' });
  expect((await service().readGoal(a.id)).links[0]).toMatchObject({ active: false, releasedAt: expect.any(Date) });
  await service().adoptExecution(b.id, adoption());
  expect((await pg.query('SELECT status FROM pipelines WHERE id=$1', [pipelineId])).rows).toEqual([{ status: 'running' }]);
  await expect(service().updateGoal(a.id, { expectedRevision: 3, state: 'active' })).rejects.toMatchObject({ code: 'conflict' });
});

test('protection increases from linked sources and never lowers when supervision ends', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption());
  await pg.query('UPDATE sessions SET protection_level=4 WHERE id=$1', [sessionId]);
  expect((await service().readGoal(goal.id)).goal.protectionLevel).toBe(4);
  expect((await service().listGoals())[0].protectionLevel).toBe(4);
  await pg.query('DELETE FROM pipelines WHERE id=$1', [pipelineId]);
  await pg.query('DELETE FROM sessions WHERE id=$1', [sessionId]);
  expect((await service().readGoal(goal.id)).links).toEqual([]);
  expect((await service().readGoal(goal.id)).goal.protectionLevel).toBe(4);
});

test('completion requires passed ledger evidence for every criterion and a completed owned pipeline', async () => {
  const goal = await service().createGoal(request({ acceptanceCriteria: ['Tests pass', 'QA accepts the result'] }));
  await service().adoptExecution(goal.id, adoption());
  await service().updateGoal(goal.id, { expectedRevision: 1, state: 'active' });
  const passId = randomUUID(), failedId = randomUUID(), foreignId = randomUUID();
  await pg.query('INSERT INTO verification_evidence(id,session_id,pipeline_id,passed,stage) VALUES ($1,$2,$3,true,\'test\'),($4,$2,$3,false,\'different-check\'),($5,$6,$7,true,\'test\')',
    [passId, sessionId, pipelineId, failedId, foreignId, otherSessionId, otherPipelineId]);
  const item = (criterionIndex: number, evidenceId = passId) => ({ criterionIndex, evidenceId, summary: 'Recorded check passed' });
  const complete = (evidence: unknown[]) => service().updateGoal(goal.id, { expectedRevision: 2, state: 'completed', evidence });
  for (const evidence of [[item(0)], [item(0), item(0)], [item(0), item(2)], [item(0), item(1, failedId)], [item(0), item(1, foreignId)]]) {
    await expect(complete(evidence)).rejects.toMatchObject({ code: 'invalid_evidence' });
  }
  await expect(complete([item(0), item(1)])).rejects.toMatchObject({ code: 'conflict' });
  await pg.query("UPDATE pipelines SET status='completed' WHERE id=$1", [pipelineId]);
  expect(await complete([item(0), item(1)])).toMatchObject({ state: 'completed', revision: 3, completedAt: expect.any(Date) });
  expect((await service().readGoal(goal.id)).links[0].active).toBe(false);
});

test('a link to one pipeline cannot use passing evidence from another pipeline in the same session', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption());
  await service().updateGoal(goal.id, { expectedRevision: 1, state: 'active' });
  const evidenceId = randomUUID();
  await pg.query('INSERT INTO verification_evidence(id,session_id,pipeline_id,passed) VALUES ($1,$2,$3,true)', [evidenceId, sessionId, randomUUID()]);
  await expect(service().updateGoal(goal.id, { expectedRevision: 2, state: 'completed', evidence: [{ criterionIndex: 0, evidenceId, summary: 'Other pipeline check' }] }))
    .rejects.toMatchObject({ code: 'invalid_evidence' });
});

test('a newer result supersedes old passing evidence, including equal-time failures', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption({ pipelineId: null }));
  await service().updateGoal(goal.id, { expectedRevision: 1, state: 'active' });
  const oldPass = randomUUID(), failure = randomUUID(), freshPass = randomUUID();
  await pg.query(`INSERT INTO verification_evidence(id,session_id,passed,created_at) VALUES ($1,$2,true,'2026-11-05T12:00:00Z'),($3,$2,false,'2026-11-05T12:01:00Z')`,
    [oldPass, sessionId, failure]);
  const complete = (evidenceId: string) => service().updateGoal(goal.id, { expectedRevision: 2, state: 'completed',
    evidence: [{ criterionIndex: 0, evidenceId, summary: 'Test gate' }] });
  await expect(complete(oldPass)).rejects.toMatchObject({ code: 'invalid_evidence' });
  await pg.query("UPDATE verification_evidence SET created_at='2026-11-05T12:00:00Z' WHERE id=$1", [failure]);
  await expect(complete(oldPass)).rejects.toMatchObject({ code: 'invalid_evidence' });
  await pg.query(`INSERT INTO verification_evidence(id,session_id,passed,created_at) VALUES ($1,$2,true,'2026-11-05T12:02:00Z')`, [freshPass, sessionId]);
  // No owned pipeline for this session may remain unfinished.
  await pg.query("UPDATE pipelines SET status='completed' WHERE id=$1", [pipelineId]);
  expect(await complete(freshPass)).toMatchObject({ state: 'completed' });
});

test.each(['command', 'checkScope'])('independent %s checks do not supersede each other', async key => {
  const goal = await service().createGoal(request({ acceptanceCriteria: ['Tests pass', 'Build passes'] }));
  await service().adoptExecution(goal.id, adoption());
  await service().updateGoal(goal.id, { expectedRevision: 1, state: 'active' });
  const first = randomUUID(), second = randomUUID();
  await pg.query(`INSERT INTO verification_evidence(id,session_id,pipeline_id,passed,detail,created_at)
    VALUES ($1,$2,$3,true,$4,'2026-11-05T12:00:00Z'),($5,$2,$3,true,$6,'2026-11-05T12:01:00Z')`,
    [first, sessionId, pipelineId, JSON.stringify({ [key]: 'first-check' }), second, JSON.stringify({ [key]: 'second-check' })]);
  await pg.query("UPDATE pipelines SET status='completed' WHERE id=$1", [pipelineId]);
  expect(await service().updateGoal(goal.id, { expectedRevision: 2, state: 'completed', evidence: [
    { criterionIndex: 0, evidenceId: first, summary: 'Tests passed' }, { criterionIndex: 1, evidenceId: second, summary: 'Build passed' },
  ] })).toMatchObject({ state: 'completed' });
});

test('ambiguous legacy pipeline QA evidence needs scoped or aggregate verification', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption());
  await service().updateGoal(goal.id, { expectedRevision: 1, state: 'active' });
  await pg.query("UPDATE pipelines SET status='completed' WHERE id=$1", [pipelineId]);
  const evidenceId = randomUUID();
  await pg.query("INSERT INTO verification_evidence(id,session_id,pipeline_id,passed,kind) VALUES ($1,$2,$3,true,'qa_verdict')", [evidenceId, sessionId, pipelineId]);
  const complete = () => service().updateGoal(goal.id, { expectedRevision: 2, state: 'completed', evidence: [{ criterionIndex: 0, evidenceId, summary: 'QA passed' }] });
  await expect(complete()).rejects.toMatchObject({ code: 'invalid_evidence' });
  await pg.query(`UPDATE verification_evidence SET detail='{"checkScope":"item:one:node:qa"}' WHERE id=$1`, [evidenceId]);
  expect(await complete()).toMatchObject({ state: 'completed' });
});

test('goals and adopted links survive closing and reopening the database', async () => {
  const goal = await service().createGoal(request());
  const adopted = await service().adoptExecution(goal.id, adoption());
  await pg.close();
  pg = new PGlite(dir);
  await pg.waitReady;
  db = drizzle(pg);
  runtime.db = db;
  const restored = await service().readGoal(goal.id);
  expect(restored.goal).toMatchObject({ id: goal.id, state: 'queued', revision: 1 });
  expect(restored.links).toMatchObject([{ id: adopted.link.id, pipelineId, active: true }]);
}, 30_000);

test('input contracts reject hidden scope changes, forged origin and credential interpolation', async () => {
  await expect(service().createGoal(request({ userId: otherUserId }))).rejects.toThrow();
  await expect(service().createGoal(request({ request: '{{secret:credential}}' }))).rejects.toThrow('Vault interpolation');
  const goal = await service().createGoal(request());
  await expect(service().adoptExecution(goal.id, adoption({ origin: 'created' }))).rejects.toThrow();
  await expect(service().updateGoal(goal.id, { expectedRevision: 0, state: 'completed' })).rejects.toThrow();
});

test('starting a session and retrying the request creates one session, link and action', async () => {
  const goal = await service().createGoal(request());
  const input = { requestKey: randomUUID(), expectedRevision: 0, modelName: 'fixture-model' };
  const [a, b] = await Promise.all([service().startSession(goal.id, input), service().startSession(goal.id, input)]);
  expect(a.id).toBe(b.id);
  expect(a.sessionId).toBe(b.sessionId);
  expect((await service().readGoal(goal.id)).links).toMatchObject([{ sessionId: a.sessionId, origin: 'created' }]);
  expect(await service().actions(goal.id)).toHaveLength(1);
  const session = await pg.query('SELECT context FROM sessions WHERE id=$1', [a.sessionId]);
  expect(session.rows).toMatchObject([{ context: { companion: { modelName: 'fixture-model', goalId: goal.id } } }]);
  await expect(service().startSession(goal.id, { ...input, modelName: 'other-model' })).rejects.toMatchObject({ code: 'conflict' });
});

test('source privacy survives goal creation, source deletion and later session creation', async () => {
  await pg.query(`UPDATE sessions SET protection_level=4, flow_label='{"secret":"source-env","private":"source"}' WHERE id=$1`, [sessionId]);
  const goal = await service().createGoal(request({ sourceSessionId: sessionId }));
  expect(goal).toMatchObject({ protectionLevel: 4, flowLabel: { secret: 'source-env' } });
  await pg.query('DELETE FROM pipelines WHERE id=$1', [pipelineId]);
  await pg.query('DELETE FROM sessions WHERE id=$1', [sessionId]);
  const action = await service().startSession(goal.id, { requestKey: randomUUID(), expectedRevision: 0, modelName: 'fixture-model' });
  expect(action).toMatchObject({ protectionLevel: 4, flowLabel: { secret: 'source-env' } });
  expect((await pg.query('SELECT protection_level,flow_label FROM sessions WHERE id=$1', [action.sessionId])).rows)
    .toMatchObject([{ protection_level: 4, flow_label: { secret: 'source-env' } }]);
});

test('message transfer raises target and receipt provenance and cannot mutate observer-only work', async () => {
  const targetId = randomUUID();
  await pg.query('INSERT INTO sessions(id,user_id,workspace_id) VALUES ($1,$2,$3)', [targetId, userId, workspaceId]);
  await pg.query(`UPDATE sessions SET protection_level=4,flow_label='{"secret":"source-env"}' WHERE id=$1`, [sessionId]);
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption({ sessionId: targetId, pipelineId: null }));
  const action = await service().messageSession(goal.id, { requestKey: randomUUID(), sessionId: targetId, sourceSessionId: sessionId, message: 'Use the protected source' });
  expect(action).toMatchObject({ protectionLevel: 4, flowLabel: { secret: 'source-env' } });
  expect((await pg.query('SELECT protection_level,flow_label FROM sessions WHERE id=$1', [targetId])).rows)
    .toMatchObject([{ protection_level: 4, flow_label: { secret: 'source-env' } }]);
  const observer = await service().createGoal(request());
  await service().adoptExecution(observer.id, adoption({ sessionId: targetId, pipelineId: null, ownership: 'observer' }));
  await expect(service().messageSession(observer.id, { requestKey: randomUUID(), sessionId: targetId, message: 'Change it' })).rejects.toMatchObject({ code: 'not_found' });
});

test('trusted source snapshots cover labels whose background persistence is delayed', async () => {
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const delayedLevel = vi.spyOn(sessionRepository, 'raiseProtectionLevel').mockResolvedValue(undefined);
  const delayedFlow = vi.spyOn(sessionRepository, 'addFlowLabel').mockResolvedValue(undefined);
  try {
    raiseSessionLevel(sessionId, 4);
    observeFlow(sessionId, { toolId: 'fixture', action: 'read' }, { taints: ['secret'] });
    await persistCompanionSource({ userId, workspaceId }, sessionId);
    const goal = await service().createGoal(request({ sourceSessionId: sessionId }));
    expect(goal.protectionLevel).toBe(4);
    expect(goal.flowLabel.secret).toBeTruthy();
  } finally { delayedLevel.mockRestore(); delayedFlow.mockRestore(); }
});

async function waitAction(id: string, status: string) {
  await vi.waitFor(async () => {
    const { rows } = await pg.query<{ status: string }>('SELECT status FROM companion_actions WHERE id=$1', [id]);
    expect(rows[0].status).toBe(status);
  });
}

test('two dispatchers claim one action once and save its result with source provenance', async () => {
  const goal = await service().createGoal(request());
  const action = await service().startSession(goal.id, { requestKey: randomUUID(), expectedRevision: 0, modelName: 'fixture-model' });
  await Promise.all([new CompanionDispatcher().tick(), new CompanionDispatcher().tick()]);
  await waitAction(action.id, 'completed');
  expect(runtime.handle).toHaveBeenCalledTimes(1);
  expect((await service().actions(goal.id))[0]).toMatchObject({ result: 'Checked result', status: 'completed', protectionLevel: 1 });
});

test('clearing a target conversation cancels queued work instead of replaying it into the new generation', async () => {
  const goal = await service().createGoal(request());
  const action = await service().startSession(goal.id, { requestKey: randomUUID(), expectedRevision: 0, modelName: 'fixture-model' });
  await pg.query('UPDATE sessions SET context=$1 WHERE id=$2', [JSON.stringify({ conversationGeneration: randomUUID() }), action.sessionId]);
  await new CompanionDispatcher().tick();
  await waitAction(action.id, 'cancelled');
  expect(runtime.publish).not.toHaveBeenCalled();
});

test('expired execution receipts become unknown and block later turns in the same session', async () => {
  const goal = await service().createGoal(request());
  const first = await service().startSession(goal.id, { requestKey: randomUUID(), expectedRevision: 0, modelName: 'fixture-model' });
  await pg.query("UPDATE companion_actions SET status='running',lease_until=now()-interval '1 minute' WHERE id=$1", [first.id]);
  const next = await service().messageSession(goal.id, { requestKey: randomUUID(), sessionId: first.sessionId, message: 'Continue' });
  await new CompanionDispatcher().tick();
  expect((await service().actions(goal.id)).find(action => action.id === first.id)?.status).toBe('unknown');
  expect((await service().actions(goal.id)).find(action => action.id === next.id)?.status).toBe('queued');
  expect(runtime.handle).not.toHaveBeenCalled();
});

test('live steering is delivered even when both execution slots are occupied', async () => {
  const goal = await service().createGoal(request());
  const first = await service().startSession(goal.id, { requestKey: randomUUID(), expectedRevision: 0, modelName: 'fixture-model' });
  const other = await service().createGoal(request());
  const second = await service().startSession(other.id, { requestKey: randomUUID(), expectedRevision: 0, modelName: 'fixture-model' });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  runtime.handle.mockImplementation(async (_session, _user, _message, _channel, _files, _mode, beforeStart) => { await beforeStart(); await held; return { outcome: 'success', response: 'Done' }; });
  const dispatcher = new CompanionDispatcher();
  await dispatcher.tick();
  await vi.waitFor(() => expect(runtime.handle).toHaveBeenCalledTimes(2));
  const steer = await service().messageSession(goal.id, { requestKey: randomUUID(), sessionId: first.sessionId, message: 'Use the updated requirement' });
  runtime.canSteer.mockReturnValue(true);
  try {
    await dispatcher.tick();
    await waitAction(steer.id, 'completed');
    expect(runtime.steer).toHaveBeenCalledWith(first.sessionId, expect.objectContaining({ content: 'Use the updated requirement' }));
  } finally { release(); await waitAction(first.id, 'completed'); await waitAction(second.id, 'completed'); }
});

test('newly protected instructions never reach an ineligible active cloud CLI', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption({ pipelineId: null }));
  const action = await service().messageSession(goal.id, { requestKey: randomUUID(), sessionId, message: 'Protected material' });
  runtime.canSteer.mockReturnValue(true);
  runtime.guard.mockRejectedValue(new Error('Protection level 4 requires a local model'));
  await new CompanionDispatcher().tick();
  await waitAction(action.id, 'failed');
  expect(runtime.steer).not.toHaveBeenCalled();
  expect(runtime.guard).toHaveBeenCalled();
});

test('adopted sessions expose bounded history and live status only within their goal scope', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption({ pipelineId: null }));
  await pg.query('INSERT INTO messages(session_id,role,content) SELECT $1,\'user\',$2 FROM generate_series(1,30)', [sessionId, 'x'.repeat(6000)]);
  const detail = await service().inspectSession(goal.id, sessionId);
  expect(detail.messages).toHaveLength(20);
  expect(detail.messages.every(message => message.content.length === 4000)).toBe(true);
  expect(detail.pipelines).toMatchObject([{ id: pipelineId, status: 'running' }]);
  await expect(service().inspectSession(goal.id, otherSessionId)).rejects.toMatchObject({ code: 'not_found' });
});

test('completion cannot release work with pending actions or live workers', async () => {
  const goal = await service().createGoal(request());
  const action = await service().startSession(goal.id, { requestKey: randomUUID(), expectedRevision: 0, modelName: 'fixture-model' });
  const evidenceId = randomUUID();
  await pg.query('INSERT INTO verification_evidence(id,session_id,passed) VALUES ($1,$2,true)', [evidenceId, action.sessionId]);
  const complete = () => service().updateGoal(goal.id, { expectedRevision: 1, state: 'completed', evidence: [{ criterionIndex: 0, evidenceId, summary: 'Checked' }] });
  await expect(complete()).rejects.toMatchObject({ code: 'conflict' });
  await new CompanionDispatcher().tick(); await waitAction(action.id, 'completed');
  await pg.query("INSERT INTO agents(id,session_id,status,user_id,workspace_id) VALUES ('live-root',$1,'running',$2,$3)", [action.sessionId, userId, workspaceId]);
  await expect(complete()).rejects.toMatchObject({ code: 'conflict' });
  await pg.query("UPDATE agents SET status='completed' WHERE id='live-root'");
  expect(await complete()).toMatchObject({ state: 'completed' });
});

test('durable session pause is enforced on every dispatcher and cannot be changed through observer links', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption({ pipelineId: null }));
  await repository().controlSession(goal.id, sessionId, 'paused');
  await new CompanionDispatcher().tick();
  expect(runtime.stop).toHaveBeenCalledWith(sessionId, userId);
  const observer = await service().createGoal(request());
  await service().adoptExecution(observer.id, adoption({ pipelineId: null, ownership: 'observer' }));
  await expect(repository().controlSession(observer.id, sessionId, 'active')).rejects.toMatchObject({ code: 'not_found' });
  await repository().controlSession(goal.id, sessionId, 'active');
  expect((await pg.query('SELECT status FROM sessions WHERE id=$1', [sessionId])).rows).toEqual([{ status: 'active' }]);
});

test('execution events commit and roll back with the source transition', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption());
  const before = await pg.query('SELECT count(*)::int AS count FROM companion_events');
  await pg.exec("BEGIN; UPDATE pipelines SET status='failed'; ROLLBACK;");
  expect((await pg.query('SELECT count(*)::int AS count FROM companion_events')).rows).toEqual(before.rows);
  await pg.query("UPDATE pipelines SET status='paused',metadata='{}' WHERE id=$1", [pipelineId]);
  expect((await pg.query('SELECT source_id,state FROM companion_events WHERE kind=\'pipelines\'')).rows)
    .toEqual([{ source_id: pipelineId, state: 'paused' }]);
});

test('a committed event batch wakes the supervisor once without any browser or process-local event delivery', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption());
  await repository().saveSettings({ enabled: true, modelName: 'fixture-api', autonomy: 'observe' }, 0);
  await pg.query("UPDATE pipelines SET status='failed' WHERE id=$1", [pipelineId]);
  await pg.query("UPDATE pipelines SET status='completed' WHERE id=$1", [pipelineId]);
  await Promise.all([tickCompanionObservation(), tickCompanionObservation()]);
  await vi.waitFor(async () => expect((await pg.query('SELECT status FROM companion_wakes')).rows).toEqual([{ status: 'completed' }]));
  expect(runtime.handle).toHaveBeenCalledTimes(1);
  const prompt = runtime.handle.mock.calls[0][2];
  expect(prompt).toContain('completed');
  expect(prompt).not.toContain('"state":"failed"');
  await tickCompanionObservation(); expect(runtime.handle).toHaveBeenCalledTimes(1);
});

test('observation is opt-in and revalidates settings before the queued model turn starts', async () => {
  await service().createGoal(request());
  await tickCompanionObservation(); expect(runtime.handle).not.toHaveBeenCalled();
  await repository().saveSettings({ enabled: true, modelName: 'fixture-api' }, 0);
  runtime.handle.mockImplementationOnce(async (_session, _user, _message, _channel, _files, _mode, beforeStart) => {
    await repository().saveSettings({ enabled: false, modelName: 'fixture-api' }, 1);
    await beforeStart(); return { outcome: 'success', response: 'Should not run' };
  });
  await tickCompanionObservation();
  await vi.waitFor(async () => expect((await pg.query('SELECT status FROM companion_wakes')).rows).toEqual([{ status: 'failed' }]));
  expect(runtime.publish).not.toHaveBeenCalled();
});

test('observer settings reject shared scopes, stale edits, invalid zones and CLI supervisor models', async () => {
  await expect(repository(userId, sharedWorkspaceId).saveSettings({}, 0)).rejects.toMatchObject({ code: 'scope_unavailable' });
  await repository().saveSettings({ enabled: false }, 0);
  await expect(repository().saveSettings({ enabled: true, modelName: 'api' }, 0)).rejects.toMatchObject({ code: 'conflict' });
  await expect(repository().saveSettings({ timezone: 'Missing/Timezone' }, 1)).rejects.toMatchObject({ code: 'conflict' });
  await expect(service().saveSettings({ enabled: true, modelName: 'fixture-cli' }, 1)).rejects.toMatchObject({ code: 'conflict' });
});

test('a cancelled unstarted observation batch remains available after supervision is enabled again', async () => {
  await service().createGoal(request());
  await repository().saveSettings({ enabled: true, modelName: 'api' }, 0);
  runtime.handle.mockImplementationOnce(async (_session, _user, _message, _channel, _files, _mode, beforeStart) => {
    await repository().saveSettings({ enabled: false, modelName: 'api' }, 1);
    await beforeStart();
  });
  await tickCompanionObservation();
  await vi.waitFor(async () => expect((await pg.query('SELECT status FROM companion_wakes')).rows).toEqual([{ status: 'failed' }]));
  expect((await pg.query('SELECT count(*)::int AS n FROM companion_events WHERE consumed_at IS NULL')).rows[0]).toMatchObject({ n: expect.any(Number) });
  await repository().saveSettings({ enabled: true, modelName: 'api' }, 2);
  await tickCompanionObservation();
  await vi.waitFor(async () => expect((await pg.query("SELECT count(*)::int AS n FROM companion_wakes WHERE status='completed'")).rows).toEqual([{ n: 1 }]));
});

test('automatic coordination cannot reactivate or replace deliberately paused work', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption({ pipelineId: null }));
  await recordCompanionOwnerStop(sessionId, userId);
  expect((await pg.query('SELECT status FROM sessions WHERE id=$1', [sessionId])).rows).toEqual([{ status: 'paused' }]);
  await expect(repository().controlSession(goal.id, sessionId, 'active', true)).rejects.toMatchObject({ code: 'conflict' });
  await expect(repository().startSession(goal.id, { requestKey: randomUUID(), expectedRevision: 1, modelName: 'api' }, true)).rejects.toMatchObject({ code: 'conflict' });
  await repository().controlSession(goal.id, sessionId, 'active', false);
  expect((await pg.query('SELECT status FROM sessions WHERE id=$1', [sessionId])).rows).toEqual([{ status: 'active' }]);
});

test('stall suspicion excludes healthy commands, approval waits, provider waits and recent progress', () => {
  const input = { now: COMPANION_STALL_SILENCE_MS + 10_000, lastProgressAt: 1, commandRunning: false, awaitingApproval: false };
  expect(companionStallSuspected(input)).toBe(true);
  expect(companionStallSuspected({ ...input, commandRunning: true })).toBe(false);
  expect(companionStallSuspected({ ...input, awaitingApproval: true })).toBe(false);
  expect(companionStallSuspected({ ...input, localActivity: { lastActivityAt: 1, blockedSince: 1 } })).toBe(false);
  expect(companionStallSuspected({ ...input, localActivity: { lastActivityAt: input.now, blockedSince: null } })).toBe(false);
});

test('silent stalls create one durable inspection event per progress marker without stopping a worker', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption({ pipelineId: null }));
  await service().updateGoal(goal.id, { expectedRevision: 1, state: 'active' });
  await repository().saveSettings({ enabled: true, modelName: 'api' }, 0);
  await pg.query("INSERT INTO agents(id,user_id,workspace_id,session_id,status,created_at) VALUES ('silent',$1,$2,$3,'running',now()-interval '40 minutes')", [userId, workspaceId, sessionId]);
  runtime.worker.mockReturnValue({ getStatus: () => 'running' }); // CLI workers have no getActivity heartbeat.
  await scanCompanionStalls(Date.now(), true); await scanCompanionStalls(Date.now(), true);
  expect((await pg.query("SELECT count(*)::int AS n FROM companion_events WHERE kind='stall'")).rows).toEqual([{ n: 1 }]);
  expect(runtime.stop).not.toHaveBeenCalled();
  await pg.query("INSERT INTO tool_actions(id,agent_id,user_id,status) VALUES ($1,'silent',$2,'started')", [randomUUID(), userId]);
  await pg.query("INSERT INTO agent_events(agent_id,user_id,created_at) VALUES ('silent',$1,now()-interval '35 minutes')", [userId]);
  await scanCompanionStalls(Date.now(), true);
  expect((await pg.query("SELECT count(*)::int AS n FROM companion_events WHERE kind='stall'")).rows).toEqual([{ n: 1 }]);
  await pg.query("UPDATE tool_actions SET created_at=now()-interval '3 hours'");
  await scanCompanionStalls(Date.now(), true);
  expect((await pg.query("SELECT count(*)::int AS n FROM companion_events WHERE kind='stall'")).rows).toEqual([{ n: 2 }]);
  expect((await pg.query("SELECT state FROM companion_events WHERE state='suspected_command_outcome'")).rows).toHaveLength(1);
  expect(runtime.stop).not.toHaveBeenCalled();
});

test('idle enabled workspaces do not starve a workspace with pending observations', async () => {
  const idleIds = Array.from({ length: 51 }, () => randomUUID());
  await pg.query("INSERT INTO workspaces(id,user_id,kind) SELECT x,$1,'personal' FROM unnest($2::uuid[]) x", [userId, idleIds]);
  await pg.query("INSERT INTO companion_settings(user_id,workspace_id,enabled,model_name) SELECT $1,x,true,'api' FROM unnest($2::uuid[]) x", [userId, idleIds]);
  await service().createGoal(request());
  const settings = await repository().saveSettings({ enabled: true, modelName: 'api' }, 0);
  expect((await pg.query('SELECT pinned FROM sessions WHERE id=$1', [settings.supervisorSessionId])).rows).toEqual([{ pinned: true }]);
  await tickCompanionObservation();
  await vi.waitFor(() => expect(runtime.handle).toHaveBeenCalledTimes(1));
  expect(runtime.handle.mock.calls[0][0]).toBe(settings.supervisorSessionId);
  await vi.waitFor(async () => expect((await pg.query('SELECT status FROM companion_wakes')).rows).toEqual([{ status: 'completed' }]));
});

test('revoked automatic delegation cancels queued work without cancelling owner intent', async () => {
  const settings = await repository().saveSettings({ enabled: true, modelName: 'local', autonomy: 'coordinate' }, 0);
  const auto = new CompanionSupervisionRepository({ userId, workspaceId }, connection, { settingsId: settings.settingsId, revision: settings.revision });
  const goal = await service().createGoal(request());
  const action = await auto.startSession(goal.id, { expectedRevision: 0, requestKey: randomUUID(), modelName: 'fixture-model' }, true);
  await repository().saveSettings({ enabled: false }, settings.revision);
  await expect(auto.queueMessage(goal.id, { sessionId: action.sessionId, requestKey: randomUUID(), message: 'continue' })).rejects.toMatchObject({ code: 'conflict' });
  await new CompanionDispatcher().tick();
  expect((await service().actions(goal.id))[0]).toMatchObject({ status: 'cancelled' });
  expect(runtime.handle).not.toHaveBeenCalled();
});

test('incident recovery deduplicates blockers, bounds strategies and requires fresh scoped verification', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption({ pipelineId: null }));
  await pg.query("UPDATE pipelines SET status='paused',summary='SDK location not found' WHERE id=$1", [pipelineId]);
  const first = await service().detectIncident(goal.id, sessionId);
  expect(first).toMatchObject({ category: 'environment', state: 'observed' });
  expect((await service().detectIncident(goal.id, sessionId))?.id).toBe(first?.id);
  const repairing = await service().advanceIncident(goal.id, first!.id, { expectedRevision: 0, strategy: 'Bind writable SDK/cache runtime' });
  expect(repairing.state).toBe('repairing');
  const stale = randomUUID();
  await pg.query("INSERT INTO verification_evidence(id,session_id,passed,created_at,detail) VALUES($1,$2,true,now()-interval '1 day','{}')", [stale, sessionId]);
  await expect(service().advanceIncident(goal.id, first!.id, { expectedRevision: 1, evidenceId: stale })).rejects.toMatchObject({ code: 'invalid_evidence' });
  const evidence = randomUUID();
  await pg.query('INSERT INTO verification_evidence(id,session_id,passed,detail) VALUES($1,$2,true,$3)', [evidence, sessionId, JSON.stringify({ checkScope: `incident:${first!.id}` })]);
  expect(await service().advanceIncident(goal.id, first!.id, { expectedRevision: 1, evidenceId: evidence })).toMatchObject({ state: 'resolved', evidenceId: evidence });
  expect((await service().readGoal(goal.id)).goal.state).not.toBe('completed');
});

test('repeating a repair strategy escalates once and another user cannot read incidents', async () => {
  const goal = await service().createGoal(request());
  await service().adoptExecution(goal.id, adoption({ pipelineId: null }));
  await pg.query("UPDATE pipelines SET status='paused',summary='Permission denied (publickey)' WHERE id=$1", [pipelineId]);
  const incident = (await service().detectIncident(goal.id, sessionId))!;
  expect(incident.category).toBe('authentication');
  await service().advanceIncident(goal.id, incident.id, { expectedRevision: 0, strategy: 'Inspect trusted SSH agent' });
  expect(await service().advanceIncident(goal.id, incident.id, { expectedRevision: 1, strategy: 'Inspect trusted SSH agent' })).toMatchObject({ state: 'escalated' });
  await expect(service().advanceIncident(goal.id, incident.id, { expectedRevision: 2, strategy: 'Retry' })).rejects.toMatchObject({ code: 'conflict' });
  await expect(repository(otherUserId, otherWorkspaceId).incidents(goal.id)).rejects.toMatchObject({ code: 'not_found' });
});

test('interrupted supervisor wake reconciles without replaying an active root', async () => {
  const settings = await repository().saveSettings({ enabled: true, modelName: 'local', autonomy: 'observe' }, 0);
  await service().createGoal(request());
  const wake = randomUUID();
  await pg.query("INSERT INTO companion_wakes(id,settings_id,session_id,status,event_seqs,lease_token,lease_until) VALUES($1,$2,$3,'unknown','[]',$4,now())", [wake, settings.settingsId, settings.supervisorSessionId, randomUUID()]);
  await pg.query("INSERT INTO agents(id,session_id,status,user_id,workspace_id) VALUES('controller-root',$1,'running',$2,$3)", [settings.supervisorSessionId, userId, workspaceId]);
  await tickCompanionObservation();
  expect(runtime.handle).not.toHaveBeenCalled();
  await pg.query("UPDATE agents SET status='completed' WHERE id='controller-root'");
  await tickCompanionObservation();
  await vi.waitFor(() => expect(runtime.handle).toHaveBeenCalledTimes(1));
  expect((await pg.query<{status: string}>('SELECT status FROM companion_wakes WHERE id=$1',[wake])).rows[0].status).toBe('failed');
});

test('unknown effects are inspected and reconciled before later session work can dispatch', async () => {
  const goal = await service().createGoal(request());
  const action = await repository().startSession(goal.id, { requestKey: randomUUID(), expectedRevision: 0, modelName: 'fixture-model' });
  await pg.query("UPDATE companion_actions SET status='unknown' WHERE id=$1", [action.id]);
  const incident = (await service().detectIncident(goal.id, action.sessionId))!;
  const evidence = randomUUID();
  await pg.query('INSERT INTO verification_evidence(id,session_id,passed,detail) VALUES($1,$2,true,$3)', [evidence, action.sessionId, JSON.stringify({ checkScope: `incident:${incident.id}`, actionId: action.id, actionOutcome: 'verified_present' })]);
  await service().advanceIncident(goal.id, incident.id, { expectedRevision: 0, evidenceId: evidence });
  expect((await service().actions(goal.id))[0]).toMatchObject({ id: action.id, status: 'completed' });
  expect(runtime.handle).not.toHaveBeenCalled();
});

test('automatic repair derives incidents and each strategy permits one dispatch and one verification', async () => {
  const settings=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'repair'},0);
  const auto=new CompanionSupervisionRepository({userId,workspaceId},connection,{settingsId:settings.settingsId,revision:settings.revision});
  const goal=await service().createGoal(request());await service().adoptExecution(goal.id,adoption({pipelineId:null}));
  await pg.query("UPDATE pipelines SET status='paused',summary='SDK location not found' WHERE id=$1",[pipelineId]);
  const message=()=>auto.queueMessage(goal.id,{sessionId,requestKey:randomUUID(),message:'Repair and verify the affected runtime'});
  await expect(message()).rejects.toMatchObject({code:'conflict'});
  const incident=(await service().incidents(goal.id))[0];expect(incident.category).toBe('environment');
  await auto.advanceIncident(goal.id,incident.id,{expectedRevision:0,strategy:'Mount approved SDK/cache paths'});
  expect(await message()).toMatchObject({incidentId:incident.id,strategyIndex:1});
  await expect(message()).rejects.toMatchObject({code:'conflict'});
  expect(await auto.beginVerification(goal.id,incident.id)).toMatchObject({state:'verifying'});
  await expect(auto.beginVerification(goal.id,incident.id)).rejects.toMatchObject({code:'conflict'});
  await auto.advanceIncident(goal.id,incident.id,{expectedRevision:2,strategy:'Mount approved SDK/cache paths'});
  await expect(message()).rejects.toMatchObject({code:'conflict'});
});

test('goal dependencies reject cycles and block only dependent work', async () => {
  const prerequisite=await service().createGoal(request());const dependent=await service().createGoal(request());const independent=await service().createGoal(request());
  await service().updateGoal(dependent.id,{expectedRevision:0,dependencies:[prerequisite.id]});
  expect((await service().readGoal(dependent.id)).goal.dependencies).toEqual([prerequisite.id]);
  await expect(service().updateGoal(prerequisite.id,{expectedRevision:0,dependencies:[dependent.id]})).rejects.toMatchObject({code:'conflict'});
  await repository().startSession(dependent.id,{expectedRevision:1,requestKey:randomUUID(),modelName:'fixture-model'});
  const action=await repository().startSession(independent.id,{expectedRevision:0,requestKey:randomUUID(),modelName:'fixture-model'});
  await new CompanionDispatcher().tick();await vi.waitFor(()=>expect(runtime.handle).toHaveBeenCalledTimes(1));
  expect(runtime.handle.mock.calls[0][0]).toBe(action.sessionId);
  expect((await service().actions(dependent.id))[0]).toMatchObject({status:'queued',result:expect.stringContaining('prerequisite')});
});

test('billable token budget preserves queued state without starting another worker',async()=>{
  await repository().saveSettings({enabled:false,dailyTokenBudget:1000},0);
  const goal=await service().createGoal(request({tokenBudget:1000}));const action=await repository().startSession(goal.id,{expectedRevision:0,requestKey:randomUUID(),modelName:'fixture-model'});
  await pg.query("INSERT INTO agents(id,session_id,user_id,workspace_id,status,total_tokens,billable_tokens) VALUES('spent',$1,$2,$3,'completed',200000,1000)",[action.sessionId,userId,workspaceId]);
  await new CompanionDispatcher().tick();expect(runtime.handle).not.toHaveBeenCalled();
  expect((await service().actions(goal.id))[0]).toMatchObject({status:'queued',result:expect.stringContaining('budget exhausted')});
});

test('checkout claims serialize supervised writers and release after known completion',async()=>{
  const checkout=mkdtempSync(join(tmpdir(),'companion-checkout-'));
  const {mkdirSync}=await import('node:fs');mkdirSync(join(checkout,'.git'));
  try {
    const first=await service().createGoal(request()),second=await service().createGoal(request());
    const a=await repository().startSession(first.id,{expectedRevision:0,requestKey:randomUUID(),modelName:'fixture-model',projectPath:checkout});
    await repository().startSession(second.id,{expectedRevision:0,requestKey:randomUUID(),modelName:'fixture-model',projectPath:checkout});
    let finish!:()=>void;const blocked=new Promise<void>(resolve=>{finish=resolve;});
    runtime.handle.mockImplementationOnce(async(_s,_u,_m,_c,_f,_o,before)=>{await before();await blocked;return{outcome:'success',response:'done'};});
    const dispatcher=new CompanionDispatcher();await dispatcher.tick();await vi.waitFor(()=>expect(runtime.handle).toHaveBeenCalledTimes(1));
    expect((await service().actions(second.id))[0]).toMatchObject({status:'queued',result:expect.stringContaining('checkout')});
    finish();await vi.waitFor(async()=>expect((await service().actions(first.id))[0].status).toBe('completed'));
    await dispatcher.tick();await vi.waitFor(()=>expect(runtime.handle).toHaveBeenCalledTimes(2));
    expect(runtime.handle.mock.calls[0][0]).toBe(a.sessionId);
  }finally{rmSync(checkout,{recursive:true,force:true});}
});

test('quiet hours delay app feedback and durable notification IDs prevent duplicates',async()=>{
  const {tickCompanionFeedback}=await import('@/core/companion/feedback');
  await repository().saveSettings({enabled:true,modelName:'local',autonomy:'observe',timezone:'UTC',quietHoursStart:22,quietHoursEnd:7},0);
  const goal=await service().createGoal(request());await pg.query("UPDATE companion_goals SET state='completed' WHERE id=$1",[goal.id]);
  await tickCompanionFeedback(new Date('2026-11-05T23:00:00Z'));expect((await pg.query('SELECT id FROM notifications')).rows).toHaveLength(0);
  await tickCompanionFeedback(new Date('2026-11-06T12:00:00Z'));await tickCompanionFeedback(new Date('2026-11-06T12:00:00Z'));
  expect((await pg.query('SELECT id FROM notifications')).rows).toHaveLength(1);
});

test('running goal reservations prevent a second worker exceeding the goal cap',async()=>{
 const goal=await service().createGoal(request({tokenBudget:1000}));
 const first=await repository().startSession(goal.id,{expectedRevision:0,requestKey:randomUUID(),modelName:'fixture-model'});
 await repository().startSession(goal.id,{expectedRevision:1,requestKey:randomUUID(),modelName:'fixture-model'});
 let finish!:()=>void;const blocked=new Promise<void>(resolve=>{finish=resolve;});
 runtime.handle.mockImplementationOnce(async(_s,_u,_m,_c,_f,_o,before)=>{await before();await blocked;return{outcome:'success',response:'done'};});
 await new CompanionDispatcher().tick();await vi.waitFor(()=>expect(runtime.handle).toHaveBeenCalledTimes(1));
 expect((await service().actions(goal.id)).find(a=>a.id===first.id)?.tokenCap).toBe(1000);
 expect((await service().actions(goal.id)).filter(a=>a.status==='queued')).toHaveLength(1);
 finish();await vi.waitFor(async()=>expect((await service().actions(goal.id)).find(a=>a.id===first.id)?.status).toBe('completed'));
});

test('adopted active pipelines hold their checkout before a new dispatch claim exists',async()=>{
 const checkout=mkdtempSync(join(tmpdir(),'companion-adopted-'));try{
  const original=await service().createGoal(request());await service().adoptExecution(original.id,adoption());
  await pg.query('UPDATE sessions SET context=$1 WHERE id=$2',[JSON.stringify({devMode:true,projectPath:checkout}),sessionId]);
  const next=await service().createGoal(request());await repository().startSession(next.id,{expectedRevision:0,requestKey:randomUUID(),modelName:'fixture-model',projectPath:checkout});
  await new CompanionDispatcher().tick();expect(runtime.handle).not.toHaveBeenCalled();
  expect((await service().actions(next.id))[0]).toMatchObject({status:'queued',result:expect.stringContaining('checkout')});
 }finally{rmSync(checkout,{recursive:true,force:true});}
});

test('daily token accounting charges today’s usage from a worker started yesterday',async()=>{
 const goal=await service().createGoal(request());const action=await repository().startSession(goal.id,{expectedRevision:0,requestKey:randomUUID(),modelName:'fixture-model'});
 await pg.query("INSERT INTO agents(id,session_id,user_id,workspace_id,status,created_at,billable_tokens) VALUES('overnight',$1,$2,$3,'running',now()-interval '1 day',9000)",[action.sessionId,userId,workspaceId]);
 await pg.query("INSERT INTO cost_log(user_id,workspace_id,agent_id,session_id,input_tokens,output_tokens,cached_input_tokens) VALUES($1,$2,'overnight',$3,500,500,100)",[userId,workspaceId,action.sessionId]);
 const {companionSpend}=await import('@/core/companion/scheduling');expect(await companionSpend({userId,workspaceId},goal.id)).toBe(900);
});

test('interactive controller chats do not exhaust the unattended dispatch pool', async () => {
  const settings = await repository().saveSettings({ enabled:true,modelName:'local',autonomy:'coordinate',dailyTokenBudget:1000,turnTokenBudget:1000 },0);
  await pg.query('INSERT INTO cost_log(user_id,workspace_id,session_id,input_tokens,output_tokens) VALUES($1,$2,$3,500000,500000)',[userId,workspaceId,settings.supervisorSessionId]);
  const goal=await service().createGoal(request());
  const action=await repository().startSession(goal.id,{expectedRevision:0,requestKey:randomUUID(),modelName:'fixture-model'});
  const {companionSpend,prepareCompanionDispatch}=await import('@/core/companion/scheduling');
  expect(await companionSpend({userId,workspaceId})).toBe(0);
  expect(await db.transaction(tx=>prepareCompanionDispatch(tx as never,action,{userId,workspaceId}))).toEqual({tokenCap:null});
});

test('adoption charges new supervised work, not earlier personal execution history', async () => {
  await pg.query("INSERT INTO agents(id,session_id,user_id,workspace_id,status,billable_tokens,created_at) VALUES('personal-history',$1,$2,$3,'completed',900000,now()-interval '1 hour')",[sessionId,userId,workspaceId]);
  await pg.query("INSERT INTO cost_log(user_id,workspace_id,session_id,input_tokens,output_tokens,created_at) VALUES($1,$2,$3,900000,0,now()-interval '1 hour')",[userId,workspaceId,sessionId]);
  const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
  const {companionSpend}=await import('@/core/companion/scheduling');
  expect(await companionSpend({userId,workspaceId})).toBe(0);
  expect(await companionSpend({userId,workspaceId},goal.id)).toBe(0);
  await pg.query('INSERT INTO cost_log(user_id,workspace_id,session_id,input_tokens,output_tokens,cached_input_tokens) VALUES($1,$2,$3,500,100,100)',[userId,workspaceId,sessionId]);
  expect(await companionSpend({userId,workspaceId})).toBe(0);
  expect(await companionSpend({userId,workspaceId},goal.id)).toBe(500);
});

test('only actual background wake usage charges the controller against its daily pool', async () => {
  const settings=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'observe'},0);
  await pg.query("INSERT INTO companion_wakes(id,settings_id,session_id,status,generation,event_seqs,lease_token,lease_until,created_at,updated_at,started_at,finished_at) VALUES($1,$2,$3,'completed','','[]',$4,now(),now()-interval '20 minutes',now()-interval '5 minutes',now()-interval '10 minutes',now()-interval '5 minutes')",[randomUUID(),settings.settingsId,settings.supervisorSessionId,randomUUID()]);
  for(const [offset,tokens] of [['30 minutes',900000],['7 minutes',900],['1 minute',900000]] as const)
    await pg.query('INSERT INTO cost_log(user_id,workspace_id,session_id,input_tokens,output_tokens,created_at) VALUES($1,$2,$3,$4,0,now()-$5::interval)',[userId,workspaceId,settings.supervisorSessionId,tokens,offset]);
  expect(await(await import('@/core/companion/scheduling')).companionSpend({userId,workspaceId})).toBe(900);
});

test('blocked handoffs and failed pipelines notify once even without a model wake-up', async () => {
  await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate',quietHoursStart:0,quietHoursEnd:0},0);
  const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
  const action=await repository().queueMessage(goal.id,{requestKey:randomUUID(),sessionId,message:'Continue the existing session'});
  await pg.query("UPDATE companion_actions SET result='Waiting: token budget exhausted' WHERE id=$1",[action.id]);
  await pg.query("UPDATE pipelines SET status='failed' WHERE id=$1",[pipelineId]);
  const {tickCompanionFeedback}=await import('@/core/companion/feedback');await tickCompanionFeedback();await tickCompanionFeedback();
  const notices=(await pg.query<{title:string}>('SELECT title FROM notifications')).rows;
  expect(notices.map(row=>row.title).sort()).toEqual(['Companion handoff has not started','Companion observed a failed pipeline']);
  expect(runtime.handle).not.toHaveBeenCalled();
});

test('budget tuning preserves queued authority while changing autonomy still revokes it', async () => {
  const settings=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate'},0);
  const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
  const automatic=new CompanionSupervisionRepository({userId,workspaceId},connection,{settingsId:settings.settingsId!,revision:settings.revision});
  const action=await automatic.queueMessage(goal.id,{requestKey:randomUUID(),sessionId,message:'Continue existing work'});
  const changed=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate',dailyTokenBudget:200000},settings.revision);
  const current=(await service().actions(goal.id)).find(row=>row.id===action.id)!;
  const {companionActionAuthorized}=await import('@/core/companion/authority');
  expect(current.authorityRevision).toBe(changed.revision);expect(await companionActionAuthorized(current,{userId,workspaceId})).toBe(true);
  await repository().saveSettings({enabled:true,modelName:'local',autonomy:'observe',dailyTokenBudget:200000},changed.revision);
  expect(await companionActionAuthorized(current,{userId,workspaceId})).toBe(false);
});

test('stage reservations clamp worker slices and reserve the shared goal balance',async()=>{
 const goal=await service().createGoal(request({tokenBudget:1000}));await service().adoptExecution(goal.id,adoption());
 const {reserveCompanionStage,releaseCompanionStage}=await import('@/core/companion/scheduling');
 expect(await reserveCompanionStage({userId,workspaceId},sessionId,pipelineId,50000)).toBe(1000);
 const second=randomUUID();await pg.query('INSERT INTO pipelines(id,user_id,workspace_id,session_id) VALUES($1,$2,$3,$4)',[second,userId,workspaceId,sessionId]);
 await service().adoptExecution(goal.id,adoption({expectedRevision:1,pipelineId:second}));
 await expect(reserveCompanionStage({userId,workspaceId},sessionId,second,50000)).rejects.toThrow('exhausted');
 await releaseCompanionStage(pipelineId);expect(await reserveCompanionStage({userId,workspaceId},sessionId,second,50000)).toBe(1000);
 await releaseCompanionStage(second);
});

test('protected document refs survive delegation and permit the exact source file without opening its directory',async()=>{
 const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs');
 const source=mkdtempSync(join(tmpdir(),'companion-doc-source-')),target=mkdtempSync(join(tmpdir(),'companion-doc-target-'));
 try{
  const path=join(source,'brief.pdf');writeFileSync(path,'%PDF-1.4\nConfidential original words');writeFileSync(join(source,'unrelated.txt'),'unrelated');
  await pg.query('UPDATE sessions SET context=$1,protection_level=4,flow_label=$2 WHERE id=$3',[JSON.stringify({devMode:true,projectPath:source}),JSON.stringify({secret:'protected document'}),sessionId]);
  const input=request({sourceSessionId:sessionId,attachments:[{path:'brief.pdf',protectionLevel:4}]});
  const goal=await service().createGoal(input);expect((await service().createGoal(input)).id).toBe(goal.id);
  const action=await repository().startSession(goal.id,{requestKey:randomUUID(),expectedRevision:0,modelName:'fixture-model',projectPath:target});
  expect(action.attachments).toEqual([{path,protectionLevel:4}]);expect(action.protectionLevel).toBe(4);
  const row=(await pg.query<{context:Record<string,unknown>}>('SELECT context FROM sessions WHERE id=$1',[action.sessionId])).rows[0];
  const {WorkspaceFS}=await import('@/security/workspace-fs');
  const fs=WorkspaceFS.forSession({userId,workspaceId,context:row.context},{space:null});
  expect(readFileSync(fs.resolve(path),'utf8')).toContain('Confidential original words');
  expect(()=>fs.resolve(join(source,'unrelated.txt'))).toThrow();
  await new CompanionDispatcher().tick();await vi.waitFor(()=>expect(runtime.handle).toHaveBeenCalled());
  expect(runtime.handle.mock.calls.find(call=>call[0]===action.sessionId)?.[4]).toEqual([{path,protectionLevel:4}]);
 }finally{rmSync(source,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});}
});

test('only an explicit owner decision reopens escalation for exactly one further strategy',async()=>{
 const settings=await repository().saveSettings({enabled:false,maxRepairAttempts:3},0);
 const goal=await service().createGoal(request());await service().adoptExecution(goal.id,adoption({pipelineId:null}));
 await pg.query("UPDATE pipelines SET status='paused',summary='SDK location not found' WHERE id=$1",[pipelineId]);
 const incident=(await service().detectIncident(goal.id,sessionId))!;
 await service().advanceIncident(goal.id,incident.id,{expectedRevision:0,strategy:'First strategy'});
 await service().advanceIncident(goal.id,incident.id,{expectedRevision:1,strategy:'First strategy'});
 const auto=new CompanionSupervisionRepository({userId,workspaceId},connection,{settingsId:settings.settingsId,revision:settings.revision});
 await expect(auto.reopenIncident(goal.id,incident.id,2)).rejects.toMatchObject({code:'conflict'});
 expect(await repository().reopenIncident(goal.id,incident.id,2)).toMatchObject({state:'observed',attemptLimit:2,attemptApprovals:[{userId,additionalStrategies:1,at:expect.any(String)}]});
 await service().advanceIncident(goal.id,incident.id,{expectedRevision:3,strategy:'Second distinct strategy'});
 expect(await service().advanceIncident(goal.id,incident.id,{expectedRevision:4,strategy:'Third strategy not approved'})).toMatchObject({state:'escalated',strategies:['First strategy','Second distinct strategy']});
});


test('a depleted controller pool cannot stop a project pipeline or its instruction delivery',async()=>{
 const settings=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate',dailyTokenBudget:1000,turnTokenBudget:1000},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 const action=await repository().queueMessage(goal.id,{requestKey:randomUUID(),sessionId,message:'Continue existing execution'});
 await pg.query("INSERT INTO companion_wakes(settings_id,session_id,status,event_seqs,lease_token,lease_until,started_at,finished_at) VALUES($1,$2,'completed','[]',$3,now(),now()-interval '1 minute',now())",[settings.settingsId,settings.supervisorSessionId,randomUUID()]);
 await pg.query('INSERT INTO cost_log(user_id,workspace_id,session_id,input_tokens,output_tokens) VALUES($1,$2,$3,2000,0)',[userId,workspaceId,settings.supervisorSessionId]);
 // Put the cost inside the completed wake rather than just after its end.
 await pg.query("UPDATE cost_log SET created_at=now()-interval '30 seconds'");
 const {companionRemainingBudget,reserveCompanionStage,prepareCompanionDispatch}=await import('@/core/companion/scheduling');
 expect(await companionRemainingBudget({userId,workspaceId})).toBe(0);
 expect(await companionRemainingBudget({userId,workspaceId},goal.id)).toBe(Infinity);
 expect(await reserveCompanionStage({userId,workspaceId},sessionId,pipelineId,500000)).toBeUndefined();
 expect(await db.transaction(tx=>prepareCompanionDispatch(tx as never,action,{userId,workspaceId}))).toEqual({tokenCap:null});
});

test('queued or interrupted observations do not charge unrelated interactive usage',async()=>{
 const settings=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'observe'},0);
 const wake=randomUUID();
 await pg.query("INSERT INTO companion_wakes(id,settings_id,session_id,status,event_seqs,lease_token,lease_until,created_at) VALUES($1,$2,$3,'running','[]',$4,now()+interval '1 minute',now()-interval '10 minutes')",[wake,settings.settingsId,settings.supervisorSessionId,randomUUID()]);
 await pg.query('INSERT INTO cost_log(user_id,workspace_id,session_id,input_tokens,output_tokens) VALUES($1,$2,$3,200000,0)',[userId,workspaceId,settings.supervisorSessionId]);
 const {companionSpend}=await import('@/core/companion/scheduling');expect(await companionSpend({userId,workspaceId})).toBe(0);
 await pg.query("UPDATE companion_wakes SET status='unknown',started_at=now()-interval '5 minutes',finished_at=now()-interval '1 minute' WHERE id=$1",[wake]);
 expect(await companionSpend({userId,workspaceId})).toBe(0);
});

test('failed-pipeline feedback ignores metadata changes and superseded whole-session runs',async()=>{
 await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate',quietHoursStart:0,quietHoursEnd:0},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await pg.query("UPDATE pipelines SET status='failed' WHERE id=$1",[pipelineId]);
 const {tickCompanionFeedback}=await import('@/core/companion/feedback');await tickCompanionFeedback();
 await pg.query("UPDATE pipelines SET updated_at=now()+interval '1 minute',metadata='{}' WHERE id=$1",[pipelineId]);await tickCompanionFeedback();
 expect((await pg.query('SELECT id FROM notifications')).rows).toHaveLength(1);
 await pg.query("DELETE FROM notifications");
 const newer=randomUUID();await pg.query("INSERT INTO pipelines(id,user_id,workspace_id,session_id,status,created_at) VALUES($1,$2,$3,$4,'completed',now()+interval '1 minute')",[newer,userId,workspaceId,sessionId]);
 await tickCompanionFeedback();expect((await pg.query('SELECT id FROM notifications')).rows).toHaveLength(0);
 await pg.query('UPDATE companion_session_links SET pipeline_id=$1 WHERE goal_id=$2',[pipelineId,goal.id]);
 await tickCompanionFeedback();expect((await pg.query('SELECT id FROM notifications')).rows).toHaveLength(1);
});

test('a stale cancellation snapshot cannot revoke an action migrated by resource tuning',async()=>{
 const settings=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate'},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 const automatic=new CompanionSupervisionRepository({userId,workspaceId},connection,{settingsId:settings.settingsId!,revision:settings.revision});
 const action=await automatic.queueMessage(goal.id,{requestKey:randomUUID(),sessionId,message:'Continue existing work'});
 await pg.query('UPDATE companion_settings SET reconciled_revision=revision');await pg.query('UPDATE companion_events SET consumed_at=now()');
 const authority=await import('@/core/companion/authority');
 const check=vi.spyOn(authority,'companionActionAuthorized').mockImplementationOnce(async()=>{
   await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate',dailyTokenBudget:200000},settings.revision);
   return false;
 });
 try{await new CompanionDispatcher().tick();expect((await service().actions(goal.id)).find(row=>row.id===action.id)?.status).not.toBe('cancelled');}
 finally{check.mockRestore();}
});


test('one owner turn can extend an incident only once, including after another exhaustion',async()=>{
 await repository().saveSettings({enabled:false,maxRepairAttempts:1},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await pg.query("UPDATE pipelines SET status='failed',summary='Device unavailable' WHERE id=$1",[pipelineId]);
 const incident=(await service().detectIncident(goal.id,sessionId))!;
 await repository().advanceIncident(goal.id,incident.id,{expectedRevision:0,strategy:'Initial inspection'});
 await repository().advanceIncident(goal.id,incident.id,{expectedRevision:1,strategy:'Additional inspection'});
 const turn='owner-message-one';
 expect(await repository().reopenIncident(goal.id,incident.id,2,turn)).toMatchObject({state:'observed',attemptAllowance:1});
 expect(await repository().reopenIncident(goal.id,incident.id,2,turn)).toMatchObject({state:'observed',attemptAllowance:1});
 await repository().advanceIncident(goal.id,incident.id,{expectedRevision:3,strategy:'Owner requested fresh device inspection'});
 await repository().advanceIncident(goal.id,incident.id,{expectedRevision:4,strategy:'Unapproved next attempt'});
 expect(await repository().reopenIncident(goal.id,incident.id,5,turn)).toMatchObject({state:'escalated',attemptAllowance:1});
 expect(await repository().reopenIncident(goal.id,incident.id,5,'owner-message-two')).toMatchObject({state:'observed',attemptAllowance:2});
});


test('changed diagnostic classification preserves the incident and prepared strategy',async()=>{
 const settings=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate'},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await pg.query("UPDATE pipelines SET status='failed',summary='Review did not pass' WHERE id=$1",[pipelineId]);
 const first=(await repository().detectIncident(goal.id,sessionId))!;
 await repository().advanceIncident(goal.id,first.id,{expectedRevision:0,strategy:'Investigate gateway health in affected runtime'});
 await pg.query("UPDATE pipelines SET summary='Device not found; gateway runtime unavailable' WHERE id=$1",[pipelineId]);
 expect((await repository().detectIncident(goal.id,sessionId))?.id).toBe(first.id);
 const automatic=new CompanionSupervisionRepository({userId,workspaceId},connection,{settingsId:settings.settingsId!,revision:settings.revision});
 const action=await automatic.queueMessage(goal.id,{requestKey:randomUUID(),sessionId,incidentId:first.id,message:'Inspect the gateway'});
 expect(action).toMatchObject({incidentId:first.id,strategyIndex:1,status:'queued'});
 expect(await repository().incidents(goal.id)).toHaveLength(1);
});

test('legacy category fingerprints are reused when the diagnostic category changes',async()=>{
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await pg.query("UPDATE pipelines SET status='failed',summary='Device not found' WHERE id=$1",[pipelineId]);
 const {createHash}=await import('node:crypto');const legacy=randomUUID();
 await pg.query("INSERT INTO companion_incidents(id,goal_id,session_id,fingerprint,category,summary,state,strategies) VALUES($1,$2,$3,$4,'execution','Earlier failure','repairing','[\"Inspect runtime\"]')",[legacy,goal.id,sessionId,createHash('sha256').update(`${pipelineId}:execution`).digest('hex')]);
 expect((await repository().detectIncident(goal.id,sessionId))?.id).toBe(legacy);
 expect(await repository().incidents(goal.id)).toHaveLength(1);
});

test('pinned prepared incidents cannot be replaced by newer observed incidents or cross-session pins',async()=>{
 const settings=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate'},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await pg.query("UPDATE pipelines SET status='failed',summary='Device not found' WHERE id=$1",[pipelineId]);
 const prepared=(await repository().detectIncident(goal.id,sessionId))!;
 await repository().advanceIncident(goal.id,prepared.id,{expectedRevision:0,strategy:'Check deployed gateway'});
 const extra=randomUUID();await pg.query("INSERT INTO companion_incidents(id,goal_id,session_id,fingerprint,category,summary,created_at) VALUES($1,$2,$3,$4,'execution','Other observed blocker',now()+interval '1 minute')",[extra,goal.id,sessionId,randomUUID()]);
 const automatic=new CompanionSupervisionRepository({userId,workspaceId},connection,{settingsId:settings.settingsId!,revision:settings.revision});
 await expect(automatic.queueMessage(goal.id,{requestKey:randomUUID(),sessionId,message:'Check runtime'})).rejects.toThrow(`Incident ${extra} is observed at revision 0`);
 const key=randomUUID(),input={requestKey:key,sessionId,incidentId:prepared.id,message:'Check runtime'};
 const action=await automatic.queueMessage(goal.id,input);expect(action.incidentId).toBe(prepared.id);
 expect((await automatic.queueMessage(goal.id,input)).id).toBe(action.id);
 await expect(automatic.queueMessage(goal.id,{...input,incidentId:extra})).rejects.toThrow('different session action');
 await expect(automatic.queueMessage(goal.id,{...input,requestKey:randomUUID(),incidentId:randomUUID()})).rejects.toMatchObject({code:'not_found'});
});


test('maintenance follow-ups retain the affected project incident rather than requiring its session ID',async()=>{
 const settings=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'repair'},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await pg.query("UPDATE pipelines SET status='failed',summary='SDK location not found' WHERE id=$1",[pipelineId]);
 const incident=(await repository().detectIncident(goal.id,sessionId))!;
 await repository().advanceIncident(goal.id,incident.id,{expectedRevision:0,strategy:'Repair the registered runtime'});
 const maintenance=randomUUID();
 await pg.query('INSERT INTO sessions(id,user_id,workspace_id,context) VALUES($1,$2,$3,$4)',[maintenance,userId,workspaceId,JSON.stringify({companionMaintenance:{incidentId:incident.id,binding:'fixture',authorityRevision:settings.revision}})]);
 await pg.query("INSERT INTO companion_session_links(goal_id,session_id,purpose,origin,ownership) VALUES($1,$2,'Runtime repair','created','owner')",[goal.id,maintenance]);
 const automatic=new CompanionSupervisionRepository({userId,workspaceId},connection,{settingsId:settings.settingsId!,revision:settings.revision});
 await expect(automatic.queueMessage(goal.id,{requestKey:randomUUID(),sessionId:maintenance,incidentId:randomUUID(),message:'Follow up'})).rejects.toThrow('retain its bound incident');
 const action=await automatic.queueMessage(goal.id,{requestKey:randomUUID(),sessionId:maintenance,incidentId:incident.id,message:'Follow up'});
 expect(action).toMatchObject({incidentId:incident.id,strategyIndex:1});
 await pg.query("UPDATE companion_actions SET status='unknown' WHERE id=$1",[action.id]);
 await expect(automatic.queueMessage(goal.id,{requestKey:randomUUID(),sessionId:maintenance,incidentId:incident.id,message:'Inspect again'})).rejects.toThrow('reconcile the uncertain action');
});

test('pinning a prepared incident cannot bypass an interrupted action receipt',async()=>{
 const settings=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate'},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await pg.query("UPDATE pipelines SET status='failed',summary='Device unavailable' WHERE id=$1",[pipelineId]);
 const incident=(await repository().detectIncident(goal.id,sessionId))!;
 await repository().advanceIncident(goal.id,incident.id,{expectedRevision:0,strategy:'Inspect the device'});
 const interrupted=await repository().queueMessage(goal.id,{requestKey:randomUUID(),sessionId,message:'Earlier owner instruction'});
 await pg.query("UPDATE companion_actions SET status='unknown' WHERE id=$1",[interrupted.id]);
 const automatic=new CompanionSupervisionRepository({userId,workspaceId},connection,{settingsId:settings.settingsId!,revision:settings.revision});
 await expect(automatic.queueMessage(goal.id,{requestKey:randomUUID(),sessionId,incidentId:incident.id,message:'Continue the repair'})).rejects.toThrow('reconcile the uncertain action');
});


test('a new failure after resolution in the same pipeline gets a new incident',async()=>{
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await pg.query("UPDATE pipelines SET status='failed',summary='SDK location not found' WHERE id=$1",[pipelineId]);
 const first=(await repository().detectIncident(goal.id,sessionId))!;
 await pg.query("UPDATE companion_incidents SET state='resolved',updated_at=now() WHERE id=$1",[first.id]);
 // Without a new attempt, text changes still refer to the resolved source.
 await pg.query("UPDATE pipelines SET summary='Device not found' WHERE id=$1",[pipelineId]);
 expect((await repository().detectIncident(goal.id,sessionId))?.id).toBe(first.id);
 await pg.query("UPDATE pipelines SET status='running' WHERE id=$1",[pipelineId]);
 await pg.query("UPDATE pipelines SET status='failed',summary='Database not found' WHERE id=$1",[pipelineId]);
 const next=(await repository().detectIncident(goal.id,sessionId))!;
 expect(next.id).not.toBe(first.id);expect(next.state).toBe('observed');
});


test('paused pipeline bookkeeping events do not replace a prepared incident',async()=>{
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await pg.query("UPDATE pipelines SET status='paused',summary='Review did not pass' WHERE id=$1",[pipelineId]);
 const first=(await repository().detectIncident(goal.id,sessionId))!;
 await repository().advanceIncident(goal.id,first.id,{expectedRevision:0,strategy:'Inspect runtime prerequisites'});
 await pg.query("UPDATE pipelines SET summary='Device not found',current_node_key='qa' WHERE id=$1",[pipelineId]);
 expect((await repository().detectIncident(goal.id,sessionId))?.id).toBe(first.id);
 expect(await repository().incidents(goal.id)).toHaveLength(1);
});

test('briefing requests fail closed without a configured supervisor and never consume a repair strategy',async()=>{
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await expect(repository().requestBriefing(goal.id,{sessionId,requestKey:randomUUID()})).rejects.toThrow('Configure and enable');
 await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate'},0);
 await pg.query("UPDATE pipelines SET status='failed',summary='Device not found' WHERE id=$1",[pipelineId]);
 const incident=(await repository().detectIncident(goal.id,sessionId))!;
 await pg.query("UPDATE companion_incidents SET state='escalated' WHERE id=$1",[incident.id]);
 const input={sessionId,requestKey:randomUUID()};const brief=await repository().requestBriefing(goal.id,input);
 expect(brief).toMatchObject({kind:'request_briefing',incidentId:null,strategyIndex:null});
 expect(brief.message).toContain('READ ONLY');expect(brief.message).toContain('actual deployment hosts');
 expect((await repository().requestBriefing(goal.id,input)).id).toBe(brief.id);
 expect((await repository().requestBriefing(goal.id,{sessionId,requestKey:randomUUID()})).id).toBe(brief.id);
 expect((await repository().incidents(goal.id))[0]).toMatchObject({state:'escalated',strategies:[]});
});

test('known context needs no mandatory briefing and one saved briefing survives routine changes',async()=>{
 const settings=await repository().saveSettings({enabled:true,modelName:'local',autonomy:'coordinate'},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 const auto=new CompanionSupervisionRepository({userId,workspaceId},connection,{settingsId:settings.settingsId!,revision:settings.revision,requireBriefing:true});
 expect(await auto.queueMessage(goal.id,{requestKey:randomUUID(),sessionId,message:'Check the known external gateway'})).toMatchObject({status:'queued'});
 const brief=await auto.requestBriefing(goal.id,{sessionId,requestKey:randomUUID()});
 await pg.query("UPDATE companion_actions SET status='completed',result='External deployment host; Appwrite intermediary' WHERE id=$1",[brief.id]);
 expect((await auto.requestBriefing(goal.id,{sessionId,requestKey:randomUUID()})).id).toBe(brief.id);
 await pg.query("INSERT INTO messages(session_id,role,content,metadata) VALUES($1,'user','Automated observation','{\"trigger\":\"monitor\"}')",[sessionId]);
 expect((await auto.requestBriefing(goal.id,{sessionId,requestKey:randomUUID()})).id).toBe(brief.id);
 expect(await auto.queueMessage(goal.id,{requestKey:randomUUID(),sessionId,briefingId:brief.id,message:'Check the documented external host'})).toMatchObject({status:'queued'});
 await pg.query("INSERT INTO messages(session_id,role,content,metadata) VALUES($1,'user','Architecture changed','{\"trigger\":\"user\"}')",[sessionId]);
 expect(await auto.queueMessage(goal.id,{requestKey:randomUUID(),sessionId,briefingId:brief.id,message:'Inspect the changed facts'})).toMatchObject({status:'queued'});
 expect((await auto.requestBriefing(goal.id,{sessionId,requestKey:randomUUID()})).id).toBe(brief.id);
});

test('briefing dispatch uses a read-only API binding and preserves the complete source report',async()=>{
 await repository().saveSettings({enabled:true,modelName:'api-supervisor',autonomy:'coordinate'},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 const brief=await repository().requestBriefing(goal.id,{sessionId,requestKey:randomUUID()});
 await pg.query('UPDATE companion_settings SET reconciled_revision=revision');await pg.query('UPDATE companion_events SET consumed_at=now()');
 runtime.model.mockResolvedValue({name:'api-supervisor',modelId:'deepseek',provider:'openrouter',supportsTools:true});
 const text='External Appwrite deployment. '+'x'.repeat(12000);
 runtime.handle.mockImplementationOnce(async(...args)=>{expect(args[10]).toEqual({companionBriefing:true,companionBriefingModel:'api-supervisor',companionBriefingBudget:1000000});await args[6]();return{outcome:'success',response:text};});
 await new CompanionDispatcher().tick();await vi.waitFor(async()=>expect((await repository().actions(goal.id)).find(action=>action.id===brief.id)?.status).toBe('completed'));
 expect((await repository().actions(goal.id)).find(action=>action.id===brief.id)?.result).toBe(text);
});

test('a queued briefing rejects a CLI-only binding before starting the session',async()=>{
 await repository().saveSettings({enabled:true,modelName:'cli-source',autonomy:'coordinate'},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 const brief=await repository().requestBriefing(goal.id,{sessionId,requestKey:randomUUID()});
 await pg.query('UPDATE companion_settings SET reconciled_revision=revision');await pg.query('UPDATE companion_events SET consumed_at=now()');
 await new CompanionDispatcher().tick();await vi.waitFor(async()=>expect((await repository().actions(goal.id)).find(action=>action.id===brief.id)?.status).toBe('cancelled'));
 expect(runtime.handle).not.toHaveBeenCalled();
});

test('full reports page consistently, retain provenance, and respect clears and workspace scope',async()=>{
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 const messageId=randomUUID(),body='x'.repeat(4500)+'Appwrite is on the external host.'+'y'.repeat(6000);
 await pg.query("INSERT INTO messages(id,session_id,role,content) VALUES($1,$2,'assistant',$3)",[messageId,sessionId,body]);
 const first=await repository().readReport(goal.id,sessionId,{offset:0,limit:4000});
 expect(first.totalChars).toBe(body.length);expect(first.continuation).toEqual({messageId,offset:4000});
 await pg.query("INSERT INTO messages(session_id,role,content,created_at) VALUES($1,'assistant','A newer report',now()+interval '1 second')",[sessionId]);
 const next=await repository().readReport(goal.id,sessionId,{...first.continuation!,limit:8000});
 expect(next.reportId).toBe(messageId);expect(next.text).toContain('Appwrite');expect(next.nextOffset).toBeNull();
 await expect(repository(otherUserId,otherWorkspaceId).readReport(goal.id,sessionId,{offset:0,limit:8000})).rejects.toMatchObject({code:'not_found'});
 const action=await repository().queueMessage(goal.id,{sessionId,requestKey:randomUUID(),message:'Earlier private work'});
 await pg.query("UPDATE companion_actions SET status='completed',result='Protected report',protection_level=4,flow_label='{\"secret\":\"retained\"}' WHERE id=$1",[action.id]);
 expect(await repository().readReport(goal.id,sessionId,{actionId:action.id,offset:0,limit:8000})).toMatchObject({text:'Protected report',protectionLevel:4,flowLabel:{secret:'retained'}});
 await pg.query('UPDATE sessions SET context=$1 WHERE id=$2',[JSON.stringify({clearedAt:new Date().toISOString(),conversationGeneration:randomUUID()}),sessionId]);
 await expect(repository().readReport(goal.id,sessionId,{messageId,offset:0,limit:8000})).rejects.toMatchObject({code:'not_found'});
});

test('routine work-plan status updates keep the cached architecture briefing',async()=>{
 await repository().saveSettings({enabled:true,modelName:'api',autonomy:'coordinate'},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 const {emptyWorkPlan,reviseWorkPlan,planUpdateSchema}=await import('@/shared/work-plan');
 const plan=reviseWorkPlan(emptyWorkPlan(),planUpdateSchema.parse({revision:0,title:'Project',goal:'External gateway with Appwrite intermediary',summary:'Approved external architecture',steps:[{id:'check',title:'Verify gateway',status:'pending'}]}));
 await pg.query('UPDATE sessions SET metadata=$1 WHERE id=$2',[JSON.stringify({workPlan:plan}),sessionId]);
 const first=await repository().requestBriefing(goal.id,{sessionId,requestKey:randomUUID()});
 await pg.query("UPDATE companion_actions SET status='completed',result='Architecture summary' WHERE id=$1",[first.id]);
 plan.current!.revision++;plan.current!.steps[0].status='done';plan.current!.steps[0].evidence='Gate passed';
 await pg.query('UPDATE sessions SET metadata=$1 WHERE id=$2',[JSON.stringify({workPlan:plan}),sessionId]);
 expect((await repository().requestBriefing(goal.id,{sessionId,requestKey:randomUUID()})).id).toBe(first.id);
 plan.current!.goal='Architecture changed to another documented deployment target';
 await pg.query('UPDATE sessions SET metadata=$1 WHERE id=$2',[JSON.stringify({workPlan:plan}),sessionId]);
 expect((await repository().requestBriefing(goal.id,{sessionId,requestKey:randomUUID()})).id).toBe(first.id);
 expect((await repository().requestBriefing(goal.id,{sessionId,requestKey:randomUUID(),refresh:true})).id).not.toBe(first.id);
});

test('briefing coordination is budgeted without restricting ordinary project execution',async()=>{
 await repository().saveSettings({enabled:true,modelName:'api',autonomy:'coordinate',dailyTokenBudget:1000,turnTokenBudget:1000},0);
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await pg.query("INSERT INTO cost_log(user_id,workspace_id,session_id,input_tokens,output_tokens,request_type) VALUES($1,$2,$3,1000,0,'companion-briefing')",[userId,workspaceId,sessionId]);
 const instruction=await repository().queueMessage(goal.id,{sessionId,requestKey:randomUUID(),message:'Authorized project work'});
 const brief=await repository().requestBriefing(goal.id,{sessionId,requestKey:randomUUID()});
 const {prepareCompanionDispatch}=await import('@/core/companion/scheduling');
 expect(await db.transaction(tx=>prepareCompanionDispatch(tx as never,instruction,{userId,workspaceId}))).toEqual({tokenCap:null});
 expect(await db.transaction(tx=>prepareCompanionDispatch(tx as never,brief,{userId,workspaceId}))).toBeUndefined();
 expect((await repository().actions(goal.id)).find(action=>action.id===brief.id)?.result).toContain('briefing budget exhausted');
});

test('successful briefing helpers cannot hide a failed standalone project execution',async()=>{
 const goal=await service().createGoal(request());await repository().adopt(goal.id,adoption({pipelineId:null}));
 await pg.query('DELETE FROM pipelines WHERE id=$1',[pipelineId]);
 await pg.query("INSERT INTO agents(id,session_id,user_id,workspace_id,status,role,error,metadata) VALUES('failed-project',$1,$2,$3,'failed','general','SDK location not found','{\"root\":true}')",[sessionId,userId,workspaceId]);
 const first=(await repository().detectIncident(goal.id,sessionId))!;
 await pg.query("INSERT INTO agents(id,session_id,user_id,workspace_id,status,role,metadata,created_at) VALUES('brief-helper',$1,$2,$3,'completed','general','{\"root\":true,\"companionBriefing\":true}',now()+interval '1 minute')",[sessionId,userId,workspaceId]);
 expect((await repository().detectIncident(goal.id,sessionId))?.id).toBe(first.id);
 expect((await repository().inspectSession(goal.id,sessionId)).workers[0].id).toBe('failed-project');
 expect((await repository().readSession(sessionId)).workers[0].id).toBe('failed-project');
});


test('choosing an interactive Companion model creates its chat without enabling background work',async()=>{
 const saved=await repository().saveSettings({enabled:false,modelName:'api',autonomy:'observe'},0);
 expect(saved.enabled).toBe(false);expect(saved.supervisorSessionId).toBeTruthy();
 const again=await repository().saveSettings({enabled:false,modelName:'api',autonomy:'observe'},saved.revision);
 expect(again.supervisorSessionId).toBe(saved.supervisorSessionId);
});

test('Companion does not request introductory briefings for sessions it created',async()=>{
 await repository().saveSettings({enabled:true,modelName:'api',autonomy:'coordinate'},0);
 const goal=await service().createGoal(request());
 const created=await repository().startSession(goal.id,{requestKey:randomUUID(),modelName:'api',expectedRevision:goal.revision});
 await expect(repository().requestBriefing(goal.id,{sessionId:created.sessionId,requestKey:randomUUID()})).rejects.toThrow('already has its starting context');
});
