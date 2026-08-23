/**
 * Cross-tenant isolation tests for the scoped repositories.
 *
 * The whole point of Phase 1a is to make "user A reads user B's data"
 * impossible at the repository layer. These tests build a two-user
 * fixture (alice + bob, each owning a session with messages, an agent,
 * and a document), then exercise every read/write method through both
 * principals and assert the boundary holds:
 *
 *   - alice.findById(bob_session.id) → null
 *   - alice.listOwn() → only alice rows
 *   - alice.update(bob_session.id, ...) → null, no mutation
 *   - alice.delete(bob_session.id) → false, row still present
 *   - admin.findByIdAdmin(bob_session.id) → row
 *
 * Backed by an ephemeral PGlite, so the suite runs in the standard
 * `npm test` slice without Docker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  seedAgent,
  seedDocument,
  seedMessage,
  seedSession,
  seedUsers,
} from '@/test-helpers/multiuser-fixtures';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

let aliceId: string;
let bobId: string;
let aliceSession: { id: string };
let bobSession: { id: string };
let aliceAgent: { id: string };
let bobAgent: { id: string };
let aliceDoc: { id: string };
let bobDoc: { id: string };

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-isolation-'));

  // initializeDb() detects the env change (different dataDir vs the
  // singleton cached by an earlier test file in the same process)
  // and closes-and-reopens automatically. See `cachedDbKey` in
  // src/db/postgres.ts.
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  aliceId = '11111111-1111-1111-1111-111111111111';
  bobId = '22222222-2222-2222-2222-222222222222';

  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);

  // Seed via raw SQL helpers (see multiuser-fixtures.ts) — the repo
  // singletons can be mocked by other test files in the same process,
  // so going through them here is brittle.
  aliceSession = await seedSession({ userId: aliceId, channelId: 'a-1' });
  bobSession = await seedSession({ userId: bobId, channelId: 'b-1' });

  await seedMessage({ sessionId: aliceSession.id, role: 'user', content: 'alice secret' });
  await seedMessage({ sessionId: bobSession.id, role: 'user', content: 'bob secret' });

  aliceAgent = await seedAgent({
    id: 'agent-alice', sessionId: aliceSession.id, userId: aliceId, status: 'running',
  });
  bobAgent = await seedAgent({
    id: 'agent-bob', sessionId: bobSession.id, userId: bobId, status: 'running',
  });

  aliceDoc = await seedDocument({ userId: aliceId, originalName: 'a.pdf', storagePath: '/tmp/a.pdf' });
  bobDoc = await seedDocument({ userId: bobId, originalName: 'b.pdf', storagePath: '/tmp/b.pdf' });
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function asAlice() {
  const { scopedRepos } = await import('./scoped');
  const { principalFromUser } = await import('@/security/principal');
  return scopedRepos(principalFromUser({ id: aliceId, username: 'alice', isAdmin: false }));
}

async function asBob() {
  const { scopedRepos } = await import('./scoped');
  const { principalFromUser } = await import('@/security/principal');
  return scopedRepos(principalFromUser({ id: bobId, username: 'bob', isAdmin: false }));
}

async function asAdmin() {
  const { scopedRepos } = await import('./scoped');
  const { principalFromUser } = await import('@/security/principal');
  return scopedRepos(principalFromUser({ id: aliceId, username: 'alice', isAdmin: true }));
}

describe('ScopedSessionRepo cross-tenant isolation', () => {
  test('findById returns null when looking up another user’s session', async () => {
    const alice = await asAlice();
    expect(await alice.sessions.findById(bobSession.id)).toBeNull();
    expect((await alice.sessions.findById(aliceSession.id))?.id).toBe(aliceSession.id);
  });

  test('listOwn returns only the principal’s sessions', async () => {
    const alice = await asAlice();
    const list = await alice.sessions.listOwn();
    expect(list.every((s) => s.userId === aliceId)).toBe(true);
    expect(list.find((s) => s.id === bobSession.id)).toBeUndefined();
  });

  test('countOwn counts only the principal’s sessions (not other tenants)', async () => {
    const alice = await asAlice();
    const list = await alice.sessions.listOwn();
    const count = await alice.sessions.countOwn();
    // Matches listOwn here (well under the page limit) and excludes bob's.
    expect(count).toBe(list.length);
    expect(count).toBeGreaterThan(0);
    const bob = await asBob();
    expect(await bob.sessions.countOwn()).toBeGreaterThan(0);
  });

  test('update on another user’s session is a no-op (returns null)', async () => {
    const alice = await asAlice();
    const { queryRaw } = await import('@/db/postgres');
    const beforeQ = await queryRaw(`SELECT title FROM sessions WHERE id='${bobSession.id}'`);
    const result = await alice.sessions.update(bobSession.id, { title: 'pwned' });
    expect(result).toBeNull();
    const afterQ = await queryRaw(`SELECT title FROM sessions WHERE id='${bobSession.id}'`);
    expect(afterQ.rows[0]?.title).toBe(beforeQ.rows[0]?.title ?? null);
  });

  test('update strips an attempted user_id reassignment', async () => {
    const alice = await asAlice();
    const result = await alice.sessions.update(aliceSession.id, {
      // Intentionally smuggling user_id to verify the scope drops it before
      // hitting the DB. Drizzle's NewSession type allows the field, so this
      // is a runtime guard rather than a compile-time one.
      userId: bobId,
      title: 'still-alice',
    });
    expect(result?.userId).toBe(aliceId);
    expect(result?.title).toBe('still-alice');
  });

  test('delete on another user’s session returns false, row stays', async () => {
    const alice = await asAlice();
    expect(await alice.sessions.delete(bobSession.id)).toBe(false);
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT id FROM sessions WHERE id='${bobSession.id}'`);
    expect(rows).toHaveLength(1);
  });

  test('admin.findById crosses tenants', async () => {
    const admin = await asAdmin();
    expect((await admin.sessions.findById(bobSession.id))?.id).toBe(bobSession.id);
  });

  test('listAllAdmin throws for non-admin principals', async () => {
    const alice = await asAlice();
    await expect(alice.sessions.listAllAdmin()).rejects.toThrow();
  });

  test('listAllAdmin returns sessions from every user for admins', async () => {
    const admin = await asAdmin();
    const all = await admin.sessions.listAllAdmin();
    expect(all.find((s) => s.id === aliceSession.id)).toBeDefined();
    expect(all.find((s) => s.id === bobSession.id)).toBeDefined();
  });
});

describe('ScopedMessageRepo cross-tenant isolation', () => {
  test('findBySession on another user’s session returns []', async () => {
    const alice = await asAlice();
    const result = await alice.messages.findBySession(bobSession.id);
    expect(result).toEqual([]);
  });

  test('findBySession on own session returns own messages', async () => {
    const alice = await asAlice();
    const result = await alice.messages.findBySession(aliceSession.id);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('alice secret');
  });

  test('countBySessions ignores foreign session ids', async () => {
    const alice = await asAlice();
    const count = await alice.messages.countBySessions([aliceSession.id, bobSession.id]);
    // Only the alice session contributes — bob is filtered out.
    expect(count).toBe(1);
  });

  test('create on another user’s session is rejected (returns null)', async () => {
    const alice = await asAlice();
    const result = await alice.messages.create({
      sessionId: bobSession.id,
      role: 'user',
      content: 'cross-tenant-injection',
    });
    expect(result).toBeNull();
    // Verify Bob's session message count didn't grow
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `SELECT id FROM messages WHERE session_id='${bobSession.id}' AND content='cross-tenant-injection'`,
    );
    expect(rows).toHaveLength(0);
  });

  test('create on own session succeeds', async () => {
    const alice = await asAlice();
    const result = await alice.messages.create({
      sessionId: aliceSession.id,
      role: 'user',
      content: 'alice extra',
    });
    expect(result?.content).toBe('alice extra');
  });
});

describe('ScopedAgentRepo cross-tenant isolation', () => {
  test('findById on another user’s agent returns null', async () => {
    const alice = await asAlice();
    expect(await alice.agents.findById(bobAgent.id)).toBeNull();
  });

  test('listOwn returns only own agents', async () => {
    const alice = await asAlice();
    const list = await alice.agents.listOwn();
    expect(list.every((a) => a.userId === aliceId)).toBe(true);
  });

  test('findBySession ignores foreign session ids', async () => {
    const alice = await asAlice();
    const result = await alice.agents.findBySession(bobSession.id);
    expect(result).toEqual([]);
  });
});

describe('ScopedDocumentRepo cross-tenant isolation', () => {
  test('findById on another user’s document returns null', async () => {
    const alice = await asAlice();
    expect(await alice.documents.findById(bobDoc.id)).toBeNull();
  });

  test('listOwn returns only own documents', async () => {
    const alice = await asAlice();
    const list = await alice.documents.listOwn();
    expect(list.every((d) => d.userId === aliceId)).toBe(true);
    expect(list.find((d) => d.id === bobDoc.id)).toBeUndefined();
  });

  test('delete on another user’s document is a no-op', async () => {
    const alice = await asAlice();
    expect(await alice.documents.delete(bobDoc.id)).toBe(false);
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT id FROM documents WHERE id='${bobDoc.id}'`);
    expect(rows).toHaveLength(1);
  });
});

describe('ScopedRepos requires authentication', () => {
  test('anonymous principal throws on construction', async () => {
    const { scopedRepos } = await import('./scoped');
    const { ANONYMOUS_PRINCIPAL } = await import('@/security/principal');
    expect(() => scopedRepos(ANONYMOUS_PRINCIPAL)).toThrow();
  });
});

describe('ScopedRepos: bound to fixture-created agent/document IDs', () => {
  test('alice still owns her originally-created entities', async () => {
    const alice = await asAlice();
    expect((await alice.agents.findById(aliceAgent.id))?.id).toBe(aliceAgent.id);
    expect((await alice.documents.findById(aliceDoc.id))?.id).toBe(aliceDoc.id);
    const bob = await asBob();
    expect((await bob.agents.findById(bobAgent.id))?.id).toBe(bobAgent.id);
    expect((await bob.documents.findById(bobDoc.id))?.id).toBe(bobDoc.id);
  });
});
