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
let bobScope: NoteScope;
let hub: DocumentHub;
/** A hub wired like the process's (a "restart" swaps in a fresh one). */
let makeHub: () => DocumentHub;
let notes: NoteService;
let now = 1_000_000;
const limits: DocLimits = { noteMaxBytes: 4096, docMaxUpdatesPerSecond: 30, docPersistDebounceMs: 60_000, docReindexMinutes: 10, docBaseTtlMinutes: 30 };
const inbox = new Map<string, GatewayMessage[]>();
const reindexed: string[] = [];
/** How long a closed document stays warm; 0 (most tests) drops it on the last leave. */
let keepWarmMs = 0;
/** Test hooks around the hub's database calls. */
const hooks: {
  afterMembershipRead?: () => Promise<void>;
  writeBody?: () => Promise<void>;
} = {};

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
  bobScope = contentRepos(await resolvedPrincipal(bob, spaceId)).noteScope;

  const { DocumentHub } = await import('./hub');
  const repo = await import('@/db/repositories/live-documents');
  const { getMembership } = await import('@/core/spaces/service');
  const { membershipVersion } = await import('@/core/spaces/membership');
  makeHub = () => new DocumentHub({
    load: repo.loadSpaceNote,
    writeBody: async (noteId, ws, expected, body, sha) => {
      await hooks.writeBody?.();
      return (await repo.writeBodyIfUnchanged(noteId, ws, expected, body, sha)) !== null;
    },
    insertRevision: repo.insertRevision,
    reindex: async (noteId, editor, previousBody) => {
      reindexed.push(noteId);
      return notes.refreshSpaceNote(noteId, editor, previousBody);
    },
    userName: async (userId) => (userId === alice ? 'h-alice' : userId === bob ? 'h-bob' : 'someone'),
    membership: async (userId, ws) => {
      const role = (await getMembership(userId, ws))?.role ?? null;
      await hooks.afterMembershipRead?.();
      return role;
    },
    membershipVersion,
    send: (connectionId, message) => {
      inbox.get(connectionId)?.push(message);
      clients.get(connectionId)?.receive(message);
      gateways.get(connectionId)?.receive(message);
    },
    setResource: () => undefined,
    peersChanged: () => undefined,
    limits: () => limits,
    now: () => now,
    get keepWarmMs() { return keepWarmMs; },
  });
  hub = makeHub();
  // The process's hub is this one, so every writer (the note service, the
  // meeting importer) goes through it.
  const { _setDocHubForTests } = await import('./index');
  _setDocHubForTests(hub);
  const { getNoteService } = await import('@/core/knowledge/notes');
  notes = getNoteService();
}, 120_000);

afterAll(async () => {
  // Reindexes started by the last leaves finish before the database closes.
  await new Promise((resolve) => setTimeout(resolve, 300));
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

/** Wait until `check` holds (polling), or fail with `what`. */
async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const gateways = new Map<string, FakeGateway>();

/**
 * The web's gateway connection as `LiveNoteSession` (web/lib/live-note.ts)
 * uses it, wired to the hub in process: frames go to the hub's handlers,
 * the hub's messages come back. `drop()` / `restore()` play a network blip
 * (the hub sees the connection close; a reconnect is a new connection).
 */
class FakeGateway {
  connectionId = `w-${rand(4)}`;
  status: 'connected' | 'disconnected' = 'connected';
  private readonly messageListeners = new Set<(message: GatewayMessage) => void>();
  private readonly statusListeners = new Set<(status: string) => void>();

  constructor(readonly userId: string) {
    gateways.set(this.connectionId, this);
    inbox.set(this.connectionId, []);
  }

  getStatus(): string {
    return this.status;
  }

  onMessage(listener: (message: GatewayMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: (status: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  send(message: { type: string; noteId?: string; epoch?: string; stateVector?: string; update?: string }): boolean {
    if (this.status !== 'connected') return false;
    // Time passes between a browser's frames (the hub's rate limits read it).
    now += 25;
    const conn = { connectionId: this.connectionId, userId: this.userId };
    const noteId = message.noteId ?? '';
    if (message.type === 'doc.join') void hub.join(conn, noteId, { epoch: message.epoch, stateVector: message.stateVector });
    else if (message.type === 'doc.update') void hub.update(conn, noteId, message.epoch ?? '', message.update ?? '');
    else if (message.type === 'doc.awareness') void hub.awareness(conn, noteId, message.update ?? '');
    else if (message.type === 'doc.leave') void hub.leave(this.connectionId, noteId);
    return true;
  }

  receive(message: GatewayMessage): void {
    if (this.status !== 'connected') return;
    for (const listener of this.messageListeners) listener(message);
  }

  /** The connection drops: the hub leaves its documents. */
  async drop(): Promise<void> {
    this.status = 'disconnected';
    for (const listener of this.statusListeners) listener('disconnected');
    await hub.connectionClosed(this.connectionId);
  }

  /** A new connection comes up (sessions rejoin). */
  restore(): void {
    gateways.delete(this.connectionId);
    this.connectionId = `w-${rand(4)}`;
    gateways.set(this.connectionId, this);
    inbox.set(this.connectionId, []);
    this.status = 'connected';
    for (const listener of this.statusListeners) listener('connected');
  }
}

/** What `POST /notes/:id/merge` does: the member's text, merged through the hub. */
function mergeAs(scope: NoteScope, noteId: string) {
  return async (base: string, text: string): Promise<'merged' | 'conflict'> => {
    const { StaleWriteError, sha256Hex } = await import('./hub');
    try {
      await notes.writeSpaceBody(scope as NoteScope & { kind: 'space' }, noteId, {
        base: { sha256: sha256Hex(base), text: base },
        next: text,
        origin: { kind: 'peer', userId: scope.userId },
      });
      return 'merged';
    } catch (err) {
      if (err instanceof StaleWriteError) return 'conflict';
      throw err;
    }
  };
}

/** The web editor's live session on `noteId`, over a fake gateway. */
async function webSession(userId: string, scope: NoteScope, noteId: string) {
  const { LiveNoteSession } = await import('../../../web/lib/live-note');
  const gateway = new FakeGateway(userId);
  const session = new LiveNoteSession(gateway as unknown as ConstructorParameters<typeof LiveNoteSession>[0], noteId, { id: userId, name: 'member' }, mergeAs(scope, noteId));
  await until(() => session.getState().synced, 'the first doc.sync');
  return { gateway, session };
}

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

/** The awareness states a fresh connection of `userId` receives on joining `noteId`. */
async function awarenessSeenBy(userId: string, noteId: string): Promise<Map<number, Record<string, unknown> | null>> {
  const { decodeAwarenessUpdate } = await import('./awareness-guard');
  const observer = new Client(`o-${rand(3)}`, userId, noteId);
  await observer.join();
  const frame = inbox.get(observer.connectionId)?.find((m) => m.type === 'doc.awareness') as { update: string } | undefined;
  await hub.leave(observer.connectionId, noteId);
  return new Map(frame ? decodeAwarenessUpdate(unb64(frame.update)).map((e) => [e.clientId, e.state]) : []);
}

describe('reconnects never drop what was typed (review findings 1, 3)', () => {
  test('a sole editor whose connection blips keeps the epoch: what they typed offline merges', async () => {
    keepWarmMs = 60_000;
    try {
      const noteId = await newNote('alpha\n');
      const { gateway, session } = await webSession(alice, aliceScope, noteId);
      session.text.insert(0, 'one ');
      await until(() => hub.readLive(noteId)?.text === 'one alpha\n', 'the edit reaches the hub');
      const firstEpoch = (inbox.get(gateway.connectionId)?.find((m) => m.type === 'doc.sync') as { epoch: string }).epoch;
      await gateway.drop();
      // The last leave persisted the note; it stays warm.
      expect(hub.isOpen(noteId)).toBe(true);
      expect(await stored(noteId)).toBe('one alpha\n');
      session.text.insert(session.text.length, 'typed offline\n');
      gateway.restore();
      await until(() => hub.readLive(noteId)?.text === 'one alpha\ntyped offline\n', 'the offline edit reaches the hub');
      const sync = inbox.get(gateway.connectionId)?.find((m) => m.type === 'doc.sync') as { epoch: string };
      expect(sync.epoch).toBe(firstEpoch);
      expect(session.text.toString()).toBe('one alpha\ntyped offline\n');
      session.destroy();
      await until(async () => (await stored(noteId)) === 'one alpha\ntyped offline\n', 'the last leave persists');
    } finally {
      keepWarmMs = 0;
    }
  });

  test('after a rebuild (new epoch) the offline edits are merged back, with what others wrote meanwhile', async () => {
    const noteId = await newNote('# Plan\n\nfirst paragraph\n\nsecond paragraph\n');
    const { gateway, session } = await webSession(alice, aliceScope, noteId);
    await gateway.drop();
    expect(hub.isOpen(noteId)).toBe(false);
    // Offline, Alice edits the first paragraph; Bob changes the second (persisted).
    session.text.insert(session.text.toString().indexOf('first'), 'my ');
    const read = await notes.getById(bobScope, noteId);
    await notes.save({ scope: bobScope, id: noteId, title: read!.title, body: read!.body.replace('second', 'SECOND'), baseSha256: read!.bodySha256 });
    gateway.restore();
    const expected = '# Plan\n\nmy first paragraph\n\nSECOND paragraph\n';
    await until(() => session.text.toString() === expected, 'the merged text reaches the editor');
    expect(hub.readLive(noteId)?.text).toBe(expected);
    expect(session.getState().unmerged).toBeNull();
    session.destroy();
    await until(async () => (await stored(noteId)) === expected, 'the merge is persisted');
  });

  test('a clash with a change made meanwhile is not applied: the member keeps their text, with a notice', async () => {
    const noteId = await newNote('the first line\n');
    const { gateway, session } = await webSession(alice, aliceScope, noteId);
    await gateway.drop();
    const at = session.text.toString().indexOf('first');
    session.text.delete(at, 5);
    session.text.insert(at, 'FIRST');
    const read = await notes.getById(bobScope, noteId);
    await notes.save({ scope: bobScope, id: noteId, title: read!.title, body: 'the primary line\n', baseSha256: read!.bodySha256 });
    gateway.restore();
    await until(() => session.getState().unmerged !== null, 'the clash is reported');
    expect(session.getState().unmerged).toBe('the FIRST line\n');
    expect(session.getState().notice).toMatch(/clashes/);
    expect(session.text.toString()).toBe('the primary line\n');
    expect(hub.readLive(noteId)?.text).toBe('the primary line\n');
    session.destroy();
  });

  test('a restart: shutdown flushes what was typed; edits the old process never saved are merged back', async () => {
    const { _setDocHubForTests } = await import('./index');
    const noteId = await newNote('start\n');
    const { gateway, session } = await webSession(alice, aliceScope, noteId);
    session.text.insert(0, 'typed ');
    await until(() => hub.readLive(noteId)?.text === 'typed start\n', 'the edit reaches the hub');
    // The persist debounce is a minute away: shutdown saves it (finding 3).
    await hub.flushAll();
    expect(await stored(noteId)).toBe('typed start\n');
    // Then an edit reaches the old process and is never saved (it is killed).
    session.text.insert(session.text.length, 'unsaved\n');
    await until(() => hub.readLive(noteId)?.text === 'typed start\nunsaved\n', 'the second edit reaches the old hub');
    hub = makeHub();
    _setDocHubForTests(hub);
    await gateway.drop();
    session.text.insert(session.text.length, 'offline\n');
    gateway.restore();
    const expected = 'typed start\nunsaved\noffline\n';
    await until(() => hub.readLive(noteId)?.text === expected, 'the new hub has everything');
    expect(session.text.toString()).toBe(expected);
    session.destroy();
    await until(async () => (await stored(noteId)) === expected, 'persisted');
  });

  test('a refused update is dropped, not merged back: the editor takes the server text', async () => {
    const noteId = await newNote('small\n');
    const { session } = await webSession(alice, aliceScope, noteId);
    session.text.insert(0, 'z'.repeat(limits.noteMaxBytes));
    await until(() => session.getState().notice !== null && session.text.toString() === 'small\n', 'the editor re-seeds');
    await settle();
    expect(hub.readLive(noteId)?.text).toBe('small\n');
    expect(session.getState().unmerged).toBeNull();
    session.destroy();
  });

  test('flushAll persists an open note’s pending edits', async () => {
    const noteId = await newNote('flush\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    a.type(0, 'pending ');
    await settle();
    expect(await stored(noteId)).toBe('flush\n');
    await hub.flushAll();
    expect(await stored(noteId)).toBe('pending flush\n');
    await hub.leave(a.connectionId, noteId);
  });

  test('a join racing the last leave gets a live document', async () => {
    const noteId = await newNote('race\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    a.type(0, 'typed ');
    await settle();
    const b = new Client(`b-${rand(3)}`, bob, noteId);
    await Promise.all([hub.leave(a.connectionId, noteId), b.join()]);
    expect(b.text).toBe('typed race\n');
    b.type(b.text.length, 'more\n');
    await settle();
    expect(b.errors()).toEqual([]);
    expect(hub.readLive(noteId)?.text).toBe('typed race\nmore\n');
    await hub.leave(b.connectionId, noteId);
    expect(await stored(noteId)).toBe('typed race\nmore\n');
  });

  test('the database moved behind the hub: editors re-seed and their unsaved typing is merged back', async () => {
    const { queryRaw } = await import('@/db/postgres');
    const { sha256Hex } = await import('./hub');
    const noteId = await newNote('db text\n');
    const { session } = await webSession(alice, aliceScope, noteId);
    session.text.insert(0, 'live ');
    await until(() => hub.readLive(noteId)?.text === 'live db text\n', 'the edit reaches the hub');
    const outside = 'db text\nappended outside\n';
    await queryRaw('UPDATE notes SET body = $2, body_sha256 = $3 WHERE id = $1', [noteId, outside, sha256Hex(outside)]);
    // The persist finds another sha: the hub reloads under a new epoch.
    await hub.flushAll();
    const expected = 'live db text\nappended outside\n';
    await until(() => hub.readLive(noteId)?.text === expected, 'the typing is merged into the reloaded text');
    expect(session.text.toString()).toBe(expected);
    session.destroy();
    await until(async () => (await stored(noteId)) === expected, 'persisted');
  });
});

describe('writes need a base, and keep what they do not own (review findings 2, 8, 11, 12)', () => {
  test('a body write to an existing space note without a base is refused, never reverting a persisted edit', async () => {
    const { StaleWriteError } = await import('./hub');
    const noteId = await newNote('A\n\nB\n');
    const read = await notes.getById(aliceScope, noteId);
    // A member deletes a paragraph; it is persisted and the note closes.
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    a.doc.getText('body').delete(0, 3);
    await settle();
    await hub.leave(a.connectionId, noteId);
    expect(await stored(noteId)).toBe('B\n');
    // A writer from the old read that does not name it would put the paragraph back.
    const refused = notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: 'A\n\nB\n\nC\n' });
    await expect(refused).rejects.toBeInstanceOf(StaleWriteError);
    await expect(refused).rejects.toMatchObject({ reason: 'missing_base' });
    expect(await stored(noteId)).toBe('B\n');
    // With its base it merges: the deletion stays.
    const saved = await notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: 'A\n\nB\n\nC\n', baseSha256: read!.bodySha256, baseBody: read!.body });
    expect(saved.note.body).toBe('B\n\nC\n');
    // A metadata-only save (no body) needs no base.
    await notes.save({ scope: aliceScope, id: noteId, title: 'Renamed' });
    expect(await stored(noteId)).toBe('B\n\nC\n');
  });

  test('a meeting re-import merges from the body it last rendered; over a note it never rendered, it is refused', async () => {
    const { ingestMeeting, meetingSlug } = await import('@/core/knowledge/meetings');
    const { StaleWriteError } = await import('./hub');
    const at = '2026-10-03T09:00:00.000Z';
    const first = await ingestMeeting({ userId: alice, workspaceId: spaceId, scope: aliceScope, title: 'Standup', at, body: 'invite text' });
    // A member writes into the (closed) note; it is persisted.
    const a = new Client(`a-${rand(3)}`, alice, first.noteId);
    await a.join();
    a.type(a.text.length, 'Decided: ship\n');
    await settle();
    await hub.leave(a.connectionId, first.noteId);
    const again = await ingestMeeting({ userId: alice, workspaceId: spaceId, scope: aliceScope, title: 'Standup', at, body: 'invite text, updated' });
    expect(again.noteId).toBe(first.noteId);
    const body = await stored(first.noteId);
    expect(body).toContain('invite text, updated');
    expect(body).toContain('Decided: ship');
    // A note a member made at that slug has no rendered body: no base, refused.
    const other = '2026-10-04T09:00:00.000Z';
    await notes.save({ scope: aliceScope, slug: meetingSlug('Retro', other), title: 'Retro', body: 'hand written\n' });
    await expect(ingestMeeting({ userId: alice, workspaceId: spaceId, scope: aliceScope, title: 'Retro', at: other, body: 'x' }))
      .rejects.toBeInstanceOf(StaleWriteError);
  });

  test('the live reindex keeps explicit tags and replaces only the body’s #tags', async () => {
    const saved = await notes.save({ scope: aliceScope, title: `Tagged ${rand(3)}`, body: 'text #old\n', tags: ['keep'] });
    expect([...saved.note.tags].sort()).toEqual(['keep', 'old']);
    const a = new Client(`a-${rand(3)}`, alice, saved.note.id);
    await a.join();
    const at = a.text.indexOf('#old');
    a.doc.getText('body').delete(at, 4);
    a.type(at, '#new');
    await settle();
    await hub.leave(a.connectionId, saved.note.id);
    const after = await notes.getById(aliceScope, saved.note.id);
    expect([...(after?.tags ?? [])].sort()).toEqual(['keep', 'new']);
  });

  test('capture appends to an open daily note while someone types at its end', async () => {
    const daily = await notes.getOrCreateDaily(aliceScope, '2026-10-03');
    const a = new Client(`a-${rand(3)}`, alice, daily.id);
    await a.join();
    a.type(a.text.length, 'typing at the end');
    await settle();
    await notes.capture(aliceScope, 'captured', '2026-10-03');
    await settle();
    expect(a.text).toContain('## Tasks\ntyping at the end\n- ');
    expect(a.text).toMatch(/- \d\d:\d\d captured\n$/);
    expect(hub.readLive(daily.id)?.text).toBe(a.text);
    await hub.leave(a.connectionId, daily.id);
  });

  test('a failed persist keeps its authors for the next revision', async () => {
    const noteId = await newNote('authors\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    const b = new Client(`b-${rand(3)}`, bob, noteId);
    await a.join();
    await b.join();
    b.type(0, 'bob ');
    await settle();
    hooks.writeBody = async () => {
      hooks.writeBody = undefined;
      throw new Error('database unavailable');
    };
    await hub.flushAll();
    expect(await stored(noteId)).toBe('authors\n');
    a.type(0, 'alice ');
    await settle();
    await hub.flushAll();
    const live = (await revisions(noteId)).filter((r) => r.origin === 'live');
    expect(live).toHaveLength(1);
    expect([...live[0].authors].sort()).toEqual([alice, bob].sort());
    await hub.leave(a.connectionId, noteId);
    await hub.leave(b.connectionId, noteId);
  });
});

describe('the document stays text with \\n line endings (review findings 5, 6)', () => {
  test('an update writing outside the text, an embed, a format or a \\r is refused; pending structs count toward the cap', async () => {
    const noteId = await newNote('hello');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    const attack = async (mutate: (doc: Y.Doc) => void) => {
      const forged = new Y.Doc();
      Y.applyUpdate(forged, Y.encodeStateAsUpdate(a.doc));
      const before = Y.encodeStateVector(forged);
      mutate(forged);
      now += 1000;
      await hub.update(a.conn, noteId, a.epoch!, b64(Y.encodeStateAsUpdate(forged, before)));
    };
    await attack((doc) => doc.getText('body').insertEmbed(0, { blob: 'x'.repeat(1000) }));
    await attack((doc) => doc.getMap('junk').set('k', 'y'.repeat(1000)));
    await attack((doc) => doc.getText('body').format(0, 2, { bold: true }));
    await attack((doc) => doc.getText('body').insert(0, 'a\r\nb'));
    expect(a.errors()).toEqual(['INVALID_UPDATE', 'INVALID_UPDATE', 'INVALID_UPDATE', 'INVALID_UPDATE']);
    // Text whose predecessor never arrives waits in the document, outside
    // the text: it counts toward the encoded-state cap.
    const ghost = new Y.Doc();
    ghost.getText('body').insert(0, 'a'.repeat(3000));
    let vector = Y.encodeStateVector(ghost);
    ghost.getText('body').insert(3000, 'b'.repeat(3000));
    now += 1000;
    await hub.update(a.conn, noteId, a.epoch!, b64(Y.encodeStateAsUpdate(ghost, vector)));
    expect(a.errors()).toHaveLength(4);
    vector = Y.encodeStateVector(ghost);
    ghost.getText('body').insert(6000, 'c'.repeat(3000));
    await hub.update(a.conn, noteId, a.epoch!, b64(Y.encodeStateAsUpdate(ghost, vector)));
    expect(a.errors().at(-1)).toBe('TOO_LARGE');
    expect(hub.readLive(noteId)?.text).toBe('hello');
    await hub.leave(a.connectionId, noteId);
  });

  test('a CRLF body is built with \\n and saved as a revision; a writer’s CRLF text is normalized', async () => {
    const { queryRaw } = await import('@/db/postgres');
    const { sha256Hex } = await import('./hub');
    const noteId = await newNote('x\n');
    const crlf = 'one\r\ntwo\r\n';
    await queryRaw('UPDATE notes SET body = $2, body_sha256 = $3 WHERE id = $1', [noteId, crlf, sha256Hex(crlf)]);
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    expect(a.text).toBe('one\ntwo\n');
    expect(await stored(noteId)).toBe('one\ntwo\n');
    expect((await revisions(noteId)).at(-1)?.origin).toBe('live');
    // Typing after the first line lands where it was typed.
    a.type(a.text.indexOf('two'), 'and ');
    await settle();
    expect(hub.readLive(noteId)?.text).toBe('one\nand two\n');
    const read = await notes.getById(aliceScope, noteId);
    await notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: 'one\r\nand two\r\nthree\r\n', baseSha256: read!.bodySha256 });
    await settle();
    expect(a.text).toBe('one\nand two\nthree\n');
    await hub.leave(a.connectionId, noteId);
    expect(await stored(noteId)).toBe('one\nand two\nthree\n');
    // A closed note's write is normalized too.
    const again = await notes.getById(aliceScope, noteId);
    await notes.save({ scope: aliceScope, id: noteId, title: again!.title, body: 'one\r\nand two\r\nthree\r\nfour\r\n', baseSha256: again!.bodySha256 });
    expect(await stored(noteId)).toBe('one\nand two\nthree\nfour\n');
  });
});

describe('awareness is owned by the server (review finding 4)', () => {
  test('a member can neither take over, rename nor remove another’s cursor, nor flood ids', async () => {
    const { Awareness, encodeAwarenessUpdate } = await import('y-protocols/awareness');
    const { encodeAwarenessUpdate: encodeEntries } = await import('./awareness-guard');
    const { DOC_MAX_AWARENESS_CLIENTS } = await import('./hub');
    const noteId = await newNote('cursors\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    const b = new Client(`b-${rand(3)}`, bob, noteId);
    await a.join();
    await b.join();
    const victim = a.doc.clientID;
    const own = new Awareness(a.doc);
    own.setLocalStateField('user', { id: alice, name: 'Alice', color: 'hsl(1 70% 62%)' });
    await hub.awareness(a.conn, noteId, b64(encodeAwarenessUpdate(own, [victim])));
    now += 1000;
    // Bob forges Alice's id with a higher clock, then removes it.
    await hub.awareness(b.conn, noteId, b64(encodeEntries([{ clientId: victim, clock: 99, state: { user: { id: alice, name: 'Mallory says hi' } } }])));
    await hub.awareness(b.conn, noteId, b64(encodeEntries([{ clientId: victim, clock: 100, state: null }])));
    // His own state claims to be Alice: it is stamped as Bob.
    await hub.awareness(b.conn, noteId, b64(encodeEntries([{ clientId: b.doc.clientID, clock: 1, state: { user: { id: alice, name: 'Alice' }, cursor: null } }])));
    // A flood of ids keeps only the newest few.
    for (let i = 0; i < 5; i++) {
      await hub.awareness(b.conn, noteId, b64(encodeEntries([{ clientId: 100_000 + i, clock: 1, state: { user: {} } }])));
    }
    let states = await awarenessSeenBy(alice, noteId);
    expect(states.get(victim)).toEqual({ user: { id: alice, name: 'h-alice', color: 'hsl(1 70% 62%)' } });
    const bobs = [...states.entries()].filter(([id]) => id !== victim);
    expect(bobs).toHaveLength(DOC_MAX_AWARENESS_CLIENTS);
    for (const [, state] of bobs) expect(state?.user).toEqual({ id: bob, name: 'h-bob' });
    // Bob leaves: only his states go.
    await hub.leave(b.connectionId, noteId);
    states = await awarenessSeenBy(alice, noteId);
    expect([...states.keys()]).toEqual([victim]);
    own.destroy();
    await hub.leave(a.connectionId, noteId);
  });
});

describe('access changes take effect (review findings 7, 9)', () => {
  test('a removal between the join’s role read and its end still drops the member on the next frame', async () => {
    const erin = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: erin, username: `h-erin-${rand(2)}` }]);
    const { createInvite, acceptInvite } = await import('@/core/spaces/invites');
    const invite = await createInvite({ userId: alice }, spaceId, { role: 'editor' });
    await acceptInvite({ userId: erin }, invite.token);
    const noteId = await newNote('guarded\n');
    const { removeMember } = await import('@/core/spaces/service');
    hooks.afterMembershipRead = async () => {
      hooks.afterMembershipRead = undefined;
      await removeMember({ userId: alice }, spaceId, erin);
    };
    const e = new Client(`e-${rand(3)}`, erin, noteId);
    await e.join();
    e.type(0, 'sneaky ');
    await settle();
    expect(inbox.get(e.connectionId)?.some((m) => m.type === 'doc.closed' && m.reason === 'access')).toBe(true);
    expect(await stored(noteId)).toBe('guarded\n');
  });

  test('a downgrade to viewer makes the editor read-only and refuses the next update; an upgrade gives it back', async () => {
    const { setRole } = await import('@/core/spaces/service');
    const noteId = await newNote('roles\n');
    const b = new Client(`b-${rand(3)}`, bob, noteId);
    await b.join();
    expect(b.readOnly).toBe(false);
    await setRole({ userId: alice }, spaceId, bob, { role: 'viewer' });
    const statuses = () => (inbox.get(b.connectionId) ?? []).filter((m) => m.type === 'doc.status') as Array<{ readOnly: boolean }>;
    expect(statuses().at(-1)?.readOnly).toBe(true);
    b.type(0, 'no ');
    await settle();
    expect(b.errors()).toContain('FORBIDDEN');
    expect(hub.readLive(noteId)?.text).toBe('roles\n');
    await setRole({ userId: alice }, spaceId, bob, { role: 'editor' });
    expect(statuses().at(-1)?.readOnly).toBe(false);
    await hub.leave(b.connectionId, noteId);
  });

  test('an archived space reads only (pending edits saved first); unarchived, it is editable again', async () => {
    const noteId = await newNote('arch\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    a.type(0, 'kept ');
    await settle();
    await hub.setSpaceArchived(spaceId, true);
    expect(await stored(noteId)).toBe('kept arch\n');
    const statuses = () => (inbox.get(a.connectionId) ?? []).filter((m) => m.type === 'doc.status') as Array<{ readOnly: boolean }>;
    expect(statuses().at(-1)?.readOnly).toBe(true);
    a.type(0, 'x');
    await settle();
    expect(a.errors()).toContain('ARCHIVED');
    expect(hub.readLive(noteId)?.text).toBe('kept arch\n');
    await hub.setSpaceArchived(spaceId, false);
    expect(statuses().at(-1)?.readOnly).toBe(false);
    await hub.leave(a.connectionId, noteId);
  });

  test('an archived note opens read-only', async () => {
    const noteId = await newNote('old\n');
    expect(await notes.archive(aliceScope, noteId)).toBe(true);
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    expect(a.readOnly).toBe(true);
    expect(a.text).toBe('old\n');
    a.type(0, 'edit ');
    await settle();
    expect(a.errors()).toContain('ARCHIVED');
    await hub.leave(a.connectionId, noteId);
    expect(await stored(noteId)).toBe('old\n');
  });
});

describe('bases (review finding 13)', () => {
  test('persists do not evict a base a writer read; after the TTL it is gone', async () => {
    const { StaleWriteError, DOC_MAX_BASES } = await import('./hub');
    const noteId = await newNote('para one\n\npara two\n');
    const a = new Client(`a-${rand(3)}`, alice, noteId);
    await a.join();
    const read = await notes.getById(aliceScope, noteId);
    for (let i = 0; i < DOC_MAX_BASES + 5; i++) {
      now += 200;
      a.type(0, `${i} `);
      await settle();
      await hub.flushAll();
    }
    const saved = await notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: 'para one\n\npara TWO\n', baseSha256: read!.bodySha256 });
    expect(saved.merged).toBe(true);
    expect(hub.readLive(noteId)?.text).toMatch(/para one\n\npara TWO\n$/);
    const later = await notes.getById(aliceScope, noteId);
    now += (limits.docBaseTtlMinutes + 1) * 60_000;
    a.type(0, 'late ');
    await settle();
    await expect(notes.save({ scope: aliceScope, id: noteId, title: read!.title, body: `${later!.body}tail\n`, baseSha256: later!.bodySha256 }))
      .rejects.toBeInstanceOf(StaleWriteError);
    await hub.leave(a.connectionId, noteId);
  });
});
