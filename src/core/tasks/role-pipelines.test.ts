/**
 * A role agent working its tasks through a pipeline template, over embedded
 * PGlite: the board protocol (checkout, comments, done or handed back) is the
 * server's, so it is asserted on the task rows. The pipeline run itself is
 * stubbed at `createAndRunPipeline` — the walker has its own suites.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '44444444-4444-4444-4444-444444444444';

let queryRaw: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
let executeRaw: (sql: string) => Promise<unknown>;
let mod: typeof import('./role-pipelines');
let hookId: string;
let sessionId: string;
/** What the stubbed run ends as; `throw` makes it fail before it starts. */
let ending: { status: string; summary: string } | 'throw';
let runs: Array<{ title: string; type: string; description: string; context: AgentContext }>;

async function addTask(title: string, notes: string | null = null, role = 'coding'): Promise<string> {
  const id = randomUUID();
  await executeRaw(
    `INSERT INTO tasks (id, user_id, title, notes, status, priority, assignee_kind, assignee_ref)
     VALUES ('${id}', '${userId}', '${title}', ${notes ? `'${notes}'` : 'NULL'}, 'open', 0, 'role', '${role}')`,
  );
  return id;
}

async function task(id: string) {
  const { rows } = await queryRaw(`SELECT status, assignee_kind, assignee_ref, checked_out_by FROM tasks WHERE id = '${id}'`);
  return rows[0];
}

async function comments(id: string): Promise<string[]> {
  const { rows } = await queryRaw(`SELECT body FROM task_comments WHERE task_id = '${id}' ORDER BY created_at, id`);
  return rows.map((r) => String(r.body));
}

const turn = () => mod.runRoleTaskPipeline({ hookId, role: 'coding', templateRef: 'Role Flow', sessionId, userId });

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-role-pipelines-'));
  const pg = await import('@/db/postgres');
  await pg.initializeDb();
  queryRaw = pg.queryRaw as typeof queryRaw;
  executeRaw = pg.executeRaw as typeof executeRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'role-pipeline-user' }]);

  const steps = JSON.stringify([{ name: 'Do', topic: 'coding', requiresApproval: false }]);
  await executeRaw(`INSERT INTO pipeline_templates (user_id, name, is_preset, steps) VALUES (NULL, 'Role Flow', true, '${steps}'::jsonb)`);

  const { getModelRegistry } = await import('@/models/model-registry');
  vi.spyOn(getModelRegistry(), 'getDefaultModel').mockResolvedValue({ modelId: 'test-model', name: 'test' } as never);

  const { getAgentService } = await import('@/core/agent');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const finished = new Map<string, { status: string; summary: string }>();
  vi.spyOn(getAgentService(), 'createAndRunPipeline').mockImplementation((async (
    title: string, type: string, description: string, context: AgentContext, options?: { onCreated?: (id: string) => void },
  ) => {
    runs.push({ title, type, description, context });
    if (ending === 'throw') throw new Error('Unknown pipeline template "Role Flow"');
    const id = randomUUID();
    finished.set(id, ending);
    options?.onCreated?.(id);
    return { pipelineId: id, result: ending.summary };
  }) as never);
  vi.spyOn(pipelineRepository, 'findById').mockImplementation((async (id: string) => {
    const end = finished.get(id);
    return end ? { id, ...end } : null;
  }) as never);

  mod = await import('./role-pipelines');
});

afterAll(async () => {
  vi.restoreAllMocks();
  const pg = await import('@/db/postgres');
  await pg.closeDb();
});

beforeEach(async () => {
  await executeRaw(`DELETE FROM task_comments`);
  await executeRaw(`DELETE FROM tasks`);
  await executeRaw(`DELETE FROM notifications`);
  await executeRaw(`DELETE FROM hooks`);
  sessionId = randomUUID();
  hookId = randomUUID();
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  await executeRaw(
    `INSERT INTO hooks (id, user_id, name, trigger, trigger_config, action, action_config, is_enabled, next_run_at)
     VALUES ('${hookId}', '${userId}', 'Heartbeat (coding)', 'heartbeat', '{"role":"coding","pipelineTemplate":"Role Flow"}', 'spawn_agent', '{}', true, '${later}')`,
  );
  runs = [];
  ending = { status: 'completed', summary: 'Shipped the login fix.' };
});

describe('a pipeline role agent', () => {
  test('runs the task through the template, unattended, and closes it with the run summary', async () => {
    const id = await addTask('Fix the login page', 'It 500s on empty passwords');
    const result = await turn();
    expect(result).toMatchObject({ success: true, data: { taskId: id, status: 'completed' } });
    expect(runs).toHaveLength(1);
    expect(runs[0].type).toBe('Role Flow');
    expect(runs[0].description).toContain('Fix the login page');
    expect(runs[0].description).toContain('It 500s on empty passwords');
    expect(runs[0].context.attended).toBe(false);
    expect(runs[0].context.sessionId).toBe(sessionId);
    expect(await task(id)).toMatchObject({ status: 'done' });
    const said = await comments(id);
    expect(said[0]).toContain('Started pipeline "Role Flow"');
    expect(said.at(-1)).toContain('Shipped the login fix.');
    // The hook's session exists for the run to live in.
    const { rows } = await queryRaw(`SELECT channel_type FROM sessions WHERE id = '${sessionId}'`);
    expect(rows[0].channel_type).toBe('heartbeat');
  });

  test('a run that did not finish hands the task back to its owner, says why, and notifies them', async () => {
    ending = { status: 'paused', summary: 'Nobody answered the plan approval in time.' };
    const id = await addTask('Write the launch post');
    await turn();
    expect(await task(id)).toMatchObject({ status: 'open', assignee_kind: 'user', assignee_ref: userId, checked_out_by: null });
    expect((await comments(id)).at(-1)).toContain('paused: Nobody answered the plan approval');
    const { rows } = await queryRaw(`SELECT type, title FROM notifications WHERE user_id = '${userId}'`);
    expect(rows).toEqual([{ type: 'task_needs_you', title: 'Task needs you: Write the launch post' }]);
    // Not picked up again: it is no longer the role's.
    runs = [];
    await turn();
    expect(runs).toHaveLength(0);
  });

  test('a run that fails to start is handed back the same way', async () => {
    ending = 'throw';
    const id = await addTask('Set up the newsletter');
    await turn();
    expect(await task(id)).toMatchObject({ status: 'open', assignee_kind: 'user' });
    expect((await comments(id)).at(-1)).toContain('Unknown pipeline template');
  });

  test('one task per turn; with more ready the hook is due again at once', async () => {
    const first = await addTask('First idea');
    const second = await addTask('Second idea');
    await turn();
    expect(runs).toHaveLength(1);
    const done = [await task(first), await task(second)].filter((t) => t.status === 'done');
    expect(done).toHaveLength(1);
    const { rows } = await queryRaw(`SELECT next_run_at FROM hooks WHERE id = '${hookId}'`);
    expect(new Date(String(rows[0].next_run_at)).getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('a task another agent holds is left alone; nothing ready, nothing runs', async () => {
    const id = await addTask('Held elsewhere');
    await executeRaw(`UPDATE tasks SET checked_out_by = 'coding@other', checked_out_at = now(), status = 'in_progress' WHERE id = '${id}'`);
    const result = await turn();
    expect(result).toEqual({ success: true, data: { role: 'coding' } });
    expect(runs).toHaveLength(0);
  });

  test('another role\'s tasks are not this agent\'s', async () => {
    await addTask('Review it', null, 'review');
    await turn();
    expect(runs).toHaveLength(0);
  });
});

test('taskPipelineDescription names the task so the run can be traced back', () => {
  const text = mod.taskPipelineDescription({ id: 't1', title: ' Plan the offsite ', notes: null });
  expect(text.startsWith('Plan the offsite')).toBe(true);
  expect(text).toContain('Work-board task t1');
});
