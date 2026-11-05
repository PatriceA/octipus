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
      kind text DEFAULT 'pre_verify', stage text, node_id text, detail jsonb, created_at timestamptz DEFAULT now());
    CREATE TABLE agents(id text PRIMARY KEY, session_id uuid, status text, user_id text, workspace_id uuid, role text, model text, error text, parent_agent_id text, created_at timestamptz DEFAULT now());
    CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, role text, content text, created_at timestamptz DEFAULT now());
    ALTER TABLE pipelines ADD COLUMN title text;
    ALTER TABLE pipelines ADD COLUMN summary text;
    ALTER TABLE pipelines ADD COLUMN current_node_key text;
    ALTER TABLE pipelines ADD COLUMN created_at timestamptz DEFAULT now();
    ALTER TABLE pipelines ADD COLUMN metadata jsonb DEFAULT '{}';
    CREATE TABLE agent_events(id serial PRIMARY KEY,agent_id text,user_id text,created_at timestamptz DEFAULT now());
    CREATE TABLE tool_actions(id uuid PRIMARY KEY,agent_id text,user_id text,status text,created_at timestamptz DEFAULT now());
    CREATE TABLE permission_requests(id uuid PRIMARY KEY,agent_id text,status text,expires_at timestamptz);
  `);
  await pg.exec(readFileSync('src/db/migrations/0160_companion_supervision.sql', 'utf8'));
  await pg.exec(readFileSync('src/db/migrations/0161_companion_actions.sql', 'utf8'));
  await pg.exec(readFileSync('src/db/migrations/0162_companion_observation.sql', 'utf8'));
  db = drizzle(pg);
  runtime.db = db;
}, 30_000);
afterAll(async () => { await pg.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  await pg.exec('TRUNCATE companion_wakes,companion_events,companion_settings,companion_actions, companion_session_links, companion_goals, verification_evidence, tasks, pipelines, sessions, workspaces, users, agents, messages,agent_events,tool_actions,permission_requests CASCADE');
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
