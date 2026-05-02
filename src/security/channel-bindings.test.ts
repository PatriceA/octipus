/**
 * ChannelBindingManager — Phase 2d.
 *
 * Covers:
 *   - generateLinkCode shape (alphabet, length).
 *   - createPendingLink → redeem happy path.
 *   - findUserByExternalId returns null for unknown, hits the new
 *     table, and falls back to the legacy JSONB column with backfill.
 *   - Cross-user redemption of a code claimed by user A by user B
 *     is rejected.
 *   - Already-redeemed code by the same user is idempotent.
 *   - Expired code is rejected.
 *   - Cross-tenant unbind returns false silently.
 *
 * Backed by ephemeral PGlite — no Docker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-cb-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);
  const { _resetChannelBindingManagerForTests } = await import('@/security/channel-bindings');
  _resetChannelBindingManagerForTests();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('generateLinkCode', () => {
  test('emits 6-character codes from the unambiguous alphabet', async () => {
    const { generateLinkCode } = await import('@/security/channel-bindings');
    for (let i = 0; i < 50; i++) {
      const c = generateLinkCode();
      expect(c).toHaveLength(6);
      // Only A-Z 2-9, no 0/O/1/I/L
      expect(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(c)).toBe(true);
    }
  });
});

describe('createPendingLink + redeem (happy path)', () => {
  test('round-trips a telegram chat_id into a channel_identities row', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const mgr = getChannelBindingManager();
    const link = await mgr.createPendingLink('telegram', 'chat-12345', '@alice');

    const result = await mgr.redeem(aliceId, link.code);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding.userId).toBe(aliceId);
      expect(result.binding.channelType).toBe('telegram');
      expect(result.binding.externalId).toBe('chat-12345');
      expect(result.binding.verifiedAt).not.toBeNull();
    }

    expect(await mgr.findUserByExternalId('telegram', 'chat-12345')).toBe(aliceId);
  });

  test('case-insensitive code redemption', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const mgr = getChannelBindingManager();
    const link = await mgr.createPendingLink('slack', 'U-CASE');

    const result = await mgr.redeem(aliceId, link.code.toLowerCase());
    expect(result.ok).toBe(true);
  });
});

describe('redeem — failure modes', () => {
  test('unknown code → unknown_code', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const mgr = getChannelBindingManager();
    const r = await mgr.redeem(aliceId, 'AAAAAA');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_code');
  });

  test('expired code → expired', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const mgr = getChannelBindingManager();
    const link = await mgr.createPendingLink('whatsapp', 'wa-expire-me');

    // Force the code expiry into the past.
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE channel_link_codes SET expires_at = now() - interval '1 hour' WHERE code='${link.code}'`);

    const r = await mgr.redeem(aliceId, link.code);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });

  test('cross-user redemption of an already-claimed code is rejected', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const mgr = getChannelBindingManager();
    const link = await mgr.createPendingLink('teams', 'teams-shared');

    const first = await mgr.redeem(aliceId, link.code);
    expect(first.ok).toBe(true);

    // Bob tries to reuse the same code — must fail.
    const second = await mgr.redeem(bobId, link.code);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_redeemed');

    // Telegram chat is still bound to alice.
    expect(await mgr.findUserByExternalId('teams', 'teams-shared')).toBe(aliceId);
  });

  test('same user re-redeeming their own code is idempotent', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const mgr = getChannelBindingManager();
    const link = await mgr.createPendingLink('discord', 'discord-idempot');

    const first = await mgr.redeem(aliceId, link.code);
    expect(first.ok).toBe(true);

    const second = await mgr.redeem(aliceId, link.code);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.binding.id).toBe(first.binding.id);
  });
});

describe('findUserByExternalId — legacy JSONB fallback', () => {
  test('reads from legacy users.channelBindings, then backfills the new table', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const mgr = getChannelBindingManager();

    // Seed a legacy binding directly into the JSONB column for bob.
    const { executeRaw, queryRaw } = await import('@/db/postgres');
    await executeRaw(
      `UPDATE users SET channel_bindings='[{"channelType":"telegram","channelUserId":"legacy-chat-id","isVerified":true,"createdAt":"2025-01-01T00:00:00Z"}]'::jsonb WHERE id='${bobId}'`,
    );

    expect(await mgr.findUserByExternalId('telegram', 'legacy-chat-id')).toBe(bobId);

    // Backfill should have happened.
    const { rows } = await queryRaw(
      `SELECT user_id FROM channel_identities WHERE channel_type='telegram' AND external_id='legacy-chat-id'`,
    );
    expect(rows[0]?.user_id).toBe(bobId);
  });
});

describe('listForUser + unbind cross-tenant', () => {
  test('lists only own bindings', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const mgr = getChannelBindingManager();
    const list = await mgr.listForUser(aliceId);
    expect(list.every((b) => b.userId === aliceId)).toBe(true);
  });

  test('alice cannot unbind bob’s binding — silent no-op', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const mgr = getChannelBindingManager();
    const link = await mgr.createPendingLink('telegram', 'bob-only');
    await mgr.redeem(bobId, link.code);

    const ok = await mgr.unbind(aliceId, 'telegram', 'bob-only');
    expect(ok).toBe(false);
    expect(await mgr.findUserByExternalId('telegram', 'bob-only')).toBe(bobId);
  });

  test('owner can unbind their own', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const mgr = getChannelBindingManager();
    const link = await mgr.createPendingLink('slack', 'alice-removable');
    await mgr.redeem(aliceId, link.code);

    expect(await mgr.unbind(aliceId, 'slack', 'alice-removable')).toBe(true);
    expect(await mgr.findUserByExternalId('slack', 'alice-removable')).toBeNull();
  });
});
