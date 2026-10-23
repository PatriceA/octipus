/**
 * Cases, contacts, case links and follow-ups (docs/CASES.md) through
 * `contentRepos`: personal rows stay their owner's, space rows follow the
 * member's role, a guest reaches none, links only reach entities of the same
 * scope, and a due follow-up reminds its assignee once.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ContentRepos } from '@/db/repositories/content';
import type { Principal } from '@/security/principal';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const carol = '33333333-3333-4333-8333-333333333333';
const dave = '44444444-4444-4444-8444-444444444444';
const erin = '55555555-5555-4555-8555-555555555555';

let spaceId: string;
let repos: (p: Principal) => ContentRepos;
let personal: (userId: string) => Promise<ContentRepos>;
let inSpace: (userId: string) => Promise<ContentRepos>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-cases-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES
       ('${alice}', 'alice', false), ('${bob}', 'bob', false), ('${carol}', 'carol', false),
       ('${dave}', 'dave', false), ('${erin}', 'erin', false)
     ON CONFLICT DO NOTHING`,
  );
  const { spaceWith, resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  // alice owns; bob edits; carol views; dave is a guest.
  spaceId = await spaceWith(alice, [[bob, 'editor'], [carol, 'viewer'], [dave, 'guest']]);
  const { contentRepos } = await import('@/db/repositories/content');
  repos = contentRepos;
  personal = async (userId) => contentRepos(await resolvedPrincipal(userId, null));
  inSpace = async (userId) => contentRepos(await resolvedPrincipal(userId, spaceId));
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('personal cases and contacts', () => {
  test('another user reads, lists and changes none of them', async () => {
    const a = await personal(alice);
    const b = await personal(bob);
    const c = await a.cases.create({ title: 'Invoice 4711', kind: 'invoice' });
    const k = await a.contacts.create({ name: 'Maria Muster', tags: ['client'] });

    expect((await a.cases.findById(c.id))?.title).toBe('Invoice 4711');
    expect(await b.cases.findById(c.id)).toBeNull();
    expect((await b.cases.list()).map((r) => r.id)).not.toContain(c.id);
    expect(await b.cases.update(c.id, { title: 'stolen' })).toBeNull();
    expect(await b.cases.delete(c.id)).toBeNull();
    expect(await b.contacts.findById(k.id)).toBeNull();
    expect(await b.contacts.update(k.id, { name: 'stolen' })).toBeNull();
    expect(await b.contacts.delete(k.id)).toBeNull();
    expect((await a.contacts.findById(k.id))?.name).toBe('Maria Muster');
  });

  test('a personal case is assigned only to its owner', async () => {
    const a = await personal(alice);
    await expect(a.cases.create({ title: 'x', assigneeUserId: bob })).rejects.toThrow(/only to its owner/);
    expect((await a.cases.create({ title: 'mine', assigneeUserId: alice })).assigneeUserId).toBe(alice);
  });

  test('closedAt follows the status', async () => {
    const a = await personal(alice);
    const c = await a.cases.create({ title: 'Complaint' });
    expect(c.closedAt).toBeNull();
    const done = await a.cases.update(c.id, { status: 'done' });
    expect(done?.closedAt).toBeInstanceOf(Date);
    const archived = await a.cases.update(c.id, { status: 'archived' });
    expect(archived?.closedAt?.getTime()).toBe(done?.closedAt?.getTime());
    expect((await a.cases.update(c.id, { status: 'waiting' }))?.closedAt).toBeNull();
  });

  test('createOnce returns the existing case for the same external key', async () => {
    const a = await personal(alice);
    const first = await a.cases.createOnce({ title: 'From DATEV', externalKey: 'datev:1' });
    const again = await a.cases.createOnce({ title: 'From DATEV again', externalKey: 'datev:1' });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.case.id).toBe(first.case.id);
    // Another user's key space is their own.
    const other = await (await personal(bob)).cases.createOnce({ title: 'Bob', externalKey: 'datev:1' });
    expect(other.created).toBe(true);
  });

  test('a person belongs only to an organisation of the same scope', async () => {
    const a = await personal(alice);
    const b = await personal(bob);
    const org = await a.contacts.create({ name: 'Pflege GmbH', kind: 'organization' });
    const person = await a.contacts.create({ name: 'Anna', organizationId: org.id });
    expect(person.organizationId).toBe(org.id);
    await expect(a.contacts.create({ name: 'Ben', organizationId: person.id })).rejects.toThrow(/kind "organization"/);
    await expect(b.contacts.create({ name: 'Eve', organizationId: org.id })).rejects.toThrow(/Organization not found/);
    await expect(a.contacts.update(org.id, { kind: 'person' })).rejects.toThrow(/still has people/);
    expect((await a.contacts.list({ organizationId: org.id })).map((c) => c.id)).toEqual([person.id]);
    await a.contacts.delete(org.id);
    expect((await a.contacts.findById(person.id))?.organizationId).toBeNull();
  });

  test('search treats % and _ literally', async () => {
    const a = await personal(alice);
    await a.contacts.create({ name: '100% Service' });
    await a.contacts.create({ name: 'Plain' });
    const hits = await a.contacts.list({ q: '%' });
    expect(hits.map((c) => c.name)).toEqual(['100% Service']);
  });
});

describe('case links', () => {
  test('link only what the scope reaches; reads drop what is gone', async () => {
    const { linkToCase, caseLinks, CaseLinkError } = await import('@/core/cases/links');
    const a = await personal(alice);
    const b = await personal(bob);
    const c = await a.cases.create({ title: 'Inquiry' });
    const mine = await a.contacts.create({ name: 'Client' });
    const theirs = await b.contacts.create({ name: 'Not yours' });
    const task = await a.tasks.create({ title: 'call back' });

    const link = await linkToCase(a, c.id, { entityType: 'contact', entityId: mine.id, role: 'client' });
    expect(link?.label).toBe('Client');
    await expect(linkToCase(a, c.id, { entityType: 'contact', entityId: theirs.id })).rejects.toBeInstanceOf(CaseLinkError);
    await expect(linkToCase(a, c.id, { entityType: 'invoice', entityId: mine.id })).rejects.toThrow(/Unknown entity type/);
    // Bob cannot link into alice's case, even his own contact.
    expect(await linkToCase(b, c.id, { entityType: 'contact', entityId: theirs.id })).toBeNull();

    await linkToCase(a, c.id, { entityType: 'task', entityId: task.id });
    // Linking again changes the role, not the count.
    await linkToCase(a, c.id, { entityType: 'contact', entityId: mine.id, role: 'sender' });
    let links = await caseLinks(a, c.id);
    expect(links?.map((l) => [l.entityType, l.role])).toEqual([['contact', 'sender'], ['task', null]]);

    // A deleted task's link is dropped on read; a deleted contact's is removed.
    await a.tasks.delete(task.id);
    await a.contacts.delete(mine.id);
    links = await caseLinks(a, c.id);
    expect(links).toEqual([]);
    expect(await caseLinks(b, c.id)).toBeNull();

    const linked = await a.cases.casesLinkedTo('contact', mine.id);
    expect(linked).toEqual([]);
  });

  test('a read removes links whose entity is gone, keeps those out of reach', async () => {
    const { linkToCase, caseLinks } = await import('@/core/cases/links');
    const { queryRaw } = await import('@/db/postgres');
    const { spaceWith, resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const s = await spaceWith(alice, [[bob, 'editor'], [carol, 'viewer']]);
    const owner = repos(await resolvedPrincipal(alice, s));
    const viewer = repos(await resolvedPrincipal(carol, s));
    const c = await owner.cases.create({ title: 'Cleanup' });
    const task = await owner.tasks.create({ title: 'goes away' });
    const art = await owner.artifacts.create({ slug: `private-${rand(3)}`, title: 'Mine only', type: 'html', visibility: 'private' });
    await linkToCase(owner, c.id, { entityType: 'task', entityId: task.id });
    await linkToCase(owner, c.id, { entityType: 'artifact', entityId: art.id });
    await owner.tasks.delete(task.id);

    // The viewer sees neither: the task is gone, the artifact is the owner's.
    expect(await caseLinks(viewer, c.id)).toEqual([]);
    const { rows } = await queryRaw(`SELECT entity_type FROM case_links WHERE case_id = $1 ORDER BY entity_type`, [c.id]);
    expect(rows.map((r: { entity_type: string }) => r.entity_type)).toEqual(['artifact']);
    expect((await caseLinks(owner, c.id))?.map((l) => l.label)).toEqual(['Mine only']);
  });

  test('casesLinkedTo finds the cases of an entity, scoped', async () => {
    const { linkToCase } = await import('@/core/cases/links');
    const a = await personal(alice);
    const c = await a.cases.create({ title: 'Linked' });
    const k = await a.contacts.create({ name: 'Linked contact' });
    await linkToCase(a, c.id, { entityType: 'contact', entityId: k.id, role: 'client' });
    expect((await a.cases.casesLinkedTo('contact', k.id)).map((r) => [r.case.id, r.role])).toEqual([[c.id, 'client']]);
    expect(await (await personal(bob)).cases.casesLinkedTo('contact', k.id)).toEqual([]);
  });
});

describe('cases in a space', () => {
  test('members read, editors write, viewers do not, guests see nothing', async () => {
    const editor = await inSpace(bob);
    const viewer = await inSpace(carol);
    const guest = await inSpace(dave);
    const c = await editor.cases.create({ title: 'Space complaint', kind: 'complaint' });
    const k = await editor.contacts.create({ name: 'Space client' });
    expect(c.workspaceId).toBe(spaceId);
    expect(c.userId).toBe(bob);

    expect((await (await inSpace(alice)).cases.findById(c.id))?.id).toBe(c.id);
    expect((await viewer.cases.findById(c.id))?.id).toBe(c.id);
    await expect(viewer.cases.create({ title: 'no' })).rejects.toMatchObject({ code: 'forbidden_role' });
    await expect(viewer.cases.update(c.id, { title: 'no' })).rejects.toMatchObject({ code: 'forbidden_role' });
    await expect(viewer.contacts.create({ name: 'no' })).rejects.toMatchObject({ code: 'forbidden_role' });

    expect(await guest.cases.findById(c.id)).toBeNull();
    expect(await guest.cases.list()).toEqual([]);
    expect(await guest.contacts.findById(k.id)).toBeNull();
    expect(await guest.contacts.list()).toEqual([]);
  });

  test('personal paths never return space rows', async () => {
    const editor = await inSpace(bob);
    const c = await editor.cases.create({ title: 'Only in the space' });
    const k = await editor.contacts.create({ name: 'Only in the space' });
    const own = await personal(bob);
    expect(await own.cases.findById(c.id)).toBeNull();
    expect((await own.cases.list()).map((r) => r.id)).not.toContain(c.id);
    expect(await own.contacts.findById(k.id)).toBeNull();
    // An admin's personal by-id read does not cross into the space either.
    const { principalFromUser } = await import('@/security/principal');
    const admin = repos(principalFromUser({ id: erin, username: 'erin', isAdmin: true }));
    expect(await admin.cases.findById(c.id)).toBeNull();
  });

  test('a space case is assigned to a member who is not a guest', async () => {
    const editor = await inSpace(bob);
    expect((await editor.cases.create({ title: 'ok', assigneeUserId: carol })).assigneeUserId).toBe(carol);
    await expect(editor.cases.create({ title: 'guest', assigneeUserId: dave })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(editor.cases.create({ title: 'stranger', assigneeUserId: erin })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('a space case links only space entities', async () => {
    const { linkToCase, CaseLinkError } = await import('@/core/cases/links');
    const editor = await inSpace(bob);
    const c = await editor.cases.create({ title: 'Space case' });
    const personalContact = await (await personal(bob)).contacts.create({ name: 'Bob private' });
    await expect(linkToCase(editor, c.id, { entityType: 'contact', entityId: personalContact.id })).rejects.toBeInstanceOf(CaseLinkError);
    const spaceContact = await editor.contacts.create({ name: 'Shared' });
    expect((await linkToCase(editor, c.id, { entityType: 'contact', entityId: spaceContact.id }))?.label).toBe('Shared');
  });
});

describe('follow-ups', () => {
  async function remindersFor(userId: string): Promise<Array<{ title: string; workspace_id: string | null; metadata: Record<string, unknown> }>> {
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `SELECT title, workspace_id, metadata FROM notifications WHERE user_id = $1 AND type = 'task_reminder' ORDER BY created_at`,
      [userId],
    );
    return rows;
  }

  test('a due follow-up reminds its assignee once; a new date re-arms it', async () => {
    const { addFollowUp } = await import('@/core/cases/links');
    const { fireDueReminders } = await import('@/core/tasks/reminders');
    const a = await personal(alice);
    const c = await a.cases.create({ title: 'Contract renewal', assigneeUserId: alice });
    const past = new Date(Date.now() - 60_000);
    const result = await addFollowUp(a, c.id, { title: 'Check the notice period', remindAt: past });
    expect(result?.task.assigneeRef).toBe(alice);
    expect(result?.link.role).toBe('follow_up');
    const future = await addFollowUp(a, c.id, { title: 'Later', remindAt: new Date(Date.now() + 3_600_000) });

    expect(await fireDueReminders()).toBeGreaterThanOrEqual(1);
    const sent = (await remindersFor(alice)).filter((n) => n.title === 'Follow-up: Check the notice period');
    expect(sent).toHaveLength(1);
    expect(sent[0].metadata.caseIds).toEqual([c.id]);
    await fireDueReminders();
    expect((await remindersFor(alice)).filter((n) => n.title === 'Follow-up: Check the notice period')).toHaveLength(1);
    expect((await remindersFor(alice)).some((n) => n.title === 'Follow-up: Later')).toBe(false);

    // The same date sent again (a client echoing the row) does not re-arm it.
    await a.tasks.update(result!.task.id, { remindAt: past, notes: 'edited' });
    await fireDueReminders();
    expect((await remindersFor(alice)).filter((n) => n.title === 'Follow-up: Check the notice period')).toHaveLength(1);

    // A new date clears the stamp; once it passes, it reminds again.
    await a.tasks.update(result!.task.id, { remindAt: new Date(past.getTime() - 1000) });
    await fireDueReminders();
    expect((await remindersFor(alice)).filter((n) => n.title === 'Follow-up: Check the notice period')).toHaveLength(2);

    // A closed task does not remind.
    await a.tasks.update(future!.task.id, { status: 'done', remindAt: past });
    await fireDueReminders();
    expect((await remindersFor(alice)).some((n) => n.title === 'Follow-up: Later')).toBe(false);
  });

  test('a bare date is the start of that day in the user\'s zone', async () => {
    const { parseTaskDate } = await import('@/core/tasks/timezone');
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE users SET preferences = '{"timezone":"Europe/Berlin"}'::jsonb WHERE id = '${alice}'`);
    expect((await parseTaskDate('2030-07-01', 'remindAt', alice)).toISOString()).toBe('2030-06-30T22:00:00.000Z');
    expect((await parseTaskDate('2030-07-01', 'dueAt', alice)).toISOString()).toBe('2030-07-01T21:59:59.999Z');
    expect((await parseTaskDate('2030-07-01T09:00:00Z', 'remindAt', alice)).toISOString()).toBe('2030-07-01T09:00:00.000Z');
    await expect(parseTaskDate('next week', 'remindAt', alice)).rejects.toThrow(/Invalid remindAt/);
  });

  test('a follow-up does not inherit a case assignee who left the space', async () => {
    const { addFollowUp } = await import('@/core/cases/links');
    const { spaceWith, resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const s = await spaceWith(alice, [[bob, 'editor'], [carol, 'editor']]);
    const editor = repos(await resolvedPrincipal(bob, s));
    const c = await editor.cases.create({ title: 'Assigned to carol', assigneeUserId: carol });
    const { removeMember } = await import('@/core/spaces/service');
    await removeMember({ userId: alice }, s, carol);
    const result = await addFollowUp(editor, c.id, { title: 'still possible', remindAt: new Date(Date.now() + 3_600_000) });
    expect(result?.task.assigneeKind).toBeNull();
  });

  test('in a space the assignee is reminded in the space, the author when the assignee left', async () => {
    const { addFollowUp } = await import('@/core/cases/links');
    const { fireDueReminders } = await import('@/core/tasks/reminders');
    const { spaceWith, resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const otherSpace = await spaceWith(alice, [[bob, 'editor'], [erin, 'editor']]);
    const editor = repos(await resolvedPrincipal(bob, otherSpace));
    const c = await editor.cases.create({ title: 'Space renewal' });
    const past = new Date(Date.now() - 60_000);
    await addFollowUp(editor, c.id, { title: 'Erin follows up', remindAt: past, assigneeUserId: erin });
    await addFollowUp(editor, c.id, { title: 'Erin leaves first', remindAt: new Date(Date.now() + 3_600_000), assigneeUserId: erin });

    await fireDueReminders();
    const erinGot = (await remindersFor(erin)).filter((n) => n.title === 'Follow-up: Erin follows up');
    expect(erinGot).toHaveLength(1);
    expect(erinGot[0].workspace_id).toBe(otherSpace);

    const { removeMember } = await import('@/core/spaces/service');
    await removeMember({ userId: alice }, otherSpace, erin);
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE tasks SET remind_at = now() - interval '1 minute' WHERE title = 'Erin leaves first'`);
    await fireDueReminders();
    expect((await remindersFor(erin)).some((n) => n.title === 'Follow-up: Erin leaves first')).toBe(false);
    expect((await remindersFor(bob)).some((n) => n.title === 'Follow-up: Erin leaves first')).toBe(true);
  });
});
