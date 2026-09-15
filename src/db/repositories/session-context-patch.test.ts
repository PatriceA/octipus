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
