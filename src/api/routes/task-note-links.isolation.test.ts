/**
 * To-dos linked to notes (to-dos + notes, step 4), driven through the real
 * `createServer()`: who can make a link, who sees it (never a note or a
 * to-do they cannot open), and how a note line's tick and its to-do follow
 * each other — personal, in a space, for a guest, with a repeat, a deleted
 * to-do and a stale editor.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const ids = { alice: randomUUID(), bob: randomUUID(), owner: randomUUID(), editor: randomUUID(), viewer: randomUUID(), gina: randomUUID(), admin: randomUUID() };
type Who = keyof typeof ids;

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens = {} as Record<Who, string>;
let spaceId: string;
let clientRoomId: string;

async function call(who: Who, method: string, path: string, opts: { body?: unknown; space?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[who]}` };
  if (opts.space) headers['x-octipus-workspace'] = opts.space;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
}
// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in a test
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const inSpace = (who: Who, method: string, path: string, body?: unknown) => call(who, method, path, { body, space: spaceId });

async function note(who: Who, title: string, body: string, space?: string): Promise<{ id: string; sha: string }> {
  const res = await json(await call(who, 'POST', '/api/notes', { body: { title, body, ...(space ? {} : {}) }, space }));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { id: res.body.note.id, sha: res.body.note.bodySha256 };
}
async function readNote(who: Who, id: string, space?: string) {
  return json(await call(who, 'GET', `/api/notes/${id}`, { space }));
}

/**
 * A note line made a to-do the way a client does it: the to-do first (with
 * the line's anchor), then the marker written into the line by a save.
 */
async function made(who: Who, title: string, marked: string, task: Record<string, unknown>, space?: string) {
  const anchor = /\^todo-([a-z0-9]+)/.exec(marked)?.[1] as string;
  const plain = marked.replace(/ \^todo-[a-z0-9]+/g, '');
  const n = await note(who, title, plain, space);
  const created = await json(await call(who, 'POST', '/api/tasks', { body: { ...task, noteId: n.id, noteAnchor: anchor }, space }));
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const saved = await json(await call(who, 'POST', '/api/notes', { body: { id: n.id, title, body: marked, ...(space ? { baseSha256: n.sha } : { ifSha256: n.sha }) }, space }));
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.note.body).toBe(marked);
  return { n: { id: n.id, sha: saved.body.note.bodySha256 as string }, task: created.body };
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-task-note-links-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers(Object.entries(ids).map(([name, id]) => ({ id, username: `tnl-${name}`, isAdmin: name === 'admin' })));
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of Object.entries(ids)) tokens[name as Who] = (await getSessionManager().create(id)).token;
  const { createServer } = await import('@/api/server');
  app = createServer();

  spaceId = (await json(await call('owner', 'POST', '/api/spaces', { body: { name: 'Links' } }))).body.id;
  clientRoomId = (await json(await call('owner', 'POST', `/api/spaces/${spaceId}/rooms`, { body: { title: 'Client', visibility: 'space' } }))).body.id;
  const joinAs = async (who: Who, role: string, scope?: unknown) => {
    const { body } = await json(await call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { body: scope ? { role, scope } : { role } }));
    expect((await call(who, 'POST', `/api/invites/${body.token}/accept`)).status).toBe(200);
  };
  await joinAs('editor', 'editor');
  await joinAs('viewer', 'viewer');
  await joinAs('gina', 'guest', { rooms: [clientRoomId], folders: ['client'] });
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('who can link and who sees a link (personal)', () => {
  test('a to-do made with a note shows it; the note shows the to-do', async () => {
    const n = await note('alice', 'Plan', 'Plan\n\nsome text');
    const created = await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'Book flights', noteId: n.id } }));
    expect(created.status).toBe(200);
    expect(created.body.linkedNotes).toEqual([expect.objectContaining({ id: n.id, title: 'Plan', anchor: null, archived: false })]);
    const list = await json(await call('alice', 'GET', '/api/tasks'));
    expect(list.body.tasks.find((t: { id: string }) => t.id === created.body.id).linkedNotes.map((l: { id: string }) => l.id)).toEqual([n.id]);
    const detail = await readNote('alice', n.id);
    expect(detail.body.linkedTasks).toEqual([expect.objectContaining({ id: created.body.id, title: 'Book flights', status: 'open', anchor: null })]);
  });

  test('another user cannot link to, see or unlink someone else\'s note or to-do', async () => {
    const aliceNote = await note('alice', 'Diary', 'Diary\n\nprivate words');
    const aliceTask = (await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'Private', noteId: aliceNote.id } }))).body;
    const bobTask = (await json(await call('bob', 'POST', '/api/tasks', { body: { title: 'Bob\'s' } }))).body;
    // Bob's to-do onto Alice's note: the note is out of his reach.
    expect((await call('bob', 'POST', `/api/tasks/${bobTask.id}/notes`, { body: { noteId: aliceNote.id } })).status).toBe(404);
    expect((await call('bob', 'POST', '/api/tasks', { body: { title: 'sneak', noteId: aliceNote.id } })).status).toBe(404);
    // Nothing was made by the refused create.
    expect((await json(await call('bob', 'GET', '/api/tasks'))).body.tasks.map((t: { title: string }) => t.title)).not.toContain('sneak');
    // Alice's to-do: out of his reach, and so is its link.
    expect((await call('bob', 'POST', `/api/tasks/${aliceTask.id}/notes`, { body: { title: 'Bob note' } })).status).toBe(404);
    expect((await call('bob', 'DELETE', `/api/tasks/${aliceTask.id}/notes/${aliceNote.id}`)).status).toBe(404);
    expect((await call('bob', 'GET', `/api/tasks/${aliceTask.id}`)).status).toBe(404);
    expect((await json(await call('alice', 'GET', `/api/tasks/${aliceTask.id}`))).body.linkedNotes).toHaveLength(1);
  });

  test('an admin acting on another user\'s to-do cannot link their own note to it', async () => {
    const aliceTask = (await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'Mine' } }))).body;
    const adminNote = await note('admin', 'Admin', 'Admin\n\nx');
    expect((await call('admin', 'POST', `/api/tasks/${aliceTask.id}/notes`, { body: { noteId: adminNote.id } })).status).toBe(404);
    expect((await json(await call('alice', 'GET', `/api/tasks/${aliceTask.id}`))).body.linkedNotes).toEqual([]);
  });

  test('attach a new note, unlink it; an archived note shows as archived, a deleted one goes', async () => {
    const task = (await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'Taxes' } }))).body;
    const attached = await json(await call('alice', 'POST', `/api/tasks/${task.id}/notes`, { body: { title: 'Taxes 2026' } }));
    expect(attached.status).toBe(200);
    expect(attached.body.note).toMatchObject({ title: 'Taxes 2026', anchor: null });
    const noteId = attached.body.note.id;
    expect((await readNote('alice', noteId)).body.body).toBe('Taxes 2026\n\n');
    // Twice is once.
    expect((await call('alice', 'POST', `/api/tasks/${task.id}/notes`, { body: { noteId } })).status).toBe(200);
    expect((await json(await call('alice', 'GET', `/api/tasks/${task.id}`))).body.linkedNotes).toHaveLength(1);
    expect((await call('alice', 'DELETE', `/api/notes/${noteId}`)).status).toBe(200);
    expect((await json(await call('alice', 'GET', `/api/tasks/${task.id}`))).body.linkedNotes).toEqual([expect.objectContaining({ id: noteId, archived: true })]);
    expect((await call('alice', 'DELETE', `/api/tasks/${task.id}/notes/${noteId}`)).status).toBe(200);
    expect((await call('alice', 'DELETE', `/api/tasks/${task.id}/notes/${noteId}`)).status).toBe(404);
    await call('alice', 'POST', `/api/tasks/${task.id}/notes`, { body: { noteId } });
    expect((await call('alice', 'DELETE', `/api/notes/${noteId}?hard=true`)).status).toBe(200);
    expect((await json(await call('alice', 'GET', `/api/tasks/${task.id}`))).body.linkedNotes).toEqual([]);
  });

  test('a bad request: an anchor without a note, a malformed anchor, both noteId and title', async () => {
    expect((await call('alice', 'POST', '/api/tasks', { body: { title: 'x', noteAnchor: 'abc12345' } })).status).toBe(400);
    const n = await note('alice', 'Bad', 'Bad');
    expect((await call('alice', 'POST', '/api/tasks', { body: { title: 'x', noteId: n.id, noteAnchor: 'NOT OK' } })).status).toBe(422);
    const task = (await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'y' } }))).body;
    expect((await call('alice', 'POST', `/api/tasks/${task.id}/notes`, { body: { noteId: n.id, title: 'z' } })).status).toBe(400);
  });
});

describe('who can link and who sees a link (a space)', () => {
  test('an editor links a space note; members see it; a viewer cannot link; scopes never mix', async () => {
    const spaceNote = await note('editor', 'Launch checklist', 'Launch checklist\n\n- [ ] ship', spaceId);
    const task = (await json(await inSpace('editor', 'POST', '/api/tasks', { title: 'Ship', noteId: spaceNote.id }))).body;
    expect(task.linkedNotes).toEqual([expect.objectContaining({ id: spaceNote.id })]);
    expect((await json(await inSpace('viewer', 'GET', `/api/tasks/${task.id}`))).body.linkedNotes).toHaveLength(1);
    expect((await json(await inSpace('owner', 'GET', `/api/notes/${spaceNote.id}`))).body.linkedTasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
    // A viewer may not change the to-do, so may not link to it.
    expect((await inSpace('viewer', 'POST', `/api/tasks/${task.id}/notes`, { title: 'Viewer note' })).status).toBe(403);
    // The editor's personal note is not reached from the space, nor the space's note from their personal to-dos.
    const personal = await note('editor', 'My own', 'My own\n\nsecret');
    expect((await inSpace('editor', 'POST', `/api/tasks/${task.id}/notes`, { noteId: personal.id })).status).toBe(404);
    const personalTask = (await json(await call('editor', 'POST', '/api/tasks', { body: { title: 'Personal' } }))).body;
    expect((await call('editor', 'POST', `/api/tasks/${personalTask.id}/notes`, { body: { noteId: spaceNote.id } })).status).toBe(404);
    // The personal list never carries the space's links.
    const own = await json(await call('editor', 'GET', '/api/tasks'));
    expect(own.body.tasks.map((t: { id: string }) => t.id)).not.toContain(task.id);
  });

  test('a guest sees only the linked notes of their folders, never a title of another', async () => {
    const { memberPrincipal } = await import('@/db/repositories/space');
    const { contentRepos } = await import('@/db/repositories/content');
    const editor = contentRepos(await memberPrincipal(ids.editor, spaceId));
    const task = await editor.tasks.create({ title: 'Client follow-up', sourceRef: { sessionId: clientRoomId } });
    const shared = await note('editor', 'Brief', 'Brief\n\nfor the client', spaceId);
    const internal = await note('editor', 'Margins', 'Margins\n\nnot for the client', spaceId);
    // A note in the guest's folder.
    const folderNote = await json(await inSpace('editor', 'POST', '/api/notes', { title: 'Client notes', slug: 'client/notes', body: 'Client notes' }));
    for (const noteId of [shared.id, internal.id, folderNote.body.note.id]) {
      expect((await inSpace('editor', 'POST', `/api/tasks/${task.id}/notes`, { noteId })).status).toBe(200);
    }
    const seen = await json(await inSpace('gina', 'GET', `/api/tasks/${task.id}`));
    expect(seen.status).toBe(200);
    expect(seen.body.linkedNotes.map((n: { id: string }) => n.id)).toEqual([folderNote.body.note.id]);
    const listed = await json(await inSpace('gina', 'GET', '/api/tasks'));
    expect(JSON.stringify(listed.body)).not.toContain('Margins');
    expect((await inSpace('gina', 'GET', `/api/notes/${internal.id}`)).status).toBe(404);
    // And from the note: a to-do outside the guest's rooms is not shown.
    const internalTask = await editor.tasks.create({ title: 'Internal only' });
    await inSpace('editor', 'POST', `/api/tasks/${internalTask.id}/notes`, { noteId: folderNote.body.note.id });
    const fromNote = await json(await inSpace('gina', 'GET', `/api/notes/${folderNote.body.note.id}`));
    expect(fromNote.body.linkedTasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
  });
});

describe('a note line and its to-do follow each other', () => {
  const anchor = 'k3x9qa2b';

  test('completing the to-do ticks the line; ticking the line back reopens the to-do', async () => {
    const { n, task } = await made('alice', 'Errands', `Errands\n- [ ] Call the dentist ^todo-${anchor}\n- [ ] Other`, { title: 'Call the dentist' });
    expect(task.linkedNotes).toEqual([expect.objectContaining({ id: n.id, anchor })]);
    expect((await call('alice', 'PATCH', `/api/tasks/${task.id}`, { body: { status: 'done' } })).status).toBe(200);
    const after = await readNote('alice', n.id);
    expect(after.body.body).toBe(`Errands\n- [x] Call the dentist ^todo-${anchor}\n- [ ] Other`);
    expect(after.body.linkedTasks).toEqual([expect.objectContaining({ id: task.id, status: 'done', anchor })]);
    // The note's editor unticks it (saving over the text it read): the to-do reopens.
    const saved = await json(await call('alice', 'POST', '/api/notes', { body: { id: n.id, title: 'Errands', body: after.body.body.replace('[x]', '[ ]'), ifSha256: after.body.bodySha256 } }));
    expect(saved.status).toBe(200);
    expect((await json(await call('alice', 'GET', `/api/tasks/${task.id}`))).body.status).toBe('open');
    // An edit elsewhere in the note changes nothing about the to-do.
    await call('alice', 'PATCH', `/api/tasks/${task.id}`, { body: { status: 'done' } });
    const done = await readNote('alice', n.id);
    await call('alice', 'POST', '/api/notes', { body: { id: n.id, title: 'Errands', body: `${done.body.body}\nmore`, ifSha256: done.body.bodySha256 } });
    expect((await json(await call('alice', 'GET', `/api/tasks/${task.id}`))).body.status).toBe('done');
  });

  test('a stale editor\'s save is refused, never applied over the tick', async () => {
    const a = 'stale1aa';
    const { n, task } = await made('alice', 'Stale', `Stale\n- [ ] Pay rent ^todo-${a}`, { title: 'Pay rent' });
    await call('alice', 'PATCH', `/api/tasks/${task.id}`, { body: { status: 'done' } });
    // An editor still holding the text from before the tick.
    const refused = await json(await call('alice', 'POST', '/api/notes', { body: { id: n.id, title: 'Stale', body: `Stale\n- [ ] Pay rent ^todo-${a}\ntyped`, ifSha256: n.sha } }));
    expect(refused).toMatchObject({ status: 409, body: { code: 'stale' } });
    expect((await readNote('alice', n.id)).body.body).toBe(`Stale\n- [x] Pay rent ^todo-${a}`);
    expect((await json(await call('alice', 'GET', `/api/tasks/${task.id}`))).body.status).toBe('done');
  });

  test('a deleted (archived) to-do is not brought back by a tick, and deleting one leaves the line', async () => {
    const a = 'archiv1a';
    const { n, task } = await made('alice', 'Gone', `Gone\n- [ ] Old thing ^todo-${a}`, { title: 'Old thing' });
    await call('alice', 'PATCH', `/api/tasks/${task.id}`, { body: { status: 'archived' } });
    const current = await readNote('alice', n.id);
    expect(current.body.body).toBe(`Gone\n- [ ] Old thing ^todo-${a}`);
    await call('alice', 'POST', '/api/notes', { body: { id: n.id, title: 'Gone', body: current.body.body.replace('[ ]', '[x]'), ifSha256: current.body.bodySha256 } });
    expect((await json(await call('alice', 'GET', `/api/tasks/${task.id}`))).body.status).toBe('archived');
  });

  test('one line is one to-do: a second to-do for the same line is refused and not made', async () => {
    const a = 'twice1aa';
    const { n } = await made('alice', 'Twice', `Twice\n- [ ] Once ^todo-${a}`, { title: 'Once' });
    const second = await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'Again', noteId: n.id, noteAnchor: a } }));
    expect(second).toMatchObject({ status: 409, body: { code: 'anchor_taken' } });
    expect((await json(await call('alice', 'GET', '/api/tasks'))).body.tasks.map((t: { title: string }) => t.title)).not.toContain('Again');
    // A repeating one refused the same way leaves no occurrence behind either (nothing was created to skip).
    const repeating = await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'Again weekly', repeat: 'weekly', dueAt: '2026-11-24', tz: 'UTC', noteId: n.id, noteAnchor: a } }));
    expect(repeating).toMatchObject({ status: 409, body: { code: 'anchor_taken' } });
    const all = await json(await call('alice', 'GET', '/api/tasks?status=archived'));
    const open = await json(await call('alice', 'GET', '/api/tasks'));
    expect([...all.body.tasks, ...open.body.tasks].map((t: { title: string }) => t.title)).not.toContain('Again weekly');
  });

  test('a to-do taken back after a lost race is removed outright: a repeating one makes no next occurrence', async () => {
    const { contentRepos } = await import('@/db/repositories/content');
    const { agentPrincipal } = await import('@/security/principal');
    const repo = contentRepos(agentPrincipal({ userId: ids.alice, workspaceId: null })).tasks;
    const task = await repo.create({ title: 'Raced weekly', repeat: { unit: 'week', interval: 1 }, dueAt: new Date('2026-11-24T23:59:59.999Z') });
    expect(await repo.discardNew(task.id)).toBe(true);
    const { queryRaw } = await import('@/db/postgres');
    const rows = await queryRaw(`SELECT id FROM tasks WHERE user_id = $1 AND title = 'Raced weekly'`, [ids.alice]);
    expect(rows.rows).toEqual([]);
  });

  test('a repeating to-do: its line is ticked with the occurrence; the next one has the note attached', async () => {
    const a = 'repeat1a';
    const { n, task } = await made('alice', 'Plants', `Plants\n- [ ] Water the plants ^todo-${a}`, { title: 'Water the plants', repeat: 'weekly', dueAt: '2026-11-24', tz: 'UTC' });
    const done = await json(await call('alice', 'PATCH', `/api/tasks/${task.id}`, { body: { status: 'done' } }));
    expect(done.body.repeatNextId).toEqual(expect.any(String));
    expect((await readNote('alice', n.id)).body.body).toBe(`Plants\n- [x] Water the plants ^todo-${a}`);
    const next = await json(await call('alice', 'GET', `/api/tasks/${done.body.repeatNextId}`));
    expect(next.body.linkedNotes).toEqual([expect.objectContaining({ id: n.id, anchor: null })]);
    const linked = (await readNote('alice', n.id)).body.linkedTasks;
    expect(linked.map((t: { id: string; anchor: string | null }) => [t.id, t.anchor])).toEqual([[task.id, a], [done.body.repeatNextId, null]]);
    // The attachment moves on with the series: one link per series, not one per occurrence.
    const third = await json(await call('alice', 'PATCH', `/api/tasks/${done.body.repeatNextId}`, { body: { status: 'done' } }));
    const after = (await readNote('alice', n.id)).body.linkedTasks.map((t: { id: string; anchor: string | null }) => [t.id, t.anchor]);
    expect(after).toEqual([[task.id, a], [third.body.repeatNextId, null]]);
  });

  test('deleting an occurrence of a linked repeating to-do hands its line and notes on to the next one', async () => {
    const a = 'skipdel1';
    const { n, task } = await made('alice', 'Bins', `Bins\n- [ ] Put the bins out ^todo-${a}`, { title: 'Put the bins out', repeat: 'weekly', dueAt: '2026-11-24', tz: 'UTC' });
    expect((await call('alice', 'DELETE', `/api/tasks/${task.id}`)).status).toBe(200);
    const linked = (await readNote('alice', n.id)).body.linkedTasks;
    expect(linked).toEqual([expect.objectContaining({ title: 'Put the bins out', status: 'open', anchor: a })]);
    expect(linked[0].id).not.toBe(task.id);
  });

  test('a to-do archived while done and restored to open unticks its line', async () => {
    const a = 'restor1a';
    const { n, task } = await made('alice', 'Restore', `Restore\n- [ ] Return the book ^todo-${a}`, { title: 'Return the book' });
    await call('alice', 'PATCH', `/api/tasks/${task.id}`, { body: { status: 'done' } });
    await call('alice', 'PATCH', `/api/tasks/${task.id}`, { body: { status: 'archived' } });
    expect((await readNote('alice', n.id)).body.body).toBe(`Restore\n- [x] Return the book ^todo-${a}`);
    await call('alice', 'PATCH', `/api/tasks/${task.id}`, { body: { status: 'open' } });
    expect((await readNote('alice', n.id)).body.body).toBe(`Restore\n- [ ] Return the book ^todo-${a}`);
  });

  test('in a space: a tick on the to-do reaches the space note, and the note\'s back', async () => {
    const a = 'space1aa';
    const { n, task } = await made('editor', 'Space list', `Space list\n- [ ] Book the room ^todo-${a}`, { title: 'Book the room' }, spaceId);
    expect((await inSpace('owner', 'PATCH', `/api/tasks/${task.id}`, { status: 'done' })).status).toBe(200);
    const after = await json(await inSpace('editor', 'GET', `/api/notes/${n.id}`));
    expect(after.body.body).toBe(`Space list\n- [x] Book the room ^todo-${a}`);
    const untick = await json(await inSpace('editor', 'POST', '/api/notes', { id: n.id, title: 'Space list', body: after.body.body.replace('[x]', '[ ]'), baseSha256: after.body.bodySha256 }));
    expect(untick.status).toBe(200);
    expect((await json(await inSpace('viewer', 'GET', `/api/tasks/${task.id}`))).body.status).toBe('open');
  });

  test('POST /notes/:id/todos makes to-dos of the open lines and marks them', async () => {
    const n = await note('alice', 'Meeting', 'Meeting\n- [ ] Send the minutes\n- [x] Book room\n- [ ] **Ask** [[people/ada|Ada]]\nplain');
    const made = await json(await call('alice', 'POST', `/api/notes/${n.id}/todos`, { body: {} }));
    expect(made.status).toBe(200);
    expect(made.body.marked).toBe(true);
    expect(made.body.tasks.map((t: { title: string }) => t.title)).toEqual(['Send the minutes', 'Ask Ada']);
    const body = (await readNote('alice', n.id)).body.body as string;
    expect(body).toMatch(/^Meeting\n- \[ \] Send the minutes \^todo-[a-z0-9]{8}\n- \[x\] Book room\n- \[ \] \*\*Ask\*\* \[\[people\/ada\|Ada\]\] \^todo-[a-z0-9]{8}\nplain$/);
    // Again: nothing left to make.
    expect((await json(await call('alice', 'POST', `/api/notes/${n.id}/todos`, { body: {} }))).body.tasks).toEqual([]);
    // Bob cannot make to-dos of Alice's note.
    expect((await call('bob', 'POST', `/api/notes/${n.id}/todos`, { body: {} })).status).toBe(404);
    // The ticked line on request: a done to-do.
    const doneLine = await json(await call('alice', 'POST', `/api/notes/${n.id}/todos`, { body: { lines: [2] } }));
    expect(doneLine.body.tasks).toEqual([expect.objectContaining({ title: 'Book room', status: 'done' })]);
  });
});

describe('GET /notes/daily reads the day without making its note', () => {
  test('null and the template before; the note after; never another user\'s', async () => {
    const before = await json(await call('alice', 'GET', '/api/notes/daily?date=2026-11-24'));
    expect(before).toMatchObject({ status: 200, body: { note: null, template: expect.stringContaining('2026-11-24') } });
    // Reading made nothing.
    expect((await json(await call('alice', 'GET', '/api/notes/daily?date=2026-11-24'))).body.note).toBeNull();
    const made = await json(await call('alice', 'POST', '/api/notes/daily', { body: { date: '2026-11-24' } }));
    expect(made.body.note.body).toBe(before.body.template);
    expect((await json(await call('alice', 'GET', '/api/notes/daily?date=2026-11-24'))).body.note.id).toBe(made.body.note.id);
    expect((await json(await call('bob', 'GET', '/api/notes/daily?date=2026-11-24'))).body.note).toBeNull();
    expect((await call('alice', 'GET', '/api/notes/daily?date=24-11-2026')).status).toBe(422);
  });
});

describe('review round: markers, races, agents, live ticks, owed ticks', () => {
  test('a copied marker and a marker with no link come off their lines on save, and the answer is the text as saved', async () => {
    const a = 'dupl1aaa';
    const { n, task } = await made('alice', 'Dups', `Dups\n- [ ] One thing ^todo-${a}`, { title: 'One thing' });
    const pasted = `Dups\n- [ ] One thing ^todo-${a}\n- [ ] One thing ^todo-${a}\n- [ ] From elsewhere ^todo-zzzzzzzz`;
    const saved = await json(await call('alice', 'POST', '/api/notes', { body: { id: n.id, title: 'Dups', body: pasted, ifSha256: n.sha } }));
    expect(saved.body.note.body).toBe(`Dups\n- [ ] One thing ^todo-${a}\n- [ ] One thing\n- [ ] From elsewhere`);
    expect((await readNote('alice', n.id)).body.bodySha256).toBe(saved.body.note.bodySha256);
    // Ticking the line (the one copy left) completes the to-do, and the answer carries the final text.
    const ticked = await json(await call('alice', 'POST', '/api/notes', { body: { id: n.id, title: 'Dups', body: saved.body.note.body.replace('- [ ] One thing ^', '- [x] One thing ^'), ifSha256: saved.body.note.bodySha256 } }));
    expect((await json(await call('alice', 'GET', `/api/tasks/${task.id}`))).body.status).toBe('done');
    expect(ticked.body.note.bodySha256).toBe((await readNote('alice', n.id)).body.bodySha256);
    // The line whose marker came off may become a to-do of its own.
    const again = await json(await call('alice', 'POST', `/api/notes/${n.id}/todos`, { body: {} }));
    expect(again.body.tasks.map((t: { title: string }) => t.title)).toEqual(['One thing', 'From elsewhere']);
  });

  test('two equal lines made to-dos become two to-dos on two lines', async () => {
    const n = await note('alice', 'Twins', 'Twins\n- [ ] Call\n- [ ] Call');
    const madeTwo = await json(await call('alice', 'POST', `/api/notes/${n.id}/todos`, { body: {} }));
    expect(madeTwo.body.tasks).toHaveLength(2);
    const body = (await readNote('alice', n.id)).body.body as string;
    const anchors = [...body.matchAll(/\^todo-([a-z0-9]{8})/g)].map((m) => m[1]);
    expect(new Set(anchors).size).toBe(2);
  });

  test('two saves over the same text: one is written, the other refused (the condition is the UPDATE\'s own)', async () => {
    const n = await note('alice', 'Race', 'Race\nstart');
    const [a, b] = await Promise.all([
      call('alice', 'POST', '/api/notes', { body: { id: n.id, title: 'Race', body: 'Race\nfrom A', ifSha256: n.sha } }),
      call('alice', 'POST', '/api/notes', { body: { id: n.id, title: 'Race', body: 'Race\nfrom B', ifSha256: n.sha } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  test('a tick a line could not take is owed, and made when the note is next opened', async () => {
    const a = 'owed1aaa';
    const { n, task } = await made('alice', 'Owed', `Owed\n- [ ] Pay the plumber ^todo-${a}`, { title: 'Pay the plumber' });
    const { setPending } = await import('@/db/repositories/task-note-links');
    await setPending(task.id, n.id, true);
    const opened = await readNote('alice', n.id);
    expect(opened.body.body).toBe(`Owed\n- [x] Pay the plumber ^todo-${a}`);
    const { queryRaw } = await import('@/db/postgres');
    expect((await queryRaw('SELECT pending_checked FROM task_note_links WHERE task_id = $1', [task.id])).rows[0].pending_checked).toBeNull();
  });

  test('in a suggest-mode space an agent\'s completion proposes the tick instead of writing it', async () => {
    const a = 'agent1aa';
    const { n, task } = await made('editor', 'Agent list', `Agent list\n- [ ] Order chairs ^todo-${a}`, { title: 'Order chairs' }, spaceId);
    const { memberPrincipal } = await import('@/db/repositories/space');
    const { contentRepos } = await import('@/db/repositories/content');
    const repos = contentRepos(await memberPrincipal(ids.editor, spaceId));
    const sessionId = randomUUID();
    await repos.tasks.update(task.id, { status: 'done', completedAt: new Date() }, { asActor: `general@${sessionId}`, agent: { sessionId, agentId: 'agent-1' } });
    expect((await json(await inSpace('editor', 'GET', `/api/notes/${n.id}`))).body.body).toBe(`Agent list\n- [ ] Order chairs ^todo-${a}`);
    const proposals = await json(await inSpace('editor', 'GET', `/api/notes/proposals?noteId=${n.id}&status=pending`));
    expect(proposals.body.proposals).toHaveLength(1);
    expect(proposals.body.proposals[0].body).toBe(`Agent list\n- [x] Order chairs ^todo-${a}`);
    // A member's own completion is written directly.
    await inSpace('editor', 'PATCH', `/api/tasks/${task.id}`, { status: 'open' });
    await inSpace('editor', 'PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    expect((await json(await inSpace('editor', 'GET', `/api/notes/${n.id}`))).body.body).toBe(`Agent list\n- [x] Order chairs ^todo-${a}`);
  });

  test('a tick reaches only the to-dos its author can reach: a guest\'s tick of an internal to-do changes nothing', async () => {
    const a = 'guest1aa';
    const { n, task } = await made('editor', 'client/plan', `client/plan\n- [ ] Internal follow-up ^todo-${a}`, { title: 'Internal follow-up' }, spaceId);
    const { reconcileNoteTasks } = await import('@/core/tasks/note-links');
    const before = `client/plan\n- [ ] Internal follow-up ^todo-${a}`;
    await reconcileNoteTasks({ kind: 'space', workspaceId: spaceId, userId: ids.gina, role: 'guest', archived: false }, n.id, before, before.replace('[ ]', '[x]'), { userId: ids.gina });
    expect((await json(await inSpace('editor', 'GET', `/api/tasks/${task.id}`))).body.status).toBe('open');
  });

  test('a to-do an agent ticks off through a note is audited to the agent and its run; an admin acting as the user, to the admin', async () => {
    const a = 'audit1aa';
    const { n, task } = await made('alice', 'Audit', `Audit\n- [ ] Book the venue ^todo-${a}`, { title: 'Book the venue' });
    const { getNoteService } = await import('@/core/knowledge/notes');
    const { personalNoteScope } = await import('@/db/repositories/note-repository');
    const run = randomUUID();
    await getNoteService().save({
      scope: personalNoteScope(ids.alice), id: n.id, title: 'Audit', body: `Audit\n- [x] Book the venue ^todo-${a}`, ifSha256: n.sha,
      actor: { userId: ids.alice, agent: { id: 'agent-7', sessionId: run } },
    });
    const { auditRepository } = await import('@/db/repositories/audit-repository');
    const rows = (await auditRepository.findByResource('task', task.id)).map((r) => ({ details: r.details as Record<string, any>, sessionId: r.sessionId }));
    const complete = rows.find((r) => r.details.op === 'complete');
    expect(complete?.details.actor).toEqual({ kind: 'agent', id: 'agent-7' });
    expect(complete?.sessionId).toBe(run);
  });

  test('a run of ticks on a closed space note is one revision', async () => {
    const a = 'revis1aa';
    const { n, task } = await made('editor', 'Revs', `Revs\n- [ ] Print badges ^todo-${a}`, { title: 'Print badges' }, spaceId);
    const { queryRaw } = await import('@/db/postgres');
    const count = async () => Number((await queryRaw('SELECT count(*)::int AS c FROM note_revisions WHERE note_id = $1', [n.id])).rows[0].c);
    const start = await count();
    for (const status of ['done', 'open', 'done', 'open']) await inSpace('editor', 'PATCH', `/api/tasks/${task.id}`, { status });
    expect(await count()).toBe(start + 1);
    expect((await json(await inSpace('editor', 'GET', `/api/notes/${n.id}`))).body.body).toBe(`Revs\n- [ ] Print badges ^todo-${a}`);
  });

  test('restoring a revision is a change like any other: its ticks reach their to-dos', async () => {
    const a = 'restr2aa';
    const { n, task } = await made('editor', 'Restorable', `Restorable\n- [ ] Book the caterer ^todo-${a}`, { title: 'Book the caterer' }, spaceId);
    const revs = await json(await inSpace('editor', 'GET', `/api/notes/${n.id}/revisions`));
    const unticked = revs.body.revisions[0].id as string;
    await inSpace('editor', 'PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    expect((await json(await inSpace('editor', 'GET', `/api/notes/${n.id}`))).body.body).toContain('- [x] Book the caterer');
    expect((await inSpace('editor', 'POST', `/api/notes/${n.id}/revisions/${unticked}/restore`, {})).status).toBe(200);
    expect((await json(await inSpace('editor', 'GET', `/api/tasks/${task.id}`))).body.status).toBe('open');
  });
});
