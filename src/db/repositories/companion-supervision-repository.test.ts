import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { getDb } from '@/db/postgres';
import { CompanionService } from '@/core/companion/service';
import { CompanionSupervisionRepository } from './companion-supervision-repository';

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
      group_channel_id uuid, protection_level smallint, metadata jsonb DEFAULT '{}', status text DEFAULT 'active');
    CREATE TABLE pipelines(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), workspace_id uuid, session_id uuid NOT NULL REFERENCES sessions(id), status text DEFAULT 'running');
    CREATE TABLE tasks(id uuid PRIMARY KEY, user_id uuid REFERENCES users(id), workspace_id uuid);
    CREATE TABLE verification_evidence(id uuid PRIMARY KEY, session_id uuid, pipeline_id uuid, passed boolean,
      kind text DEFAULT 'pre_verify', stage text, node_id text, detail jsonb, created_at timestamptz DEFAULT now());
  `);
  await pg.exec(readFileSync('src/db/migrations/0160_companion_supervision.sql', 'utf8'));
  db = drizzle(pg);
}, 30_000);
afterAll(async () => { await pg.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  await pg.exec('TRUNCATE companion_session_links, companion_goals, verification_evidence, tasks, pipelines, sessions, workspaces, users CASCADE');
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
