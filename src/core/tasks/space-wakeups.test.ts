/**
 * Wakeups in a space (docs/plans/coworking-spec.md §5.5, §5.11): closing a
 * blocker wakes and notifies ANOTHER member's dependent task — the event
 * names the woken task's author, the notification goes to that author (and
 * to a user assignee), not to the member who closed the blocker; the
 * wakeup context reads the space, not the closer's personal tasks; a space
 * task never marks a role heartbeat due; and the cross-process bridge
 * resolves a space task by its space.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { TaskWakeupEvent } from './wakeups';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const alice = randomUUID();
const bob = randomUUID();
const carol = randomUUID();
let spaceId: string;

// biome-ignore lint/suspicious/noExplicitAny: raw rows
async function q(sql: string, params: unknown[] = []): Promise<any[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-space-wakeups-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: alice, username: 'w-alice' }, { id: bob, username: 'w-bob' }, { id: carol, username: 'w-carol' }]);
  const { spaceWith } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(alice, [[bob, 'editor'], [carol, 'editor']]);
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('space task wakeups', () => {
  test('closing a blocker wakes and notifies another member’s dependent task', async () => {
    const { contentRepos } = await import('@/db/repositories/content');
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const { flushWakeups, onTaskWakeup } = await import('./wakeups');
    const asAlice = contentRepos(await resolvedPrincipal(alice, spaceId));
    const asBob = contentRepos(await resolvedPrincipal(bob, spaceId));

    const blocker = await asAlice.tasks.create({ title: 'Sign the contract', source: 'user' });
    const dependent = await asBob.tasks.create({
      title: 'Pay the deposit',
      source: 'user',
      blockedBy: [blocker.id],
      assigneeKind: 'user',
      assigneeRef: carol,
    });
    expect(dependent.workspaceId).toBe(spaceId);

    const events: TaskWakeupEvent[] = [];
    const off = onTaskWakeup((e) => { events.push(e); });
    try {
      // Alice closes her blocker; Bob's task is the one woken.
      await asAlice.tasks.update(blocker.id, { status: 'done' });
      await flushWakeups();
    } finally {
      off();
    }
    expect(events).toEqual([expect.objectContaining({ type: 'task.unblocked', taskId: dependent.id, userId: bob, workspaceId: spaceId, triggeredBy: blocker.id })]);

    const notes = await q(`SELECT user_id, workspace_id, type FROM notifications WHERE metadata->>'taskId' = $1 ORDER BY user_id`, [dependent.id]);
    expect(notes.map((n) => n.user_id).sort()).toEqual([bob, carol].sort());
    expect(new Set(notes.map((n) => n.workspace_id))).toEqual(new Set([spaceId]));
    expect(notes.every((n) => n.type === 'task_unblocked')).toBe(true);
    expect(notes.find((n) => n.user_id === alice)).toBeUndefined();

    // Bob sees it in the space's inbox, not in his personal one.
    const inSpace = await asBob.notifications.list();
    expect(inSpace.map((n) => n.metadata?.taskId)).toContain(dependent.id);
    const personal = contentRepos(await resolvedPrincipal(bob, null));
    expect((await personal.notifications.list()).map((n) => n.metadata?.taskId)).not.toContain(dependent.id);
  });

  test('a personal task of the closer is never part of a space wakeup, and the reverse', async () => {
    const { contentRepos } = await import('@/db/repositories/content');
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const { flushWakeups, onTaskWakeup } = await import('./wakeups');
    const space = contentRepos(await resolvedPrincipal(alice, spaceId));
    const personal = contentRepos(await resolvedPrincipal(alice, null));

    const spaceBlocker = await space.tasks.create({ title: 'Space blocker', source: 'user' });
    // A personal task cannot name a space task as its blocker: it is not visible there.
    await expect(personal.tasks.create({ title: 'Personal dependent', source: 'user', blockedBy: [spaceBlocker.id] })).rejects.toThrow(/not found/);

    const personalBlocker = await personal.tasks.create({ title: 'Personal blocker', source: 'user' });
    await expect(space.tasks.create({ title: 'Space dependent', source: 'user', blockedBy: [personalBlocker.id] })).rejects.toThrow(/not found/);

    const events: TaskWakeupEvent[] = [];
    const off = onTaskWakeup((e) => { events.push(e); });
    try {
      await space.tasks.update(spaceBlocker.id, { status: 'done' });
      await personal.tasks.update(personalBlocker.id, { status: 'done' });
      await flushWakeups();
    } finally {
      off();
    }
    expect(events).toEqual([]);
  });

  test('a space task is never assigned to a role or a node, and a legacy one never marks a role heartbeat due', async () => {
    const { markRoleHeartbeatDue } = await import('@/core/heartbeat');
    const { contentRepos } = await import('@/db/repositories/content');
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const space = contentRepos(await resolvedPrincipal(bob, spaceId));
    await expect(space.tasks.create({ title: 'Role work', source: 'user', assigneeKind: 'role', assigneeRef: 'research' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(space.tasks.create({ title: 'Node work', source: 'user', assigneeKind: 'node', assigneeRef: 'node-1' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    const plain = await space.tasks.create({ title: 'Plain', source: 'user' });
    await expect(space.tasks.update(plain.id, { assigneeKind: 'role', assigneeRef: 'research' })).rejects.toMatchObject({ code: 'invalid_input' });
    // A row written before the rule (raw SQL) still never wakes a heartbeat.
    const [task] = await q(`INSERT INTO tasks (user_id, title, workspace_id, assignee_kind, assignee_ref, source, status) VALUES ($1, 'Role work', $2, 'role', 'research', 'user', 'open') RETURNING id`, [bob, spaceId]);
    const { ensureRoleHeartbeatHook } = await import('@/core/heartbeat');
    const hookId = await ensureRoleHeartbeatHook(bob, 'research');
    // Not due now, so a mark would show.
    await q(`UPDATE hooks SET next_run_at = now() + interval '1 hour' WHERE id = $1`, [hookId]);
    expect(await markRoleHeartbeatDue(bob, task.id)).toEqual([]);
    // The same assignment on a personal task does mark it.
    const personal = contentRepos(await resolvedPrincipal(bob, null));
    const own = await personal.tasks.create({ title: 'Personal role work', source: 'user', assigneeKind: 'role', assigneeRef: 'research' });
    expect(await markRoleHeartbeatDue(bob, own.id)).toEqual([hookId]);
  });

  test('the bridge resolves a space task by its space, never by a personal owner scope', async () => {
    const { defaultResolveTitles, receiveWakeups, encodeWakeups } = await import('./wakeup-bridge');
    const { contentRepos } = await import('@/db/repositories/content');
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const space = contentRepos(await resolvedPrincipal(carol, spaceId));
    const task = await space.tasks.create({ title: 'Remote wake', source: 'user' });
    const event: TaskWakeupEvent = { type: 'task.unblocked', userId: carol, workspaceId: spaceId, taskId: task.id, title: '', triggeredBy: randomUUID(), cause: 'closed' };
    const [payload] = encodeWakeups('other-process', [event]);
    const got = await receiveWakeups(payload, 'this-process', defaultResolveTitles);
    expect(got.map((e) => e.title)).toEqual(['Remote wake']);
    // The same id named as someone else's personal task does not resolve.
    const [forged] = encodeWakeups('other-process', [{ ...event, workspaceId: null }]);
    expect(await receiveWakeups(forged, 'this-process', defaultResolveTitles)).toEqual([]);
  });

  test('a space assignee must be a member; a personal assignee only the owner', async () => {
    const { contentRepos } = await import('@/db/repositories/content');
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const outsider = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: outsider, username: `w-out-${rand(3)}` }]);
    const space = contentRepos(await resolvedPrincipal(alice, spaceId));
    await expect(space.tasks.create({ title: 'To an outsider', source: 'user', assigneeKind: 'user', assigneeRef: outsider }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(space.tasks.create({ title: 'To nobody', source: 'user', assigneeKind: 'user', assigneeRef: 'not-a-user' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    const ok = await space.tasks.create({ title: 'To Bob', source: 'user', assigneeKind: 'user', assigneeRef: bob });
    await expect(space.tasks.update(ok.id, { assigneeRef: outsider })).rejects.toMatchObject({ code: 'invalid_input' });

    const personal = contentRepos(await resolvedPrincipal(alice, null));
    await expect(personal.tasks.create({ title: 'To the victim', source: 'user', assigneeKind: 'user', assigneeRef: outsider }))
      .rejects.toThrow(/only to its owner/);
    expect((await personal.tasks.create({ title: 'Mine', source: 'user', assigneeKind: 'user', assigneeRef: alice })).assigneeRef).toBe(alice);
  });

  test('notifications go to people with access at send time: never a stored foreign ref, never a removed member', async () => {
    const { contentRepos } = await import('@/db/repositories/content');
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const { flushWakeups } = await import('./wakeups');
    const victim = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: victim, username: `w-victim-${rand(3)}` }]);

    // Personal: a dependent whose stored assignee names another user (as a
    // row written before the rule would) — only its owner hears of it.
    const personal = contentRepos(await resolvedPrincipal(alice, null));
    const blocker = await personal.tasks.create({ title: 'Personal blocker', source: 'user' });
    const dependent = await personal.tasks.create({ title: 'Click this link', source: 'user', blockedBy: [blocker.id] });
    await q(`UPDATE tasks SET assignee_kind = 'user', assignee_ref = $2 WHERE id = $1`, [dependent.id, victim]);
    await personal.tasks.update(blocker.id, { status: 'done' });
    await flushWakeups();
    const personalNotes = await q(`SELECT user_id FROM notifications WHERE metadata->>'taskId' = $1`, [dependent.id]);
    expect(personalNotes.map((n) => n.user_id)).toEqual([alice]);

    // Space: Carol is the assignee, then is removed; Bob, the author, still hears.
    const space = contentRepos(await resolvedPrincipal(bob, spaceId));
    const spaceBlocker = await space.tasks.create({ title: 'Space blocker 2', source: 'user' });
    const spaceDependent = await space.tasks.create({ title: 'For Carol', source: 'user', blockedBy: [spaceBlocker.id], assigneeKind: 'user', assigneeRef: carol });
    const { removeMember } = await import('@/core/spaces/service');
    await removeMember({ userId: alice }, spaceId, carol);
    await space.tasks.update(spaceBlocker.id, { status: 'done' });
    await flushWakeups();
    const spaceNotes = await q(`SELECT user_id FROM notifications WHERE metadata->>'taskId' = $1`, [spaceDependent.id]);
    expect(spaceNotes.map((n) => n.user_id)).toEqual([bob]);
  });
});
