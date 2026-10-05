/**
 * The document hub (docs/plans/coworking-spec.md §7.3, §7.6 tests):
 *
 *   - two clients editing at once converge, and the note is persisted with
 *     a revision naming both;
 *   - a reconnect with stale state (a rebuilt document, a new epoch) or with
 *     the same epoch never duplicates text;
 *   - every external writer — save, capture, archive, meeting notes —
 *     merges with the live text or is refused as stale, never reverting it;
 *   - a commenter's update is refused; rate and size caps hold;
 *   - membership changes take effect on the next frame.
 *
 * Clients are Yjs documents wired to the hub the way the web editor is.
 * Backed by ephemeral PGlite; no embedding model (indexing degrades, logged).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import type { GatewayMessage } from '@/core/gateway/protocol';
import type { NoteService } from '@/core/knowledge/notes';
import type { NoteScope } from '@/db/repositories/note-repository';
import type { DocLimits, DocumentHub } from './hub';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';

const alice = randomUUID();
const bob = randomUUID();
const carol = randomUUID();
let spaceId: string;
let aliceScope: NoteScope;
let hub: DocumentHub;
let notes: NoteService;
let now = 1_000_000;
const limits: DocLimits = { noteMaxBytes: 4096, docMaxUpdatesPerSecond: 30, docPersistDebounceMs: 60_000, docReindexMinutes: 10, docBaseTtlMinutes: 30 };
const inbox = new Map<string, GatewayMessage[]>();
const reindexed: string[] = [];

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-doc-hub-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: alice, username: 'h-alice' }, { id: bob, username: 'h-bob' }, { id: carol, username: 'h-carol' }]);
  const { spaceWith, resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(alice, [[bob, 'editor'], [carol, 'commenter']]);
  const { contentRepos } = await import('@/db/repositories/content');
  aliceScope = contentRepos(await resolvedPrincipal(alice, spaceId)).noteScope;

  const { DocumentHub } = await import('./hub');
  const repo = await import('@/db/repositories/live-documents');
  const { getMembership } = await import('@/core/spaces/service');
  const { membershipVersion } = await import('@/core/spaces/membership');
  hub = new DocumentHub({
    load: repo.loadSpaceNote,
    writeBody: async (noteId, ws, expected, body, sha) => (await repo.writeBodyIfUnchanged(noteId, ws, expected, body, sha)) !== null,
    insertRevision: repo.insertRevision,
    reindex: async (noteId) => { reindexed.push(noteId); },
    membership: async (userId, ws) => (await getMembership(userId, ws))?.role ?? null,
    membershipVersion,
    send: (connectionId, message) => {
      inbox.get(connectionId)?.push(message);
      clients.get(connectionId)?.receive(message);
    },
    setResource: () => undefined,
    peersChanged: () => undefined,
    limits: () => limits,
    now: () => now,
  });
  // The process's hub is this one, so every writer (the note service, the
  // meeting importer) goes through it.
  const { _setDocHubForTests } = await import('./index');
  _setDocHubForTests(hub);
  const { getNoteService } = await import('@/core/knowledge/notes');
  notes = getNoteService();
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(() => {
  now += 10_000;
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

/** A web editor: a Yjs document synced with the hub over (simulated) gateway frames. */
class Client {
  doc = new Y.Doc();
  epoch: string | undefined;
  readOnly = true;
  constructor(readonly connectionId: string, readonly userId: string, readonly noteId: string) {
    clients.set(connectionId, this);
    inbox.set(connectionId, []);
    this.listen();
  }

  private listen(): void {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || !this.epoch) return;
      void hub.update(this.conn, this.noteId, this.epoch, b64(update));
    });
  }

  get conn() {
    return { connectionId: this.connectionId, userId: this.userId };
  }

  get text(): string {
    return this.doc.getText('body').toString();
  }

  receive(message: GatewayMessage): void {
    if (!('noteId' in message) || message.noteId !== this.noteId) return;
    if (message.type === 'doc.sync') {
      if (message.epoch !== this.epoch) {
        // Another epoch: discard the local document and re-seed.
        this.doc.destroy();
        this.doc = new Y.Doc();
        this.listen();
      }
      this.epoch = message.epoch;
      this.readOnly = message.readOnly;
      const serverVector = unb64(message.stateVector);
      Y.applyUpdate(this.doc, unb64(message.state), 'remote');
      // Send back what the server lacks (edits made while offline).
      const missing = Y.encodeStateAsUpdate(this.doc, serverVector);
      if (missing.length > 2 && !this.readOnly) void hub.update(this.conn, this.noteId, message.epoch, b64(missing));
    }
    if (message.type === 'doc.update' && message.epoch === this.epoch) Y.applyUpdate(this.doc, unb64(message.update), 'remote');
  }

  join(): Promise<void> {
    return hub.join(this.conn, this.noteId, this.epoch ? { epoch: this.epoch, stateVector: b64(Y.encodeStateVector(this.doc)) } : {});
  }

  /** Type `text` at `index` (local change, sent to the hub). */
  type(index: number, text: string): void {
    this.doc.getText('body').insert(index, text);
  }

  errors(): string[] {
    return (inbox.get(this.connectionId) ?? []).filter((m) => m.type === 'doc.error').map((m) => (m as { code: string }).code);
  }
}

const clients = new Map<string, Client>();
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function newNote(body: string): Promise<string> {
  const saved = await notes.save({ scope: aliceScope, title: `Note ${rand(4)}`, body });
  return saved.note.id;
}

async function stored(noteId: string): Promise<string> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw('SELECT body FROM notes WHERE id = $1', [noteId]);
  return rows[0].body as string;
}

async function revisions(noteId: string): Promise<Array<{ origin: string; authors: string[]; on_behalf_of_user_id: string | null }>> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw('SELECT origin, authors, on_behalf_of_user_id FROM note_revisions WHERE note_id = $1 ORDER BY created_at, id', [noteId]);
  return rows as Array<{ origin: string; authors: string[]; on_behalf_of_user_id: string | null }>;
}

describe('editing together', () => {
  test('two clients converge; the last leave persists a revision naming both', async () => {
    const noteId = await newNote('Hello world\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    const b = new Client(`b-${rand(3)}`, bob, noteId);
    await Promise.all([a.join(), b.join()]);
    // Concurrent first joins shared one init: one epoch.
    expect(a.epoch).toBe(b.epoch);
    expect(a.readOnly).toBe(false);

    a.type(0, 'Alice: ');
    b.type(b.text.length, 'Bob was here\n');
    await settle();
    expect(a.text).toBe(b.text);
    expect(a.text).toContain('Alice: Hello world');
    expect(a.text).toContain('Bob was here');

    await hub.leave(a.connectionId, noteId);
    await hub.leave(b.connectionId, noteId);
    expect(hub.isOpen(noteId)).toBe(false);
    expect(await stored(noteId)).toBe(a.text);
    const live = (await revisions(noteId)).filter((r) => r.origin === 'live');
    expect(live).toHaveLength(1);
    expect([...live[0].authors].sort()).toEqual([alice, bob].sort());
    expect(reindexed).toContain(noteId);
  });

  test('a reconnect after the document was rebuilt re-seeds instead of duplicating', async () => {
    const noteId = await newNote('one line\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    a.type(0, 'first ');
    await settle();
    const oldEpoch = a.epoch;
    // The connection drops, the document closes (persisted), and is rebuilt.
    await hub.connectionClosed(a.connectionId);
    expect(hub.isOpen(noteId)).toBe(false);
    await a.join();
    expect(a.epoch).not.toBe(oldEpoch);
    expect(a.text).toBe('first one line\n');
    expect(await stored(noteId)).toBe('first one line\n');
    await hub.leave(a.connectionId, noteId);
  });

  test('a reconnect at the same epoch sends only what is missing, with no duplicate', async () => {
    const noteId = await newNote('base\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    const b = new Client(`b-${rand(3)}`, bob, noteId);
    await a.join();
    await b.join();
    // A drops; B keeps the document open and types; A types offline.
    await hub.connectionClosed(a.connectionId);
    b.type(0, 'B ');
    const offline = a.epoch;
    a.epoch = undefined; // offline: local edits are not sent
    a.type(a.text.length, 'A offline\n');
    a.epoch = offline;
    await settle();
    await a.join();
    await settle();
    expect(a.text).toBe(b.text);
    expect(a.text).toBe('B base\nA offline\n');
    await hub.leave(a.connectionId, noteId);
    await hub.leave(b.connectionId, noteId);
    expect(await stored(noteId)).toBe('B base\nA offline\n');
  });
});

describe('external writers merge or are refused as stale, never revert', () => {
  test('save merges a change made from a read of the live text', async () => {
    const noteId = await newNote('# Plan\n\nstep one\n\nstep two\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    const read = await notes.getById(aliceScope, noteId);
    expect(read?.body).toBe('# Plan\n\nstep one\n\nstep two\n');
    a.type(0, 'Draft: ');
    await settle();
    const saved = await notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: `${read!.body}\nstep three\n`, baseSha256: read!.bodySha256 });
    expect(saved.merged).toBe(true);
    await settle();
    const expected = 'Draft: # Plan\n\nstep one\n\nstep two\n\nstep three\n';
    expect(a.text).toBe(expected);
    expect(await stored(noteId)).toBe(expected);
    const origins = (await revisions(noteId)).map((r) => r.origin);
    expect(origins.slice(-2)).toEqual(['live', 'external']);
    await hub.leave(a.connectionId, noteId);
  });

  test('a conflicting save or an unknown base is refused and the live text stays', async () => {
    const { StaleWriteError } = await import('./hub');
    const noteId = await newNote('the cat sat\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    const read = await notes.getById(aliceScope, noteId);
    a.doc.getText('body').delete(4, 3);
    a.type(4, 'dog');
    await settle();
    await expect(notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: 'the bird sat\n', baseSha256: read!.bodySha256 }))
      .rejects.toBeInstanceOf(StaleWriteError);
    await expect(notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: 'x\n', baseSha256: 'f'.repeat(64) }))
      .rejects.toBeInstanceOf(StaleWriteError);
    expect(a.text).toBe('the dog sat\n');
    await hub.leave(a.connectionId, noteId);
    expect(await stored(noteId)).toBe('the dog sat\n');
  });

  test('capture appends to the live daily note without dropping typing', async () => {
    const daily = await notes.getOrCreateDaily(aliceScope, '2026-10-04');
    const a = new Client(`a-${rand(3)}`, alice, daily.id);
    await a.join();
    a.type(a.text.indexOf('## Tasks'), 'typed by alice\n\n');
    await settle();
    await notes.capture(aliceScope, 'captured line', '2026-10-04');
    await settle();
    expect(a.text).toContain('typed by alice');
    expect(a.text).toMatch(/- \d\d:\d\d captured line\n$/);
    await hub.leave(a.connectionId, daily.id);
    expect(await stored(daily.id)).toBe(a.text);
  });

  test('meeting notes re-saved into an open note merge', async () => {
    const { ingestMeeting } = await import('@/core/knowledge/meetings');
    const at = '2026-10-01T10:00:00.000Z';
    const first = await ingestMeeting({ userId: alice, workspaceId: spaceId, scope: aliceScope, title: 'Sync', at, body: 'agenda' });
    const a = new Client(`a-${rand(3)}`, alice, first.noteId);
    await a.join();
    const read = await notes.getById(aliceScope, first.noteId);
    a.type(0, 'LIVE ');
    await settle();
    // The importer re-renders the note from fuller notes, based on its read.
    const saved = await notes.save({
      scope: aliceScope, id: first.noteId, title: 'Sync',
      body: read!.body.replace('agenda', 'agenda\n\nDecided: ship it'), baseSha256: read!.bodySha256,
    });
    expect(saved.merged).toBe(true);
    await settle();
    expect(a.text.startsWith('LIVE ')).toBe(true);
    expect(a.text).toContain('Decided: ship it');
    await hub.leave(a.connectionId, first.noteId);
  });

  test('ingestMeeting into a space goes through the same merge', async () => {
    const { ingestMeeting } = await import('@/core/knowledge/meetings');
    const at = '2026-10-02T10:00:00.000Z';
    const first = await ingestMeeting({ userId: alice, workspaceId: spaceId, scope: aliceScope, title: 'Retro', at, body: 'went well' });
    const a = new Client(`a-${rand(3)}`, alice, first.noteId);
    await a.join();
    a.type(a.text.length, '\nlive tail\n');
    await settle();
    // A re-import from the stored text (its default base) merges with the typing.
    const again = await ingestMeeting({ userId: alice, workspaceId: spaceId, scope: aliceScope, title: 'Retro', at, body: 'went well, and more' });
    expect(again.noteId).toBe(first.noteId);
    await settle();
    expect(a.text).toContain('went well, and more');
    expect(a.text).toContain('live tail');
    await hub.leave(a.connectionId, first.noteId);
  });

  test('archive saves the live text first and closes the document', async () => {
    const noteId = await newNote('to archive\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    a.type(0, 'last words ');
    await settle();
    expect(await notes.archive(aliceScope, noteId)).toBe(true);
    expect(hub.isOpen(noteId)).toBe(false);
    expect(inbox.get(a.connectionId)?.some((m) => m.type === 'doc.closed' && m.reason === 'archived')).toBe(true);
    expect(await stored(noteId)).toBe('last words to archive\n');
  });

  test('a closed note is written conditionally and merges from a kept base', async () => {
    const noteId = await newNote('alpha\n\nbeta\n');
    const read = await notes.getById(aliceScope, noteId);
    await notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: 'alpha\n\nbeta\n\ngamma\n', baseSha256: read!.bodySha256 });
    // A second writer from the same old read: merges when it kept the text.
    const saved = await notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: 'ALPHA\n\nbeta\n', baseSha256: read!.bodySha256, baseBody: read!.body });
    expect(saved.note.body).toBe('ALPHA\n\nbeta\n\ngamma\n');
    // Without the text, the old sha is unknown: stale.
    const { StaleWriteError } = await import('./hub');
    await expect(notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: 'x', baseSha256: read!.bodySha256 })).rejects.toBeInstanceOf(StaleWriteError);
  });
});

describe('access and caps', () => {
  test("a commenter reads but their update is refused", async () => {
    const noteId = await newNote('read me\n');
    const c = new Client(`c-${rand(3)}`, carol, noteId);
    await c.join();
    expect(c.readOnly).toBe(true);
    expect(c.text).toBe('read me\n');
    c.type(0, 'vandal ');
    await settle();
    expect(c.errors()).toContain('FORBIDDEN');
    expect(hub.readLive(noteId)?.text).toBe('read me\n');
    await hub.leave(c.connectionId, noteId);
  });

  test('a non-member gets NOT_FOUND', async () => {
    const stranger = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: stranger, username: `h-stranger-${rand(2)}` }]);
    const noteId = await newNote('private\n');
    const s = new Client(`s-${rand(3)}`, stranger, noteId);
    await s.join();
    expect(s.errors()).toEqual(['NOT_FOUND']);
    expect(s.text).toBe('');
  });

  test('updates beyond docMaxUpdatesPerSecond are refused', async () => {
    const noteId = await newNote('');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    for (let i = 0; i < limits.docMaxUpdatesPerSecond + 5; i++) a.type(0, 'x');
    await settle();
    expect(a.errors().filter((e) => e === 'RATE_LIMITED')).toHaveLength(5);
    expect(hub.readLive(noteId)?.text).toBe('x'.repeat(limits.docMaxUpdatesPerSecond));
    // A refused update leaves the client ahead of the server: it resyncs
    // (as the web editor does after RATE_LIMITED) and sends what was refused.
    now += 2000;
    a.type(0, 'y');
    await a.join();
    await settle();
    expect(hub.readLive(noteId)?.text).toBe(a.text);
    expect(a.text).toBe(`y${'x'.repeat(limits.docMaxUpdatesPerSecond + 5)}`);
    await hub.leave(a.connectionId, noteId);
  });

  test('an update past noteMaxBytes is refused, and so is a save', async () => {
    const { NoteTooLargeError } = await import('./hub');
    const noteId = await newNote('small\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    a.type(0, 'z'.repeat(limits.noteMaxBytes));
    await settle();
    expect(a.errors()).toContain('TOO_LARGE');
    expect(hub.readLive(noteId)?.text).toBe('small\n');
    const read = await notes.getById(aliceScope, noteId);
    await expect(notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: 'q'.repeat(limits.noteMaxBytes + 1), baseSha256: read!.bodySha256 }))
      .rejects.toBeInstanceOf(NoteTooLargeError);
    await hub.leave(a.connectionId, noteId);
  });

  test('a removed member is dropped on their next frame', async () => {
    const dave = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: dave, username: `h-dave-${rand(2)}` }]);
    const { createInvite, acceptInvite } = await import('@/core/spaces/invites');
    const invite = await createInvite({ userId: alice }, spaceId, { role: 'editor' });
    await acceptInvite({ userId: dave }, invite.token);
    const noteId = await newNote('team\n');
    const d = new Client(`d-${rand(3)}`, dave, noteId);
    await d.join();
    const { removeMember } = await import('@/core/spaces/service');
    await removeMember({ userId: alice }, spaceId, dave);
    d.type(0, 'after removal ');
    await settle();
    expect(inbox.get(d.connectionId)?.some((m) => m.type === 'doc.closed' && m.reason === 'access')).toBe(true);
    expect(await stored(noteId)).toBe('team\n');
  });

  test('startup refuses a note size the frame cannot carry', async () => {
    const { assertDocLimits } = await import('./hub');
    expect(() => assertDocLimits(114_688, 262_144)).not.toThrow();
    expect(() => assertDocLimits(200_000, 262_144)).toThrow(/at most half/);
  });
});
