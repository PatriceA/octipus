/**
 * Migration 0135 (guests and remote members), replayed over data written
 * before S6: guest scopes were any JSON object, and a guest entered the rooms
 * they had a `room_members` row in.
 *
 * The database is migrated to head, the scope CHECK is dropped, legacy rows
 * are inserted the way the old code wrote them, then 0135 is applied again —
 * it is idempotent, so this replays exactly what an upgrade does:
 *
 *   - a malformed guest scope (membership or invite) becomes the empty scope;
 *   - a guest's `room_members` rooms of their own space join their scope;
 *     room ids of another space, or of no room, are dropped;
 *   - a valid scope keeps its rooms and folders;
 *   - running it again changes nothing.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const owner = randomUUID();
const legacyGuest = randomUUID();
const shapedGuest = randomUUID();
const nullGuest = randomUUID();
const validGuest = randomUUID();
let spaceId: string;
let otherSpaceId: string;
let privateRoom: string;
let openRoom: string;
let otherRoom: string;
const ids: Record<string, string> = {};

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows as T[];
}

async function replay(): Promise<void> {
  const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0135_guests_remote.sql'), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.replace(/--.*$/gm, '').trim()) await q(statement);
  }
}

const scopeOf = async (table: 'workspace_members' | 'workspace_invites', where: string, params: unknown[]) =>
  (await q<{ scope: unknown }>(`SELECT scope FROM ${table} WHERE ${where}`, params))[0]?.scope;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-0135-'));
  const { getConfig, refreshConfigKey } = await import('@/config');
  getConfig();
  refreshConfigKey('workspace.rootPath', mkdtempSync(join(tmpdir(), 'octipus-0135-files-')));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([owner, legacyGuest, shapedGuest, nullGuest, validGuest].map((id, i) => ({ id, username: `m135-${i}` })));
  const { createSpace } = await import('@/core/spaces/service');
  const { createRoom } = await import('@/core/rooms/service');
  spaceId = (await createSpace({ userId: owner }, { name: 'Legacy' })).id;
  otherSpaceId = (await createSpace({ userId: owner }, { name: 'Other' })).id;
  privateRoom = (await createRoom({ userId: owner }, spaceId, { title: 'Private', visibility: 'private' })).id;
  openRoom = (await createRoom({ userId: owner }, spaceId, { title: 'Open', visibility: 'space' })).id;
  otherRoom = (await createRoom({ userId: owner }, otherSpaceId, { title: 'Elsewhere', visibility: 'space' })).id;

  // Before S6: no scope CHECK, scopes of any shape.
  await q(`ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_scope_chk`);
  await q(`ALTER TABLE workspace_invites DROP CONSTRAINT workspace_invites_scope_chk`);
  const member = (userId: string, scope: unknown) =>
    q(`INSERT INTO workspace_members (workspace_id, user_id, role, scope) VALUES ($1, $2, 'guest', $3)`, [spaceId, userId, scope === null ? null : JSON.stringify(scope)]);
  await member(legacyGuest, { foo: 1, rooms: ['x'] });
  await member(shapedGuest, { rooms: [otherRoom, randomUUID()], folders: ['client'] });
  await member(nullGuest, null);
  await member(validGuest, { rooms: [openRoom.toUpperCase()], folders: ['shared/specs'] });
  // The old way in: room_members rows, in this space's private room and another space's room.
  await q(`INSERT INTO room_members (session_id, user_id) VALUES ($1, $2), ($1, $3), ($4, $3)`, [privateRoom, legacyGuest, nullGuest, otherRoom]);
  const invite = (scope: unknown) =>
    q<{ id: string }>(`INSERT INTO workspace_invites (workspace_id, role, scope, token_hash, created_by, expires_at) VALUES ($1, 'guest', $2, $3, $4, now() + interval '1 day') RETURNING id`,
      [spaceId, JSON.stringify(scope), rand(32), owner]);
  const [bad] = await invite({ folders: ['../etc'] });
  const [stale] = await invite({ rooms: [otherRoom, openRoom], folders: [] });
  ids.badInvite = bad.id;
  ids.staleInvite = stale.id;
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('migration 0135 over pre-S6 guests', () => {
  test('normalises scopes, seeds rooms from room_members, and re-runs cleanly', async () => {
    await replay();
    const member = (userId: string) => scopeOf('workspace_members', 'workspace_id = $1 AND user_id = $2', [spaceId, userId]);
    // Malformed: the empty scope, plus the rooms they had a row in (this space only).
    expect(await member(legacyGuest)).toEqual({ rooms: [privateRoom], folders: [] });
    // Rooms of another space or of nothing are dropped; folders kept.
    expect(await member(shapedGuest)).toEqual({ rooms: [], folders: ['client'] });
    // No scope at all: the empty scope and their room_members rooms.
    expect(await member(nullGuest)).toEqual({ rooms: [privateRoom], folders: [] });
    // A valid scope keeps its rooms (lowercased) and folders.
    expect(await member(validGuest)).toEqual({ rooms: [openRoom], folders: ['shared/specs'] });

    const invite = (id: string) => scopeOf('workspace_invites', 'id = $1', [id]);
    expect(await invite(ids.badInvite)).toEqual({ rooms: [], folders: [] });
    expect(await invite(ids.staleInvite)).toEqual({ rooms: [openRoom], folders: [] });

    // The guests reach what the scope says, through the real access layer.
    const { roomAccess } = await import('@/core/rooms/access');
    expect(await roomAccess(legacyGuest, privateRoom)).not.toBeNull();
    expect(await roomAccess(legacyGuest, openRoom)).toBeNull();
    expect(await roomAccess(validGuest, openRoom)).not.toBeNull();

    const before = await q(`SELECT user_id, scope FROM workspace_members ORDER BY user_id`);
    await replay();
    expect(await q(`SELECT user_id, scope FROM workspace_members ORDER BY user_id`)).toEqual(before);
    // The CHECKs are back.
    await expect(q(`UPDATE workspace_members SET scope = NULL WHERE user_id = $1`, [legacyGuest])).rejects.toThrow(/workspace_members_scope_chk/);
  });
});
