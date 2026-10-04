/**
 * Shared spaces — the service (docs/plans/coworking-spec.md §5.2, §5.3, §5.9).
 *
 * Roles, the last-owner rule, the member cap, archive, the creation policy,
 * audit rows with the space's workspace_id, and what a removal does at once
 * (agents stopped, requests expired, data sources paused).
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const owner = randomUUID();
const editor = randomUUID();
const viewer = randomUUID();
const outsider = randomUUID();
const admin = randomUUID();

// biome-ignore lint/suspicious/noExplicitAny: raw rows
type Row = any;
async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-spaces-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: owner, username: 'owner' },
    { id: editor, username: 'editor' },
    { id: viewer, username: 'viewer' },
    { id: outsider, username: 'outsider' },
    { id: admin, username: 'admin', isAdmin: true },
  ]);
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

/** A space owned by `owner` with `members` joined through invites. */
async function spaceWith(members: Array<[string, 'editor' | 'commenter' | 'viewer' | 'guest']>): Promise<string> {
  const { createSpace } = await import('./service');
  const { createInvite, acceptInvite } = await import('./invites');
  const space = await createSpace({ userId: owner }, { name: `Space ${rand(3)}` });
  for (const [userId, role] of members) {
    const invite = await createInvite({ userId: owner }, space.id, { role });
    await acceptInvite({ userId }, invite.token);
  }
  return space.id;
}

describe('roles', () => {
  test('can() follows the role table', async () => {
    const { can } = await import('@/security/space-access');
    expect(can('owner', 'manage_members')).toBe(true);
    expect(can('editor', 'write')).toBe(true);
    expect(can('editor', 'manage_members')).toBe(false);
    expect(can('editor', 'manage_invites')).toBe(false);
    expect(can('commenter', 'comment')).toBe(true);
    expect(can('commenter', 'write')).toBe(false);
    expect(can('commenter', 'run_agent')).toBe(true);
    expect(can('commenter', 'run_agent_write')).toBe(false);
    expect(can('viewer', 'read')).toBe(true);
    expect(can('viewer', 'comment')).toBe(false);
    expect(can('viewer', 'run_agent')).toBe(false);
    expect(can('guest', 'read')).toBe(true);
    expect(can('guest', 'write')).toBe(false);
    expect(can(null, 'read')).toBe(false);
  });

  test('a space has no owning user row and its creator is its owner', async () => {
    const { createSpace, getMembership } = await import('./service');
    const space = await createSpace({ userId: owner }, { name: '  Team  ' });
    expect(space).toMatchObject({ name: 'Team', role: 'owner', memberCount: 1, funding: 'own', archivedAt: null });
    const [row] = await q(`SELECT kind, user_id, created_by, is_default FROM workspaces WHERE id = $1`, [space.id]);
    expect(row).toEqual({ kind: 'shared', user_id: null, created_by: owner, is_default: false });
    expect(await getMembership(owner, space.id)).toMatchObject({ role: 'owner', scope: null });
    expect(await getMembership(outsider, space.id)).toBeNull();
    expect(await getMembership(owner, 'not-a-uuid')).toBeNull();
    // The creator's personal workspace list never sees it.
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    expect((await getOrgWorkspaceManager().listOwn(owner)).map((w) => w.id)).not.toContain(space.id);
  });

  test('the schema refuses a shared workspace with an owner and a personal one without', async () => {
    await expect(q(`INSERT INTO workspaces (kind, user_id, slug, name) VALUES ('shared', $1, $2, 'x')`, [owner, `s-${rand(3)}`])).rejects.toThrow();
    await expect(q(`INSERT INTO workspaces (kind, user_id, slug, name) VALUES ('personal', NULL, $1, 'x')`, [`p-${rand(3)}`])).rejects.toThrow();
  });

  test('non-members get not_found, members without the role forbidden_role', async () => {
    const { getSpace, renameSpace, listMembers } = await import('./service');
    const id = await spaceWith([[editor, 'editor'], [viewer, 'viewer']]);
    await expect(getSpace({ userId: outsider }, id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(listMembers({ userId: outsider }, id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getSpace({ userId: outsider }, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    await expect(renameSpace({ userId: editor }, id, 'Mine')).rejects.toMatchObject({ code: 'forbidden_role' });
    await expect(renameSpace({ userId: viewer }, id, 'Mine')).rejects.toMatchObject({ code: 'forbidden_role' });
    expect((await getSpace({ userId: viewer }, id)).role).toBe('viewer');
    expect((await renameSpace({ userId: owner }, id, 'Renamed')).name).toBe('Renamed');
    const members = await listMembers({ userId: viewer }, id);
    expect(members.map((m) => [m.username, m.role])).toEqual([['owner', 'owner'], ['editor', 'editor'], ['viewer', 'viewer']]);
  });

  test('an editor cannot change roles or remove members; the owner can', async () => {
    const { setRole, removeMember, getMembership } = await import('./service');
    const id = await spaceWith([[editor, 'editor'], [viewer, 'viewer']]);
    await expect(setRole({ userId: editor }, id, viewer, { role: 'editor' })).rejects.toMatchObject({ code: 'forbidden_role' });
    await expect(removeMember({ userId: editor }, id, viewer)).rejects.toMatchObject({ code: 'forbidden_role' });
    await expect(setRole({ userId: owner }, id, viewer, { role: 'boss' })).rejects.toMatchObject({ code: 'invalid_role' });
    await expect(setRole({ userId: owner }, id, viewer, { role: 'editor', scope: { rooms: [] } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(setRole({ userId: owner }, id, outsider, { role: 'editor' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await setRole({ userId: owner }, id, viewer, { role: 'commenter' })).role).toBe('commenter');
    await removeMember({ userId: owner }, id, viewer);
    expect(await getMembership(viewer, id)).toBeNull();
  });
});

describe('last owner', () => {
  test('the last owner cannot be demoted, removed or leave; a second owner unblocks it', async () => {
    const { setRole, leaveSpace, removeMember, getMembership } = await import('./service');
    const id = await spaceWith([[editor, 'editor']]);
    await expect(setRole({ userId: owner }, id, owner, { role: 'editor' })).rejects.toMatchObject({ code: 'last_owner' });
    await expect(leaveSpace({ userId: owner }, id)).rejects.toMatchObject({ code: 'last_owner' });
    await expect(removeMember({ userId: owner }, id, owner)).rejects.toMatchObject({ code: 'last_owner' });

    await setRole({ userId: owner }, id, editor, { role: 'owner' });
    await leaveSpace({ userId: owner }, id);
    expect(await getMembership(owner, id)).toBeNull();
    expect((await getMembership(editor, id))?.role).toBe('owner');
    await expect(leaveSpace({ userId: editor }, id)).rejects.toMatchObject({ code: 'last_owner' });
  });

  test('two owners demoting each other at once leave one owner', async () => {
    const { setRole } = await import('./service');
    const id = await spaceWith([[editor, 'editor']]);
    await setRole({ userId: owner }, id, editor, { role: 'owner' });
    const results = await Promise.allSettled([
      setRole({ userId: owner }, id, editor, { role: 'editor' }),
      setRole({ userId: editor }, id, owner, { role: 'editor' }),
    ]);
    const owners = await q(`SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`, [id]);
    expect(owners).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  test('assertDeletable refuses the last owner of a space and names it', async () => {
    const { createSpace } = await import('./service');
    const { assertDeletable, UserNotDeletableError } = await import('@/security/user-deletion');
    const lonely = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: lonely, username: 'lonely' }]);
    await expect(assertDeletable(lonely)).resolves.toBeUndefined();
    const space = await createSpace({ userId: lonely }, { name: 'Only mine' });
    const err = await assertDeletable(lonely).catch((e) => e);
    expect(err).toBeInstanceOf(UserNotDeletableError);
    expect(err).toMatchObject({ code: 'last_space_owner', spaces: [{ id: space.id, name: 'Only mine' }] });
    expect(err.message).toContain('Only mine');
  });
});

describe('member cap and creation policy', () => {
  test('spaces.maxMembers is enforced on join', async () => {
    const { getConfig } = await import('@/config');
    const { createSpace } = await import('./service');
    const { createInvite, acceptInvite } = await import('./invites');
    const cfg = getConfig().spaces;
    const before = cfg.maxMembers;
    cfg.maxMembers = 2;
    try {
      const space = await createSpace({ userId: owner }, { name: 'Small' });
      const invite = await createInvite({ userId: owner }, space.id, { role: 'viewer', maxUses: 5 });
      await acceptInvite({ userId: editor }, invite.token);
      await expect(acceptInvite({ userId: viewer }, invite.token)).rejects.toMatchObject({ code: 'space_full' });
      // The refused join did not consume a use.
      const [row] = await q(`SELECT use_count FROM workspace_invites WHERE id = $1`, [invite.id]);
      expect(row.use_count).toBe(1);
    } finally {
      cfg.maxMembers = before;
    }
  });

  test('spaces.creation = admins refuses other users', async () => {
    const { getConfig } = await import('@/config');
    const { createSpace } = await import('./service');
    const cfg = getConfig().spaces;
    cfg.creation = 'admins';
    try {
      await expect(createSpace({ userId: owner }, { name: 'Nope' })).rejects.toMatchObject({ code: 'forbidden_role' });
      await expect(createSpace({ userId: admin }, { name: 'Admins only' })).resolves.toMatchObject({ role: 'owner' });
    } finally {
      cfg.creation = 'any_user';
    }
    await expect(createSpace({ userId: owner }, { name: ' ' })).rejects.toMatchObject({ code: 'invalid_name' });
  });
});

describe('archive', () => {
  test('archive makes the space read-only and stops its agents; unarchive undoes it', async () => {
    const { archiveSpace, unarchiveSpace, renameSpace, getSpace, isSpaceArchived } = await import('./service');
    const { createInvite } = await import('./invites');
    const { getAgentManager } = await import('@/core/agent-manager');
    const id = await spaceWith([[editor, 'editor']]);
    const stop = vi.spyOn(getAgentManager(), 'stopWorkspace');
    try {
      await expect(archiveSpace({ userId: editor }, id)).rejects.toMatchObject({ code: 'forbidden_role' });
      const archived = await archiveSpace({ userId: owner }, id);
      expect(archived.archivedAt).toBeInstanceOf(Date);
      expect(stop).toHaveBeenCalledWith(id);
      expect(await isSpaceArchived(id)).toBe(true);
      // Reads still work; writes do not.
      expect((await getSpace({ userId: editor }, id)).archivedAt).not.toBeNull();
      await expect(renameSpace({ userId: owner }, id, 'x')).rejects.toMatchObject({ code: 'archived' });
      await expect(createInvite({ userId: owner }, id, { role: 'viewer' })).rejects.toMatchObject({ code: 'archived' });
      // Archiving twice changes nothing.
      stop.mockClear();
      await archiveSpace({ userId: owner }, id);
      expect(stop).not.toHaveBeenCalled();

      expect((await unarchiveSpace({ userId: owner }, id)).archivedAt).toBeNull();
      expect((await renameSpace({ userId: owner }, id, 'Back')).name).toBe('Back');
    } finally {
      stop.mockRestore();
    }
  });
});

describe('audit (I10)', () => {
  test('every change writes a row with the space workspace_id, listed as activity', async () => {
    const { setRole, removeMember, listActivity, archiveSpace } = await import('./service');
    const { revokeInvite, createInvite } = await import('./invites');
    const id = await spaceWith([[editor, 'editor'], [viewer, 'viewer']]);
    await setRole({ userId: owner }, id, viewer, { role: 'commenter' });
    const extra = await createInvite({ userId: owner }, id, { role: 'viewer' });
    await revokeInvite({ userId: owner }, id, extra.id);
    await removeMember({ userId: owner }, id, viewer);
    await archiveSpace({ userId: owner }, id);

    const rows = await q(`SELECT action::text AS action, user_id FROM audit_log WHERE workspace_id = $1 ORDER BY created_at, action`, [id]);
    const actions = rows.map((r) => r.action);
    for (const a of ['space_created', 'space_invite_created', 'space_invite_accepted', 'space_member_role_changed', 'space_invite_revoked', 'space_member_removed', 'space_archived']) {
      expect(actions, a).toContain(a);
    }
    // No row leaks the raw token.
    const details = await q(`SELECT details::text AS d FROM audit_log WHERE workspace_id = $1`, [id]);
    expect(details.some((r) => r.d.includes(extra.token))).toBe(false);

    const activity = await listActivity({ userId: editor }, id, { limit: 3 });
    expect(activity).toHaveLength(3);
    expect(activity[0].action).toBe('space_archived');
    const older = await listActivity({ userId: editor }, id, { before: activity[2].createdAt });
    expect(older.every((a) => a.createdAt < activity[2].createdAt)).toBe(true);
    await expect(listActivity({ userId: outsider }, id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('membership changes (§5.9)', () => {
  test('a removed member: agents stopped, requests expired, data sources paused; version bumped', async () => {
    const { removeMember } = await import('./service');
    const { membershipVersion } = await import('./membership');
    const { getAgentManager } = await import('@/core/agent-manager');
    const id = await spaceWith([[editor, 'editor']]);

    // A session of the editor in the space, a pending permission request there
    // (unstamped, keyed by the session) and one stamped elsewhere.
    const [session] = await q(
      `INSERT INTO sessions (user_id, channel_type, channel_id, workspace_id) VALUES ($1, 'web', $2, $3) RETURNING id`,
      [editor, `c-${rand(4)}`, id],
    );
    const [inSpace] = await q(
      `INSERT INTO permission_requests (user_id, agent_id, session_id, skill_id, action, context) VALUES ($1, 'a1', $2, 't', 'write', '{"toolName":"t","toolArguments":{}}') RETURNING id`,
      [editor, session.id],
    );
    const [stamped] = await q(
      `INSERT INTO permission_requests (user_id, agent_id, skill_id, action, context, workspace_id) VALUES ($1, 'a2', 't', 'write', '{"toolName":"t","toolArguments":{}}', $2) RETURNING id`,
      [editor, id],
    );
    const [elsewhere] = await q(
      `INSERT INTO permission_requests (user_id, agent_id, skill_id, action, context) VALUES ($1, 'a3', 't', 'write', '{"toolName":"t","toolArguments":{}}') RETURNING id`,
      [editor],
    );
    // An artifact of the space with a data source the editor owns, and one the owner owns.
    const [artifact] = await q(
      `INSERT INTO artifacts (workspace_id, slug, title, type, created_by_user_id) VALUES ($1, $2, 'A', 'html', $3) RETURNING id`,
      [id, `a-${rand(3)}`, editor],
    );
    const [mine] = await q(`INSERT INTO artifact_data_sources (artifact_id, name, kind, principal_id) VALUES ($1, 'e', 'http', $2) RETURNING id`, [artifact.id, editor]);
    const [theirs] = await q(`INSERT INTO artifact_data_sources (artifact_id, name, kind, principal_id) VALUES ($1, 'o', 'http', $2) RETURNING id`, [artifact.id, owner]);

    const stop = vi.spyOn(getAgentManager(), 'stopWorkspace');
    const versionBefore = membershipVersion(id, editor);
    try {
      await removeMember({ userId: owner }, id, editor);
      expect(stop).toHaveBeenCalledWith(id, editor);
    } finally {
      stop.mockRestore();
    }
    expect(membershipVersion(id, editor)).toBe(versionBefore + 1);

    const status = async (rid: string) => (await q(`SELECT status FROM permission_requests WHERE id = $1`, [rid]))[0].status;
    expect(await status(inSpace.id)).toBe('expired');
    expect(await status(stamped.id)).toBe('expired');
    expect(await status(elsewhere.id)).toBe('pending');

    const paused = async (sid: string) => (await q(`SELECT paused_at, paused_reason FROM artifact_data_sources WHERE id = $1`, [sid]))[0];
    expect(await paused(mine.id)).toMatchObject({ paused_reason: 'membership' });
    expect((await paused(mine.id)).paused_at).not.toBeNull();
    expect((await paused(theirs.id)).paused_at).toBeNull();

    // A paused source does not refresh.
    const { refreshSource } = await import('@/core/artifacts/refresh');
    expect(await refreshSource(mine.id)).toMatchObject({ ok: false });

    // Re-joining as an editor resumes it; joining as a viewer would not.
    const { createInvite, acceptInvite } = await import('./invites');
    const back = await createInvite({ userId: owner }, id, { role: 'viewer' });
    await acceptInvite({ userId: editor }, back.token);
    expect((await paused(mine.id)).paused_at).not.toBeNull();
    const { setRole } = await import('./service');
    await setRole({ userId: owner }, id, editor, { role: 'editor' });
    expect((await paused(mine.id)).paused_at).toBeNull();
  });

  test('a downgrade runs the same consequences; an upgrade does not stop anything', async () => {
    const { setRole } = await import('./service');
    const { getAgentManager } = await import('@/core/agent-manager');
    const id = await spaceWith([[editor, 'editor']]);
    const stop = vi.spyOn(getAgentManager(), 'stopWorkspace');
    try {
      await setRole({ userId: owner }, id, editor, { role: 'viewer' });
      expect(stop).toHaveBeenCalledWith(id, editor);
      stop.mockClear();
      await setRole({ userId: owner }, id, editor, { role: 'editor' });
      expect(stop).not.toHaveBeenCalled();
    } finally {
      stop.mockRestore();
    }
  });
});
