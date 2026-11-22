/**
 * A follow-up keeps its subject: `contextForAgentStart` with `followUp`
 * searches a short message together with the previous message the user
 * typed in the session, read from the stored rows (embedded PGlite, the
 * deterministic embedding stand-in). Only the owner's own typed words count,
 * and nothing from before the conversation was cleared.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { audienceOf } from '@/core/agent/audience';
import { fakeEmbedder, vectorLiteral } from '@/test-helpers/fake-embedding';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '88888888-8888-8888-8888-888888888888';
let queryRaw: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
let executeRaw: (sql: string) => Promise<unknown>;
const embed = fakeEmbedder({ aliases: { charge: 'price', costs: 'price' } });

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-agent-start-'));
  const pg = await import('@/db/postgres');
  await pg.initializeDb();
  queryRaw = pg.queryRaw as typeof queryRaw;
  executeRaw = pg.executeRaw as typeof executeRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'follow', false) ON CONFLICT DO NOTHING`);
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  await executeRaw('DELETE FROM context_hooks; DELETE FROM context_turns; DELETE FROM embeddings; DELETE FROM messages; DELETE FROM sessions;');
  const { resetSessionLevels } = await import('@/core/protection/session-level');
  resetSessionLevels();
  const { getEmbeddingService } = await import('@/core/rag/embeddings');
  vi.spyOn(getEmbeddingService(), 'generateEmbedding').mockImplementation(async (text: string) => embed(text));
  const { updateContextHook } = await import('@/core/context-hooks');
  await updateContextHook(userId, 'builtin:notes-index', { enabled: false });
  // The subject is in the previous message; the follow-up alone is too far from the passage.
  await queryRaw(
    `INSERT INTO embeddings (id, source_id, content, model, embedding, purpose, content_sha256, embedding_version, user_id, metadata)
     VALUES ($1, $2, $3, 'fake', $4, 'note', $5, 'fake/512', $6, $7)`,
    [randomUUID(), `note:${randomUUID()}`, PASSAGE, vectorLiteral(embed(PASSAGE)), randomUUID(), userId, JSON.stringify({ title: 'Enterprise hosting' })],
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 100));
});

const PASSAGE = 'Enterprise hosting costs 99 euro a month, billed yearly with support.';
const SUBJECT = 'What do we charge for hosting?';
const FOLLOW_UP = 'and for enterprise?';

async function session(context: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await queryRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id, context) VALUES ($1, $2, 'webchat', $3, $4)`, [id, userId, `c-${id}`, JSON.stringify(context)]);
  return id;
}

let clock = Date.parse('2026-11-01T10:00:00Z');
async function userRow(sessionId: string, content: string, metadata: Record<string, unknown> = {}): Promise<void> {
  clock += 60_000;
  await queryRaw(`INSERT INTO messages (session_id, role, content, metadata, created_at) VALUES ($1, 'user', $2, $3, $4)`, [sessionId, content, JSON.stringify(metadata), new Date(clock).toISOString()]);
}

async function followUp(sessionId: string, query = FOLLOW_UP) {
  const { contextForAgentStart } = await import('@/core/context-hooks');
  return contextForAgentStart({ event: 'turn_start', userId, workspaceId: null, sessionId, query, role: 'general', channel: 'web', audience: audienceOf('personal'), followUp: true });
}

describe('a follow-up and the previous typed message', () => {
  test('the follow-up alone finds nothing; with the previous typed message it finds its subject', async () => {
    const alone = await session();
    expect((await followUp(alone)).text).not.toContain('Enterprise hosting');

    const id = await session();
    await userRow(id, SUBJECT);
    const out = await followUp(id);
    expect(out.text).toContain('<recalled-knowledge>');
    expect(out.text).toContain('Enterprise hosting');
  });

  test('rows that are not the owner typing are passed over: a plan brief, a schedule, an internal row', async () => {
    const id = await session();
    await userRow(id, SUBJECT);
    await userRow(id, 'Execute this project plan: migrate the newsletter archive', { synthetic: 'plan' });
    await userRow(id, 'Summarise the newsletter archive every morning', { trigger: 'schedule' });
    await userRow(id, 'SYSTEM: collect the children', { visibility: 'internal' });
    const { previousTypedMessage } = await import('@/core/context-hooks');
    expect(await previousTypedMessage(userId, id, FOLLOW_UP)).toBe(SUBJECT);
    expect((await followUp(id)).text).toContain('Enterprise hosting');
  });

  test('nothing from before the conversation was cleared', async () => {
    // Stamped with an older generation…
    const stamped = await session({ conversationGeneration: 'g2' });
    await userRow(stamped, SUBJECT, { sessionGeneration: 'g1' });
    // …or unstamped and older than the clear.
    const cleared = await session({ clearedAt: new Date(clock + 30 * 60_000).toISOString() });
    await userRow(cleared, SUBJECT);
    clock += 60 * 60_000;
    const { previousTypedMessage } = await import('@/core/context-hooks');
    for (const id of [stamped, cleared]) {
      expect(await previousTypedMessage(userId, id, FOLLOW_UP)).toBeUndefined();
      expect((await followUp(id)).text).not.toContain('Enterprise hosting');
    }
    // The current generation's row counts.
    await userRow(stamped, SUBJECT, { sessionGeneration: 'g2' });
    expect(await previousTypedMessage(userId, stamped, FOLLOW_UP)).toBe(SUBJECT);
  });

  test("this turn's own row, when already stored, is not its own previous message", async () => {
    const id = await session();
    await userRow(id, SUBJECT);
    await userRow(id, FOLLOW_UP);
    const { previousTypedMessage } = await import('@/core/context-hooks');
    expect(await previousTypedMessage(userId, id, FOLLOW_UP)).toBe(SUBJECT);
  });

  test("another user's session gives nothing", async () => {
    const other = '99999999-9999-9999-9999-999999999999';
    await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${other}', 'other', false) ON CONFLICT DO NOTHING`);
    const id = randomUUID();
    await queryRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id) VALUES ($1, $2, 'webchat', $3)`, [id, other, `c-${id}`]);
    await userRow(id, SUBJECT);
    const { previousTypedMessage } = await import('@/core/context-hooks');
    expect(await previousTypedMessage(userId, id, FOLLOW_UP)).toBeUndefined();
  });
});
