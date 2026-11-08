/**
 * The Context inspector's read: stored sizes per turn, the latest turn's text
 * when this process still holds it, and the provider's input for the request
 * the estimate describes — against a real (embedded) Postgres.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { PromptComposition } from '@/shared/prompt-composition';

// Embedded Postgres: belongs in the single-worker `database` project, which
// vitest.config.ts picks by markers such as getDb( in the file.
const runtime = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@/db/postgres', () => ({ getDb: () => runtime.db }));
import { _resetPromptCompositionForTesting, recordLatestComposition } from './prompt-composition';
import { readSessionContext } from './session-context';

const dir = mkdtempSync(join(tmpdir(), 'octipus-session-context-'));
let pg: PGlite;
const sessionId = randomUUID();

const composition = (tokens: number, at: string): PromptComposition => ({
  version: 1, measuredAt: at, role: 'general', model: 'm', estimator: 'chars/4', toolCount: 1, contextWindow: 200_000,
  sections: [
    { category: 'role', tier: 'static', label: 'general role prompt', chars: 400, tokens: 100 },
    { category: 'conversation', tier: 'history', label: 'Tool results', chars: (tokens - 100) * 4, tokens: tokens - 100, count: 2 },
  ],
  totals: { tokens, prefixTokens: 100, turnTokens: 0, historyTokens: tokens - 100 },
});

async function userRow(id: string, agentId: string, at: string, metadata: object) {
  await pg.query(`INSERT INTO messages(id, session_id, role, content, agent_id, metadata, created_at) VALUES ($1, $2, 'user', 'q', $3, $4, $5)`,
    [id, sessionId, agentId, JSON.stringify(metadata), at]);
}

beforeAll(async () => {
  pg = new PGlite(dir);
  await pg.exec(`
    CREATE TYPE message_role AS ENUM ('system', 'user', 'assistant', 'tool');
    CREATE TABLE messages(id uuid PRIMARY KEY, session_id uuid NOT NULL, role message_role NOT NULL, content text NOT NULL,
      agent_id text, metadata jsonb DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE cost_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, session_id uuid, agent_id text,
      model_name text NOT NULL, input_tokens integer NOT NULL, output_tokens integer NOT NULL,
      cached_input_tokens integer NOT NULL DEFAULT 0, cache_creation_tokens integer NOT NULL DEFAULT 0, total_cost real NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());
  `);
  runtime.db = drizzle(pg);
});
afterAll(async () => { await pg.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  _resetPromptCompositionForTesting();
  await pg.exec('DELETE FROM messages; DELETE FROM cost_log;');
});

test('an unmeasured session has nothing to show, and says so with null rather than zeros', async () => {
  await userRow(randomUUID(), 'a', '2026-11-08T09:00:00Z', { trigger: 'user' });
  expect(await readSessionContext(sessionId)).toEqual({ latest: null, turns: [], usage: null });
});

test('turns come oldest first; after a restart the latest has sizes but no text', async () => {
  const first = randomUUID(), second = randomUUID();
  await userRow(first, 'agent-1', '2026-11-08T09:00:00Z', { promptComposition: composition(1_000, '2026-11-08T09:00:00Z') });
  await userRow(second, 'agent-2', '2026-11-08T09:05:00Z', { promptComposition: composition(3_000, '2026-11-08T09:05:00Z') });
  await userRow(randomUUID(), 'agent-x', '2026-11-08T09:06:00Z', { promptComposition: { version: 99 } });
  await pg.query(`INSERT INTO cost_log(user_id, agent_id, model_name, input_tokens, output_tokens, cached_input_tokens, total_cost, created_at)
    VALUES ($1, 'agent-2', 'm', 2900, 10, 2000, 0, '2026-11-08T09:05:01Z'), ($1, 'agent-2', 'm', 5000, 10, 2900, 0, '2026-11-08T09:05:09Z')`, [randomUUID()]);

  const context = await readSessionContext(sessionId);
  expect(context.turns.map((t) => [t.messageId, t.totals.tokens, t.byCategory])).toEqual([
    [first, 1_000, { role: 100, conversation: 900 }],
    [second, 3_000, { role: 100, conversation: 2_900 }],
  ]);
  expect(context.latest).toMatchObject({ messageId: second, textAvailable: false, totals: { tokens: 3_000 } });
  // The first request of that turn, the one the estimate was made for.
  expect(context.usage).toMatchObject({ inputTokens: 2900, cachedInputTokens: 2000 });
});

test('the in-memory latest turn carries its text; a newer stored turn wins over a stale memory', async () => {
  const id = randomUUID();
  await userRow(id, 'agent-1', '2026-11-08T09:00:00Z', { promptComposition: composition(1_000, '2026-11-08T09:00:00Z') });
  const withText = { ...composition(1_000, '2026-11-08T09:00:00Z'), sections: [{ category: 'role' as const, tier: 'static' as const, label: 'general role prompt', chars: 400, tokens: 100, text: 'You are Octipus.' }] };
  recordLatestComposition(sessionId, { agentId: 'agent-1', messageId: id, composition: withText });
  expect((await readSessionContext(sessionId)).latest).toMatchObject({ textAvailable: true, sections: [{ text: 'You are Octipus.' }] });

  await userRow(randomUUID(), 'agent-2', '2026-11-08T09:10:00Z', { promptComposition: composition(2_000, '2026-11-08T09:10:00Z') });
  expect((await readSessionContext(sessionId)).latest).toMatchObject({ textAvailable: false, totals: { tokens: 2_000 } });
});
