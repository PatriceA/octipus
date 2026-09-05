/**
 * Away digest collector — integration over embedded PGlite. Real rows in
 * `agents`, `pipelines`, `background_jobs`, `tasks`, `notifications`;
 * approvals injected.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const alice = '11111111-1111-1111-1111-111111111111';
const bob = '22222222-2222-2222-2222-222222222222';
const sessionA = '33333333-3333-3333-3333-333333333333';
const sessionB = '44444444-4444-4444-4444-444444444444';
const NOW = new Date('2026-09-07T08:00:00Z');
const SINCE = new Date('2026-09-06T08:00:00Z');

let away: typeof import('./away');
let principalFor: (id: string) => import('@/security/principal').Principal;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-digest-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${alice}', 'alice', false), ('${bob}', 'bob', false)`);
  await executeRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id) VALUES ('${sessionA}', '${alice}', 'web', 'a'), ('${sessionB}', '${bob}', 'web', 'b')`);
  await executeRaw(`
    INSERT INTO agents (id, session_id, user_id, role, status, error, duration_ms, created_at, completed_at) VALUES
      ('ag-done',  '${sessionA}', '${alice}', 'coding',   'completed', NULL,      95000, '2026-09-06T20:00:00Z', '2026-09-06T20:01:35Z'),
      ('ag-fail',  '${sessionA}', '${alice}', 'qa',       'failed',    'exit 1',  NULL,  '2026-09-06T21:00:00Z', '2026-09-06T21:00:10Z'),
      ('ag-old',   '${sessionA}', '${alice}', 'research', 'completed', NULL,      NULL,  '2026-09-01T10:00:00Z', '2026-09-01T10:05:00Z'),
      ('ag-live',  '${sessionA}', '${alice}', 'review',   'running',   NULL,      NULL,  '2026-09-07T07:00:00Z', NULL),
      ('ag-bob',   '${sessionB}', '${bob}',   'coding',   'completed', NULL,      NULL,  '2026-09-06T22:00:00Z', '2026-09-06T22:01:00Z')`);
  await executeRaw(`
    INSERT INTO pipelines (root_agent_id, session_id, user_id, title, type, status, summary, created_at, updated_at) VALUES
      ('r', '${sessionA}', '${alice}', 'Bug Fix', 'development', 'awaiting_approval', NULL, '2026-09-06T09:00:00Z', '2026-09-06T23:00:00Z'),
      ('r', '${sessionA}', '${alice}', 'Still going', 'development', 'running', NULL, '2026-09-07T06:00:00Z', '2026-09-07T07:59:00Z'),
      ('r', '${sessionA}', '${alice}', 'Old run', 'development', 'completed', 'done', '2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
      ('r', '${sessionB}', '${bob}',   'Bob run', 'development', 'completed', NULL,   '2026-09-06T09:00:00Z', '2026-09-06T23:00:00Z')`);
  await executeRaw(`
    INSERT INTO background_jobs (user_id, kind, status, title, payload, error, result_ref, created_at, updated_at, finished_at) VALUES
      ('${alice}', 'research', 'done',        'Is PGlite production-ready?', '{"question":"Is PGlite production-ready?","depth":"quick"}', NULL, 'doc-1', '2026-09-06T19:00:00Z', '2026-09-06T19:04:00Z', '2026-09-06T19:04:00Z'),
      ('${alice}', 'document', 'error',       'invoice.pdf', '{"documentId":"d-1"}', 'OCR model unavailable', NULL, '2026-09-06T20:00:00Z', '2026-09-06T20:00:30Z', '2026-09-06T20:00:30Z'),
      ('${alice}', 'document', 'interrupted', 'deck.pptx', '{"documentId":"d-2"}', 'Interrupted by a restart', NULL, '2026-09-07T06:00:00Z', '2026-09-07T07:00:00Z', '2026-09-07T07:00:00Z'),
      ('${alice}', 'research', 'running',     'still going', '{"question":"still going","depth":"quick"}', NULL, NULL, '2026-09-07T07:30:00Z', '2026-09-07T07:59:00Z', NULL),
      ('${alice}', 'document', 'queued',      'waiting.pdf', '{"documentId":"d-3"}', NULL, NULL, '2026-09-07T07:40:00Z', '2026-09-07T07:40:00Z', NULL),
      ('${alice}', 'research', 'done',        'old run', '{"question":"old run","depth":"quick"}', NULL, NULL, '2026-09-01T09:00:00Z', '2026-09-01T09:10:00Z', '2026-09-01T09:10:00Z'),
      ('${bob}',   'document', 'done',        'bob.pdf', '{"documentId":"d-b"}', NULL, 'd-b', '2026-09-06T21:00:00Z', '2026-09-06T21:01:00Z', '2026-09-06T21:01:00Z')`);
  await executeRaw(`
    INSERT INTO tasks (user_id, title, status, source, created_at) VALUES
      ('${alice}', 'Reply to Ada',   'open', 'email', '2026-09-07T01:00:00Z'),
      ('${alice}', 'I typed this',   'open', 'user',  '2026-09-07T01:00:00Z'),
      ('${alice}', 'ancient agent',  'open', 'agent', '2026-08-01T01:00:00Z'),
      ('${bob}',   'Bob task',       'open', 'email', '2026-09-07T01:00:00Z')`);
  await executeRaw(`
    INSERT INTO notifications (user_id, type, title, read, created_at) VALUES
      ('${alice}', 'agent_complete', 'x', false, '2026-09-06T20:01:00Z'),
      ('${alice}', 'agent_error',    'y', false, '2026-09-06T21:01:00Z'),
      ('${alice}', 'info',           'z', true,  '2026-09-06T22:00:00Z'),
      ('${alice}', 'info',           'stale', false, '2026-08-20T10:00:00Z'),
      ('${bob}',   'agent_complete', 'b', false, '2026-09-06T22:01:00Z')`);
  away = await import('./away');
  const { principalFromUser } = await import('@/security/principal');
  principalFor = (id) => principalFromUser({ id, username: id, isAdmin: false });
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('collectAwayDigest', () => {
  test('folds finished agents, changed pipelines, sourced tasks, unread count and approvals — own rows only', async () => {
    const d = await away.collectAwayDigest(principalFor(alice), SINCE, {
      now: () => NOW,
      pendingApprovals: async (uid) => (uid === alice ? [{ id: 'r1', sessionId: sessionA, summary: 'Delete branch', question: 'Proceed?' }] : []),
    });
    expect(d.since).toBe(SINCE.toISOString());
    expect(d.until).toBe(NOW.toISOString());
    expect(d.agents.completed.map((a) => a.id)).toEqual(['ag-done']);
    expect(d.agents.failed.map((a) => [a.id, a.error])).toEqual([['ag-fail', 'exit 1']]);
    expect(d.pipelines.map((p) => [p.title, p.waitingOnYou])).toEqual([['Bug Fix', true]]);
    // Newest change first; a running or queued job is not news, and Bob's is Bob's.
    expect(d.jobs.map((j) => [j.title, j.status])).toEqual([['deck.pptx', 'interrupted'], ['invoice.pdf', 'error'], ['Is PGlite production-ready?', 'done']]);
    expect(d.jobs[2].resultRef).toBe('doc-1');
    expect(d.tasks.map((t) => t.title)).toEqual(['Reply to Ada']);
    // Two unread in the window; the stale one from August is the inbox's business.
    expect(d.unreadNotifications).toBe(2);
    expect(d.approvals).toHaveLength(1);
    expect(d.empty).toBe(false);

    const text = away.renderAwayDigest(d);
    expect(text).toContain('- Delete branch: Proceed?');
    expect(text).toContain('- Bug Fix (awaiting approval)');
    expect(text).toContain('- qa: exit 1');
    expect(text).toContain('- coding in 1m 35s');
    expect(text).toContain('- document: deck.pptx (interrupted by a restart)');
    expect(text).toContain('- research: Is PGlite production-ready?');
    expect(text).toContain('- Reply to Ada');
  });

  test('a window with nothing in it is empty — an older unread notification does not count', async () => {
    const d = await away.collectAwayDigest(principalFor(bob), new Date('2026-09-07T05:00:00Z'), {
      now: () => NOW,
      pendingApprovals: async () => [],
    });
    expect(d.agents.completed).toEqual([]);
    expect(d.pipelines).toEqual([]);
    expect(d.jobs).toEqual([]);
    expect(d.tasks).toEqual([]);
    expect(d.unreadNotifications).toBe(0);
    expect(d.empty).toBe(true);
    expect(away.renderAwayDigest(d)).toContain('Nothing happened');
  });

  test('a running pipeline is not news yet', async () => {
    const d = await away.collectAwayDigest(principalFor(alice), SINCE, { now: () => NOW, pendingApprovals: async () => [] });
    expect(d.pipelines.map((p) => p.title)).toEqual(['Bug Fix']);
  });

  test('since is clamped to 30 days', async () => {
    const d = await away.collectAwayDigest(principalFor(alice), new Date('2000-01-01T00:00:00Z'), {
      now: () => NOW,
      pendingApprovals: async () => [],
    });
    expect(d.since).toBe('2026-08-08T08:00:00.000Z');
    // The 2026-09-01 rows are inside 30 days and now show; the 2026-08-01 task is not.
    expect(d.agents.completed.map((a) => a.id)).toEqual(['ag-done', 'ag-old']);
    expect(d.tasks.map((t) => t.title)).toEqual(['Reply to Ada']);
  });
});
