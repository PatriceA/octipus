/**
 * Phase 2e — channels/linking.ts is now a thin bridge over
 * ChannelBindingManager. These tests verify the bridge writes
 * through to the new Postgres-backed tables (`channel_link_codes` +
 * `channel_identities`) while keeping the legacy
 * `{ success, error }` API shape that the auth route + channel
 * adapters depend on.
 *
 * Backed by ephemeral PGlite — no Docker.
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

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-linking-'));

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

describe('generateLinkCode + redeemLinkCode bridge → ChannelBindingManager', () => {
  test('happy path: code lands in channel_link_codes, redeem creates channel_identities row', async () => {
    const { generateLinkCode, redeemLinkCode } = await import('@/channels/linking');
    const code = await generateLinkCode({
      channelType: 'telegram',
      channelUserId: 'tg-101',
      channelUserName: '@alice',
    });
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);

    // The code is in channel_link_codes (new table), NOT a cache key.
    const { queryRaw } = await import('@/db/postgres');
    const codes = await queryRaw(`SELECT code, channel_type, external_id FROM channel_link_codes WHERE code='${code}'`);
    expect(codes.rows).toHaveLength(1);
    expect(codes.rows[0].channel_type).toBe('telegram');
    expect(codes.rows[0].external_id).toBe('tg-101');

    // Redeem returns success and creates the binding row.
    const result = await redeemLinkCode(code, aliceId);
    expect(result.success).toBe(true);

    const bindings = await queryRaw(
      `SELECT user_id, verified_at FROM channel_identities WHERE channel_type='telegram' AND external_id='tg-101'`,
    );
    expect(bindings.rows[0].user_id).toBe(aliceId);
    expect(bindings.rows[0].verified_at).not.toBeNull();
  });

  test('redeem error mapping: unknown code → "Invalid or expired link code"', async () => {
    const { redeemLinkCode } = await import('@/channels/linking');
    const r = await redeemLinkCode('AAAAAA', aliceId);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/invalid or expired/i);
  });

  test('redeem error mapping: cross-user reuse → "already been used"', async () => {
    const { generateLinkCode, redeemLinkCode } = await import('@/channels/linking');
    const code = await generateLinkCode({ channelType: 'slack', channelUserId: 'slack-shared' });

    expect((await redeemLinkCode(code, aliceId)).success).toBe(true);
    const second = await redeemLinkCode(code, bobId);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already been used/i);
  });

  test('legacy users.channelBindings JSONB column is mirrored on success', async () => {
    const { generateLinkCode, redeemLinkCode } = await import('@/channels/linking');
    const code = await generateLinkCode({
      channelType: 'whatsapp', channelUserId: 'wa-mirror', channelUserName: 'Mirror Test',
    });
    expect((await redeemLinkCode(code, aliceId)).success).toBe(true);

    // Verify the JSONB array now contains the binding too — keeps any
    // unmigrated reader (older root agent paths) working.
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `SELECT channel_bindings FROM users WHERE id='${aliceId}'`,
    );
    const bindings = typeof rows[0].channel_bindings === 'string'
      ? JSON.parse(rows[0].channel_bindings)
      : rows[0].channel_bindings;
    const found = (bindings ?? []).find(
      (b: any) => b.channelType === 'whatsapp' && b.channelUserId === 'wa-mirror',
    );
    expect(found).toBeDefined();
    expect(found.isVerified).toBe(true);
  });
});
