/**
 * I7 — `saveCliSession` could silently undo a concurrent `/clear`.
 *
 * Both it and `/clear` read the whole `sessions.context`, spread it, and write
 * it back. `saveCliSession` is fired and forgotten from the middle of a turn
 * (`cli-agent-worker.ts`), so a `/clear` that lands while a turn is in flight
 * is restored wholesale — old `clearedAt`, old summary — and the cleared
 * conversation is resumed on the next turn. No overlapping turns required.
 *
 * `setContextKey` patches one key in the database, so the two writes no longer
 * contend. Backed by ephemeral PGlite so the actual jsonb SQL runs, not a
 * hand-rolled stand-in for it.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '44444444-4444-4444-4444-444444444444';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-ctxpatch-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'dave' }]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function freshSession(channelId: string) {
  const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
  return seedSession({ userId, channelId });
}

describe('sessionRepository.setContextKey', () => {
  test('a fire-and-forget vendor-session write does not resurrect a cleared context', async () => {
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const session = await freshSession('ctx-1');

    // Turn starts: the worker reads context, then goes off to run a CLI.
    await sessionRepository.update(session.id, {
      context: { clearedAt: '2026-01-01T00:00:00.000Z', compactedSummary: 'an old summary' },
    });
    const staleView = (await sessionRepository.findById(session.id))!.context;

    // Mid-turn, the user runs /clear.
    await sessionRepository.update(session.id, {
      context: { ...(staleView as object), clearedAt: '2026-09-15T12:00:00.000Z', compactedSummary: undefined, cliSessions: undefined },
    });

    // The in-flight turn now stores its vendor session id.
    await sessionRepository.setContextKey(session.id, ['cliSessions', 'Claude Code'], {
      id: 'vendor-1', fingerprint: 'fp', lastUsedAt: '2026-09-15T12:00:01.000Z',
    });

    const after = (await sessionRepository.findById(session.id))!.context as Record<string, unknown>;
    expect(after.clearedAt).toBe('2026-09-15T12:00:00.000Z'); // the clear survived
    expect(after.compactedSummary).toBeUndefined();
    expect((after.cliSessions as Record<string, { id: string }>)['Claude Code'].id).toBe('vendor-1');
  });

  test('creates missing intermediate objects and keeps siblings at every level', async () => {
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const session = await freshSession('ctx-2');
    await sessionRepository.update(session.id, { context: { devMode: true } });

    await sessionRepository.setContextKey(session.id, ['cliSessions', 'Claude Code'], { id: 'a' });
    await sessionRepository.setContextKey(session.id, ['cliSessions', 'Codex CLI'], { id: 'b' });
    await sessionRepository.setContextKey(session.id, ['compactionState'], { ineffectivePasses: 2 });

    const ctx = (await sessionRepository.findById(session.id))!.context as Record<string, any>;
    expect(ctx.devMode).toBe(true);
    expect(ctx.cliSessions['Claude Code'].id).toBe('a');
    expect(ctx.cliSessions['Codex CLI'].id).toBe('b');
    expect(ctx.compactionState.ineffectivePasses).toBe(2);
  });

  test('undefined deletes just that key', async () => {
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const session = await freshSession('ctx-3');
    await sessionRepository.setContextKey(session.id, ['cliSessions', 'Claude Code'], { id: 'a' });
    await sessionRepository.setContextKey(session.id, ['cliSessions', 'Codex CLI'], { id: 'b' });

    await sessionRepository.setContextKey(session.id, ['cliSessions', 'Codex CLI'], undefined);

    const ctx = (await sessionRepository.findById(session.id))!.context as Record<string, any>;
    expect(ctx.cliSessions['Claude Code'].id).toBe('a');
    expect(ctx.cliSessions['Codex CLI']).toBeUndefined();
  });
});

describe('generation and checkpoint persistence', () => {
  test('clear rejects stale checkpoint publication and completed answers', async () => {
    const { sessionRepository } = await import('./session-repository');
    const { messageRepository } = await import('./message-repository');
    const session = await freshSession('generation-clear');
    await sessionRepository.setContextKey(session.id, ['devMode'], true);
    await sessionRepository.clearContext(session.id);
    expect(await sessionRepository.patchContextIfGeneration(session.id, '', { cliSessions: { old: { id: 'old' } } })).toBe(false);
    expect(await messageRepository.createForGeneration({ sessionId: session.id, role: 'assistant', content: 'stale' }, '')).toBeNull();
    const current = (await sessionRepository.findById(session.id))!;
    expect(current.context?.devMode).toBe(true);
    expect(current.context?.cliSessions).toBeUndefined();
    expect(await messageRepository.createForGeneration({ sessionId: session.id, role: 'user', content: 'fresh' }, current.context!.conversationGeneration!)).not.toBeNull();
  });
  test('history uses the full suffix and exact timestamp/id checkpoint boundary', async () => {
    const { sessionRepository } = await import('./session-repository');
    const { messageRepository } = await import('./message-repository');
    const { readSessionHistory } = await import('@/core/session-history');
    const session = await freshSession('checkpoint-suffix');
    const time = new Date('2026-09-16T01:00:00Z');
    const rows = await messageRepository.createMany(Array.from({ length: 250 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`, sessionId: session.id,
      role: i % 2 ? 'assistant' as const : 'user' as const, content: `message ${i}`, createdAt: time,
    })));
    const all = await readSessionHistory(session.id);
    expect(all.rows).toHaveLength(250);
    const cursor = rows[219];
    await sessionRepository.patchContextIfGeneration(session.id, '', { checkpoint: { generation: '',
      through: { id: cursor.id, createdAt: time.toISOString() }, summary: 'covered 220', fileOps: { read: [], written: [], edited: [] } } });
    const history = await readSessionHistory(session.id);
    expect(history.rows).toHaveLength(30);
    expect(history.rows[0].content).toBe('message 220');
    expect(history.messages[0].content).toContain('covered 220');
    expect(history.messages.at(-1)?.content).toBe('message 249');
    await sessionRepository.clearContext(session.id);
    expect((await readSessionHistory(session.id)).messages).toEqual([]);
  });
});

test('a clear distinguishes new and old rows created in the same millisecond', async () => {
  const { sessionRepository } = await import('./session-repository');
  const { messageRepository } = await import('./message-repository');
  const { readSessionHistory } = await import('@/core/session-history');
  const session = await freshSession('same-millisecond-clear');
  await sessionRepository.clearContext(session.id);
  const context = (await sessionRepository.findById(session.id))!.context!;
  const time = new Date(context.clearedAt!);
  await messageRepository.create({ sessionId: session.id, role: 'user', content: 'legacy before clear', createdAt: time });
  await messageRepository.createForGeneration({ sessionId: session.id, role: 'user', content: 'new turn', createdAt: time }, context.conversationGeneration!);
  expect((await readSessionHistory(session.id)).rows.map(r => r.content)).toEqual(['new turn']);
  await sessionRepository.clearContext(session.id);
  const next = (await sessionRepository.findById(session.id))!.context!;
  expect(next.conversationGeneration).not.toBe(context.conversationGeneration);
  expect(await sessionRepository.patchContextIfGeneration(session.id, context.conversationGeneration!, { nativeConversation: {} })).toBe(false);
});
