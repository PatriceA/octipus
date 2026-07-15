/**
 * Tests for the orchestrator's AVAILABLE EXPERTS prompt index.
 *
 * Strategy: ephemeral embedded PGlite (same pattern as
 * src/skills/discovery.test.ts) — real schema, real drizzle queries, no
 * mocks. Covers: empty table ⇒ empty block; visibility scoping (system +
 * own custom experts, never another user's); custom-first ordering; the
 * expertId + [custom] marker rendering; and the truncation cap.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Required env (must be set before any import that reads config) ──
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';
process.env.STORAGE_MODE = 'embedded';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-expert-index-'));
process.env.DATA_DIR = DATA_DIR;

import { getDb } from '@/db/postgres';
import { experts } from '@/db/schema/experts';
import { users } from '@/db/schema/users';
import { buildExpertIndexBlock } from './expert-index';

let userA: string;
let userB: string;

beforeAll(async () => {
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const db = getDb();
  const [a] = await db.insert(users).values({ username: `expert-index-a-${rand(4)}` }).returning({ id: users.id });
  const [b] = await db.insert(users).values({ username: `expert-index-b-${rand(4)}` }).returning({ id: users.id });
  userA = a.id;
  userB = b.id;
});

afterAll(async () => {
  try {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  } catch (err) {
    console.debug('expert-index.test teardown: closeDb failed', err);
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('buildExpertIndexBlock', () => {
  test('empty experts table ⇒ empty block (orchestrator routes by role only)', async () => {
    const block = await buildExpertIndexBlock(userA);
    expect(block).toBe('');
  });

  test('lists system + own custom experts, hides other users, custom first', async () => {
    const db = getDb();
    const [sys] = await db.insert(experts).values({
      name: 'Coder', description: 'Writes code', role: 'coding', isSystem: true,
    }).returning({ id: experts.id });
    const [mine] = await db.insert(experts).values({
      name: 'Tax Advisor', description: 'German tax law specialist', role: 'finance',
      isSystem: false, userId: userA,
    }).returning({ id: experts.id });
    await db.insert(experts).values({
      name: 'Secret Expert', description: 'Belongs to someone else', role: 'general',
      isSystem: false, userId: userB,
    });

    const block = await buildExpertIndexBlock(userA);

    expect(block).toContain('AVAILABLE EXPERTS');
    // Both visible experts render with their exact spawn_child expertId.
    expect(block).toContain(`expertId: ${sys.id}`);
    expect(block).toContain(`expertId: ${mine.id}`);
    expect(block).toContain('Writes code');
    // Another user's custom expert is never leaked.
    expect(block).not.toContain('Secret Expert');
    // Custom experts are flagged and listed before system experts.
    expect(block).toContain('Tax Advisor [custom]');
    expect(block.indexOf('Tax Advisor')).toBeLessThan(block.indexOf('Coder'));
  });

  test('caps the list and flags truncation', async () => {
    const db = getDb();
    for (let i = 0; i < 55; i++) {
      await db.insert(experts).values({
        name: `Bulk Expert ${i}`, role: 'general', isSystem: true,
      });
    }
    const block = await buildExpertIndexBlock(userA);
    expect(block).toContain('list truncated at 50 experts');
    // 50 entries max: count rendered bullet lines.
    const bullets = block.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets.length).toBe(50);
  });

  test('token-bounds bloated descriptions, keeping whole lines', async () => {
    // A few experts under the count cap but with descriptions large enough to
    // blow the token budget — the block must drop trailing entries (never a
    // partial line / severed expertId) and flag it. Insert as userB's own
    // custom experts: custom sorts first, so they dominate the budget
    // deterministically regardless of the system experts other tests left.
    const db = getDb();
    const bloat = 'lorem ipsum '.repeat(400); // ~1200 tokens each
    for (let i = 0; i < 6; i++) {
      await db.insert(experts).values({
        name: `Verbose Expert ${i}`, role: 'general', isSystem: false, userId: userB, description: bloat,
      });
    }
    const block = await buildExpertIndexBlock(userB);
    const bullets = block.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets.length).toBeLessThan(6); // token budget cut some
    expect(block).toContain(`list truncated at ${bullets.length} experts`);
    // Every emitted line is whole — its expertId parenthetical is intact.
    bullets.forEach((l) => expect(l).toMatch(/expertId: [0-9a-f-]+\)/));
  });
});
