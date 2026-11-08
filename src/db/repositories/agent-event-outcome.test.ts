/**
 * The run view's outcome read: one agent's completion, errors and recorded
 * file writes, oldest first — not its thoughts or other tool events, and
 * nothing of another agent — against an embedded Postgres.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

// Embedded Postgres: the single-worker `database` project, picked by markers such as getDb( in the file.
const runtime = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@/db/postgres', () => ({ getDb: () => runtime.db }));
vi.mock('@/core/run-context', () => ({ getRunId: () => undefined }));
import { agentEventRepository } from './agent-event-repository';

const dir = mkdtempSync(join(tmpdir(), 'octipus-agent-events-'));
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite(dir);
  await pg.exec(`
    CREATE TABLE agent_events(id serial PRIMARY KEY, agent_id text NOT NULL, session_id text NOT NULL, user_id text, workspace_id uuid,
      run_id text, type text NOT NULL, data jsonb DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO agent_events(agent_id, session_id, type, data) VALUES
      ('a', 's', 'thought', '{"text":"thinking"}'),
      ('a', 's', 'action', '{"type":"tool_call_complete","name":"write_file"}'),
      ('a', 's', 'action', '{"type":"file_change","action":"write","path":"/out/notes.md"}'),
      ('b', 's', 'action', '{"type":"file_change","action":"write","path":"/out/other.md"}'),
      ('a', 's', 'error', '{"error":"retrying"}'),
      ('a', 's', 'complete', '{"result":"Saved notes.md"}');
  `);
  runtime.db = drizzle(pg);
});
afterAll(async () => { await pg.close(); rmSync(dir, { recursive: true, force: true }); });

test('only the agent\'s file writes, errors and completion, in order', async () => {
  const rows = await agentEventRepository.outcomeEvents('a');
  expect(rows.map((r) => [r.type, (r.data as { path?: string }).path ?? null])).toEqual([
    ['action', '/out/notes.md'],
    ['error', null],
    ['complete', null],
  ]);
});
