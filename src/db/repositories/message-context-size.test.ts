/**
 * `messageRepository.contextSize` — the aggregate automatic compaction reads
 * instead of the transcript. It must count exactly the rows
 * `findContextMessages` would return (same filters, no cap), in UTF-8 bytes.
 * Backed by ephemeral PGlite so the SQL itself runs.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '55555555-5555-4555-8555-555555555555';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-ctxsize-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'erin' }]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

test('counts the transcript after the checkpoint, in bytes, with prompt context', async () => {
  const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
  const { messageRepository } = await import('@/db/repositories/message-repository');
  const session = await seedSession({ userId, channelId: 'ctx-size' });
  const first = await messageRepository.create({ sessionId: session.id, role: 'user', content: 'before the checkpoint' });
  await messageRepository.create({ sessionId: session.id, role: 'user', content: 'héllo', metadata: { promptContext: 'ctx' } });
  await messageRepository.create({ sessionId: session.id, role: 'assistant', content: 'ok' });
  await messageRepository.create({ sessionId: session.id, role: 'tool', content: 'not part of the transcript' });

  const after = { id: first.id, createdAt: first.createdAt.toISOString() };
  const size = await messageRepository.contextSize(session.id, undefined, after, '');
  const rows = await messageRepository.findContextMessages(session.id, undefined, after, '');
  expect(size.rows).toBe(rows.length);
  expect(size).toEqual({ rows: 2, bytes: Buffer.byteLength('héllo') + 3 + 2 });
});
