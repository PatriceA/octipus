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
    const n = await note('alice', 'Errands', `Errands\n- [ ] Call the dentist ^todo-${anchor}\n- [ ] Other`);
    const task = (await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'Call the dentist', noteId: n.id, noteAnchor: anchor } }))).body;
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
    const n = await note('alice', 'Stale', `Stale\n- [ ] Pay rent ^todo-${a}`);
    const task = (await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'Pay rent', noteId: n.id, noteAnchor: a } }))).body;
    await call('alice', 'PATCH', `/api/tasks/${task.id}`, { body: { status: 'done' } });
    // An editor still holding the text from before the tick.
    const refused = await json(await call('alice', 'POST', '/api/notes', { body: { id: n.id, title: 'Stale', body: `Stale\n- [ ] Pay rent ^todo-${a}\ntyped`, ifSha256: n.sha } }));
    expect(refused).toMatchObject({ status: 409, body: { code: 'stale' } });
    expect((await readNote('alice', n.id)).body.body).toBe(`Stale\n- [x] Pay rent ^todo-${a}`);
    expect((await json(await call('alice', 'GET', `/api/tasks/${task.id}`))).body.status).toBe('done');
  });

  test('a deleted (archived) to-do is not brought back by a tick, and deleting one leaves the line', async () => {
    const a = 'archiv1a';
    const n = await note('alice', 'Gone', `Gone\n- [ ] Old thing ^todo-${a}`);
    const task = (await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'Old thing', noteId: n.id, noteAnchor: a } }))).body;
    await call('alice', 'PATCH', `/api/tasks/${task.id}`, { body: { status: 'archived' } });
    const current = await readNote('alice', n.id);
    expect(current.body.body).toBe(`Gone\n- [ ] Old thing ^todo-${a}`);
    await call('alice', 'POST', '/api/notes', { body: { id: n.id, title: 'Gone', body: current.body.body.replace('[ ]', '[x]'), ifSha256: current.body.bodySha256 } });
    expect((await json(await call('alice', 'GET', `/api/tasks/${task.id}`))).body.status).toBe('archived');
  });

  test('one line is one to-do: a second to-do for the same line is refused and not made', async () => {
    const a = 'twice1aa';
    const n = await note('alice', 'Twice', `Twice\n- [ ] Once ^todo-${a}`);
    expect((await call('alice', 'POST', '/api/tasks', { body: { title: 'Once', noteId: n.id, noteAnchor: a } })).status).toBe(200);
    const second = await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'Again', noteId: n.id, noteAnchor: a } }));
    expect(second).toMatchObject({ status: 409, body: { code: 'anchor_taken' } });
    expect((await json(await call('alice', 'GET', '/api/tasks'))).body.tasks.map((t: { title: string }) => t.title)).not.toContain('Again');
  });

  test('a repeating to-do: its line is ticked with the occurrence; the next one has the note attached', async () => {
    const a = 'repeat1a';
    const n = await note('alice', 'Plants', `Plants\n- [ ] Water the plants ^todo-${a}`);
    const task = (await json(await call('alice', 'POST', '/api/tasks', { body: { title: 'Water the plants', repeat: 'weekly', dueAt: '2026-11-24', tz: 'UTC', noteId: n.id, noteAnchor: a } }))).body;
    const done = await json(await call('alice', 'PATCH', `/api/tasks/${task.id}`, { body: { status: 'done' } }));
    expect(done.body.repeatNextId).toEqual(expect.any(String));
    expect((await readNote('alice', n.id)).body.body).toBe(`Plants\n- [x] Water the plants ^todo-${a}`);
    const next = await json(await call('alice', 'GET', `/api/tasks/${done.body.repeatNextId}`));
    expect(next.body.linkedNotes).toEqual([expect.objectContaining({ id: n.id, anchor: null })]);
    const linked = (await readNote('alice', n.id)).body.linkedTasks;
    expect(linked.map((t: { id: string; anchor: string | null }) => [t.id, t.anchor])).toEqual([[task.id, a], [done.body.repeatNextId, null]]);
  });

  test('in a space: a tick on the to-do reaches the space note, and the note\'s back', async () => {
    const a = 'space1aa';
    const n = await note('editor', 'Space list', `Space list\n- [ ] Book the room ^todo-${a}`, spaceId);
    const task = (await json(await inSpace('editor', 'POST', '/api/tasks', { title: 'Book the room', noteId: n.id, noteAnchor: a }))).body;
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
