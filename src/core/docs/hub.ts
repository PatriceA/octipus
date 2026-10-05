/**
 * The document hub (docs/plans/coworking-spec.md §7.3, S3): live editing of
 * space notes.
 *
 * A space note open in an editor lives here as a Yjs document (`Y.Text`
 * named `body`), in memory (single process, D16). Members join it over the
 * gateway (`doc.join`), exchange `doc.update` / `doc.awareness` frames, and
 * leave (`doc.leave`, or their connection closes).
 *
 * - **Epoch.** Every time the hub builds a document from `notes.body` it
 *   draws a new epoch. A client holding another epoch discards its document
 *   and re-seeds from the full state, so a reconnect after a rebuild never
 *   merges two histories of the same text (which would duplicate it).
 *   Concurrent first joins share one init.
 * - **Limits.** `spaces.noteMaxBytes` per note (startup refuses a value
 *   above half of `gateway.maxFrameBytes`, `assertDocLimits`),
 *   `spaces.docMaxUpdatesPerSecond` `doc.update` and 10 `doc.awareness` per
 *   connection per second. Updates check the in-process membership version
 *   (D5) and re-read the membership from the database when it moved.
 * - **External writers.** Every note writer goes through `applyExternal`
 *   while the note is open: the writer names the base it read (`readLive`
 *   pins every text it hands out, for `spaces.docBaseTtlMinutes`, at most
 *   32 bases and 4× the note size per document); the hub merges
 *   `diff3(base, current, next)` and applies `current → merged` to the
 *   `Y.Text` in one transaction. An unknown base or a conflict is refused as
 *   stale (`StaleWriteError`): concurrent edits are never reverted.
 * - **Persistence.** One mutex per note covers init, persist and every
 *   closed-note write (`exclusive`). The body is persisted with a revision
 *   after `spaces.docPersistDebounceMs` idle and on last leave, by a
 *   conditional write on the sha the hub last loaded or persisted; a
 *   mismatch (someone wrote around the hub) reloads the document under a new
 *   epoch. Links and the search index are refreshed on last leave and at
 *   most every `spaces.docReindexMinutes`.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { NoteRevisionOrigin } from '@/db/schema/live-documents';
import type { NewRevision, SpaceNoteRow } from '@/db/repositories/live-documents';
import type { DocErrorCode, GatewayMessage } from '@/core/gateway/protocol';
import { can, type SpaceRole } from '@/security/space-access';
import { coreLogger } from '@/utils/logger';
import { KeyedMutex } from './keyed-mutex';
import { merge3, textEdits } from './text-merge';

const logger = coreLogger.child({ component: 'doc-hub' });

/** `doc.awareness` frames one connection may send per second. */
export const DOC_AWARENESS_PER_SECOND = 10;
/** Bases one document keeps (oldest evicted first). */
export const DOC_MAX_BASES = 32;
/** Total size of one document's bases, as a multiple of `noteMaxBytes`. */
export const DOC_BASES_SIZE_FACTOR = 4;

export interface DocLimits {
  noteMaxBytes: number;
  docMaxUpdatesPerSecond: number;
  docPersistDebounceMs: number;
  docReindexMinutes: number;
  docBaseTtlMinutes: number;
}

/**
 * Startup check (§7.3): a full `doc.sync` carries the note as a base64 Yjs
 * update in a JSON frame, so the note may use at most half of the frame.
 */
export function assertDocLimits(noteMaxBytes: number, maxFrameBytes: number): void {
  if (noteMaxBytes > maxFrameBytes / 2) {
    throw new Error(
      `spaces.noteMaxBytes (${noteMaxBytes}) must be at most half of gateway.maxFrameBytes (${maxFrameBytes}): a full doc.sync carries the note base64-encoded with Yjs overhead in one frame`,
    );
  }
}

/** The write was made against a text the hub cannot merge with (unknown base, or a conflicting change). */
export class StaleWriteError extends Error {
  constructor(readonly reason: 'unknown_base' | 'conflict', readonly currentSha256: string) {
    super(reason === 'conflict'
      ? 'The note changed in the same place since it was read; read it again and reapply the change'
      : 'The note changed since it was read; read it again and reapply the change');
    this.name = 'StaleWriteError';
  }
}

export class NoteTooLargeError extends Error {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`The note would be ${bytes} bytes; a space note holds at most ${maxBytes}`);
    this.name = 'NoteTooLargeError';
  }
}

/** Who changed the document. `peer` is a member typing; the rest are writers outside the editor. */
export interface DocOrigin {
  kind: 'peer' | NoteRevisionOrigin;
  /** The author: the member typing, or the member whose write it is. */
  userId: string;
  /** For an agent's write or an accepted proposal: the member it was written for. */
  onBehalfOfUserId?: string | null;
  connectionId?: string;
  /** For `restore`: the revision restored. */
  restoredFrom?: string | null;
}

export interface DocHubDeps {
  load(noteId: string): Promise<SpaceNoteRow | null>;
  /** Conditional write: only while the body's sha is still `expectedSha`. */
  writeBody(noteId: string, workspaceId: string, expectedSha: string, body: string, sha: string): Promise<boolean>;
  insertRevision(rev: NewRevision): Promise<{ id: string }>;
  /** Refresh links and the search index of the note, billed to `editorUserId`. */
  reindex(noteId: string, editorUserId: string): Promise<void>;
  /** The member's role, read from the database (D5); null when not a member. */
  membership(userId: string, workspaceId: string): Promise<SpaceRole | null>;
  /** The in-process membership version (D5). */
  membershipVersion(workspaceId: string, userId: string): number;
  send(connectionId: string, message: GatewayMessage): void;
  /** Add or remove the connection's `doc:<id>` resource. */
  setResource(connectionId: string, resource: string, on: boolean): void;
  /** Who is in which note of the space changed (presence). */
  peersChanged(workspaceId: string): void;
  limits(): DocLimits;
  now(): number;
}

interface Peer {
  connectionId: string;
  userId: string;
  role: SpaceRole;
  version: number;
  /** Awareness client ids this connection announced. */
  awarenessClients: Set<number>;
  joinedAt: number;
}

interface Base {
  sha: string;
  text: string;
  at: number;
}

interface LiveDoc {
  noteId: string;
  workspaceId: string;
  epoch: string;
  ydoc: Y.Doc;
  text: Y.Text;
  awareness: Awareness;
  peers: Map<string, Peer>;
  /** sha of `notes.body` as last loaded or persisted: the persist's condition. */
  persistedSha: string;
  /** Bumped by every change; a persist clears `dirty` only when none came in meanwhile. */
  changeSeq: number;
  dirty: boolean;
  /** Members whose keystrokes are in the text since the last revision. */
  authors: Set<string>;
  lastEditorUserId: string | null;
  needsReindex: boolean;
  bases: Base[];
  spaceArchived: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
  reindexTimer: ReturnType<typeof setInterval> | null;
  closing: boolean;
}

/** A read of an open note: its live text and sha (pinned as a base). */
export interface LiveText {
  text: string;
  sha256: string;
}

export interface ExternalWriteResult {
  /** The text after the write (the merge of the writer's change into the live text). */
  text: string;
  sha256: string;
  /** False when the write changed nothing. */
  changed: boolean;
  /** True when other changes were merged in (the result differs from the writer's text). */
  merged: boolean;
  revisionId: string | null;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));
const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

/** sha256 of a note body, hex — the same digest as `notes.body_sha256`. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class DocumentHub {
  private readonly docs = new Map<string, LiveDoc>();
  private readonly opening = new Map<string, Promise<LiveDoc | null>>();
  private readonly mutex = new KeyedMutex();
  private readonly rates = new Map<string, { updates: number[]; awareness: number[] }>();

  constructor(private readonly deps: DocHubDeps) {}

  // ── Gateway frames ─────────────────────────────────────────────

  async join(conn: { connectionId: string; userId: string }, noteId: string, client: { epoch?: string; stateVector?: string } = {}): Promise<void> {
    const note = this.docs.get(noteId) ?? await this.deps.load(noteId);
    // Not a space note, or not a member: the same answer (I3).
    const role = note ? await this.deps.membership(conn.userId, note.workspaceId) : null;
    if (!note || !role || role === 'guest') {
      this.error(conn.connectionId, noteId, 'NOT_FOUND', 'Note not found');
      return;
    }
    const doc = await this.open(noteId);
    if (!doc) {
      this.error(conn.connectionId, noteId, 'NOT_FOUND', 'Note not found');
      return;
    }
    const existing = doc.peers.get(conn.connectionId);
    doc.peers.set(conn.connectionId, {
      connectionId: conn.connectionId,
      userId: conn.userId,
      role,
      version: this.deps.membershipVersion(doc.workspaceId, conn.userId),
      awarenessClients: existing?.awarenessClients ?? new Set(),
      joinedAt: this.deps.now(),
    });
    this.deps.setResource(conn.connectionId, `doc:${noteId}`, true);

    let state: Uint8Array;
    if (client.epoch === doc.epoch && client.stateVector) {
      try {
        state = Y.encodeStateAsUpdate(doc.ydoc, fromBase64(client.stateVector));
      } catch (err) {
        logger.warn({ err, noteId }, 'doc.join carried an unreadable state vector; sending the whole document');
        state = Y.encodeStateAsUpdate(doc.ydoc);
      }
    } else {
      state = Y.encodeStateAsUpdate(doc.ydoc);
    }
    this.sendSync(doc, conn.connectionId, state);
    const others = [...doc.awareness.getStates().keys()];
    if (others.length > 0) {
      this.deps.send(conn.connectionId, { type: 'doc.awareness', noteId, update: toBase64(encodeAwarenessUpdate(doc.awareness, others)) });
    }
    this.deps.peersChanged(doc.workspaceId);
  }

  async update(conn: { connectionId: string; userId: string }, noteId: string, epoch: string, update: string): Promise<void> {
    if (!this.allow(conn.connectionId, 'updates', this.deps.limits().docMaxUpdatesPerSecond)) {
      this.error(conn.connectionId, noteId, 'RATE_LIMITED', `At most ${this.deps.limits().docMaxUpdatesPerSecond} document updates per second`);
      return;
    }
    const found = await this.peerOf(conn, noteId);
    if (!found) return;
    const { doc, peer } = found;
    if (epoch !== doc.epoch) {
      // The client edits a document the server no longer has: it re-seeds.
      this.error(conn.connectionId, noteId, 'STALE_EPOCH', 'The note was reloaded; your editor resyncs');
      this.sendSync(doc, conn.connectionId, Y.encodeStateAsUpdate(doc.ydoc));
      return;
    }
    if (doc.spaceArchived) {
      this.error(conn.connectionId, noteId, 'ARCHIVED', 'This space is archived');
      return;
    }
    if (!can(peer.role, 'write')) {
      this.error(conn.connectionId, noteId, 'FORBIDDEN', `Your role (${peer.role}) cannot edit notes in this space`);
      return;
    }
    const bytes = fromBase64(update);
    const max = this.deps.limits().noteMaxBytes;
    // An update grows the text by at most its own size (inserted text is in it).
    if (byteLength(doc.text.toString()) + bytes.length > max) {
      const after = this.probe(doc, bytes);
      if (after === null) {
        this.error(conn.connectionId, noteId, 'INVALID_UPDATE', 'The update could not be read');
        return;
      }
      if (after > max) {
        this.error(conn.connectionId, noteId, 'TOO_LARGE', `A space note holds at most ${max} bytes`);
        return;
      }
    }
    try {
      Y.applyUpdate(doc.ydoc, bytes, { kind: 'peer', userId: conn.userId, connectionId: conn.connectionId } satisfies DocOrigin);
    } catch (err) {
      logger.warn({ err, noteId, connectionId: conn.connectionId }, 'doc.update could not be applied');
      this.error(conn.connectionId, noteId, 'INVALID_UPDATE', 'The update could not be read');
    }
  }

  async awareness(conn: { connectionId: string; userId: string }, noteId: string, update: string): Promise<void> {
    if (!this.allow(conn.connectionId, 'awareness', DOC_AWARENESS_PER_SECOND)) {
      this.error(conn.connectionId, noteId, 'RATE_LIMITED', `At most ${DOC_AWARENESS_PER_SECOND} cursor updates per second`);
      return;
    }
    const found = await this.peerOf(conn, noteId);
    if (!found) return;
    try {
      applyAwarenessUpdate(found.doc.awareness, fromBase64(update), conn.connectionId);
    } catch (err) {
      logger.warn({ err, noteId, connectionId: conn.connectionId }, 'doc.awareness could not be applied');
      this.error(conn.connectionId, noteId, 'INVALID_UPDATE', 'The awareness update could not be read');
    }
  }

  async leave(connectionId: string, noteId: string): Promise<void> {
    const doc = this.docs.get(noteId);
    if (!doc || !doc.peers.has(connectionId)) return;
    this.removePeer(doc, connectionId);
    this.deps.peersChanged(doc.workspaceId);
    if (doc.peers.size === 0) await this.close(doc);
  }

  /** Every document of a closed connection. */
  async connectionClosed(connectionId: string): Promise<void> {
    this.rates.delete(connectionId);
    const left = [...this.docs.values()].filter((d) => d.peers.has(connectionId));
    await Promise.all(left.map((d) => this.leave(connectionId, d.noteId).catch((err) => {
      logger.error({ err, noteId: d.noteId, connectionId }, 'Leaving a document on close failed');
    })));
  }

  // ── Writers ────────────────────────────────────────────────────

  /** Whether the note is open (has a live document). */
  isOpen(noteId: string): boolean {
    return this.docs.has(noteId);
  }

  /**
   * The live text and sha of an open note, pinned as a base so a write made
   * from it merges. Null when the note is not open (read `notes.body`).
   */
  readLive(noteId: string): LiveText | null {
    const doc = this.docs.get(noteId);
    if (!doc) return null;
    const text = doc.text.toString();
    const sha256 = this.pin(doc, text);
    return { text, sha256 };
  }

  /**
   * Run `fn` holding the note's mutex — the one that covers the hub's init
   * and persist — with `open` true when the note has a live document. A
   * closed-note write runs inside it; an open one calls `applyExternalLocked`.
   */
  exclusive<T>(noteId: string, fn: (open: boolean) => Promise<T>): Promise<T> {
    return this.mutex.run(noteId, () => fn(this.docs.has(noteId)));
  }

  /**
   * Apply a writer's change to an open note: `base` is the sha (and, when
   * the writer kept it, the text) it read, `next` what it wants. Throws
   * `StaleWriteError` / `NoteTooLargeError`; null when the note is not open.
   */
  applyExternal(noteId: string, base: { sha256: string; text?: string }, next: string, origin: DocOrigin): Promise<ExternalWriteResult | null> {
    return this.exclusive(noteId, (open) => (open ? this.applyExternalLocked(noteId, base, next, origin) : Promise.resolve(null)));
  }

  /** `applyExternal` for a caller already inside `exclusive(noteId)` with `open` true. */
  async applyExternalLocked(noteId: string, base: { sha256: string; text?: string }, next: string, origin: DocOrigin): Promise<ExternalWriteResult> {
    const doc = this.docs.get(noteId);
    if (!doc) throw new Error(`applyExternalLocked: note ${noteId} is not open`);
    const max = this.deps.limits().noteMaxBytes;
    if (byteLength(next) > max) throw new NoteTooLargeError(byteLength(next), max);
    // The editors' keystrokes so far become their own revision first.
    await this.persistLocked(doc);
    // A persist that found the database moved rebuilt the document: the
    // writer's base is from before that.
    if (this.docs.get(noteId) !== doc) throw new StaleWriteError('unknown_base', this.docs.get(noteId) ? sha256Hex(this.docs.get(noteId)!.text.toString()) : '');
    // From here to the transaction nothing awaits: `current` is the live text.
    const current = doc.text.toString();
    const currentSha = sha256Hex(current);
    const baseText = base.text !== undefined && sha256Hex(base.text) === base.sha256
      ? base.text
      : base.sha256 === currentSha ? current : this.lookupBase(doc, base.sha256);
    if (baseText === null) throw new StaleWriteError('unknown_base', currentSha);
    const result = merge3(baseText, current, next);
    if (!result.ok) throw new StaleWriteError('conflict', currentSha);
    const merged = result.text;
    if (byteLength(merged) > max) throw new NoteTooLargeError(byteLength(merged), max);
    if (merged === current) {
      return { text: current, sha256: currentSha, changed: false, merged: merged !== next, revisionId: null };
    }
    const edits = textEdits(current, merged);
    doc.ydoc.transact(() => {
      for (let i = edits.length - 1; i >= 0; i--) {
        const e = edits[i];
        if (e.remove > 0) doc.text.delete(e.index, e.remove);
        if (e.insert) doc.text.insert(e.index, e.insert);
      }
    }, origin);
    const revisionId = await this.persistLocked(doc, origin);
    const sha256 = this.pin(doc, merged);
    return { text: merged, sha256, changed: true, merged: merged !== next, revisionId };
  }

  /** Persist an open note's pending edits now (before an archive, say). Caller holds `exclusive`. */
  async flushLocked(noteId: string): Promise<void> {
    const doc = this.docs.get(noteId);
    if (doc) await this.persistLocked(doc);
  }

  /**
   * End the note's document for everyone in it (archived, deleted): pending
   * edits are persisted first unless it was deleted.
   */
  async closeNote(noteId: string, reason: 'archived' | 'deleted'): Promise<void> {
    await this.mutex.run(noteId, async () => {
      const doc = this.docs.get(noteId);
      if (!doc) return;
      if (reason !== 'deleted') await this.persistLocked(doc);
      for (const peer of [...doc.peers.values()]) {
        this.removePeer(doc, peer.connectionId);
        this.deps.send(peer.connectionId, { type: 'doc.closed', noteId, reason });
      }
      this.destroy(doc);
      this.deps.peersChanged(doc.workspaceId);
    });
  }

  // ── Membership and archive ─────────────────────────────────────

  /**
   * `userId`'s membership of the space changed (§5.9, I5): re-read it; drop
   * them from every document of the space they may no longer read, and tell
   * them when their edit right changed.
   */
  async membershipChanged(workspaceId: string, userId: string): Promise<void> {
    const docs = [...this.docs.values()].filter((d) => d.workspaceId === workspaceId && [...d.peers.values()].some((p) => p.userId === userId));
    if (docs.length === 0) return;
    const role = await this.deps.membership(userId, workspaceId);
    const version = this.deps.membershipVersion(workspaceId, userId);
    for (const doc of docs) {
      for (const peer of [...doc.peers.values()].filter((p) => p.userId === userId)) {
        if (!role || role === 'guest') {
          this.removePeer(doc, peer.connectionId);
          this.deps.send(peer.connectionId, { type: 'doc.closed', noteId: doc.noteId, reason: 'access' });
          continue;
        }
        const wasWriter = can(peer.role, 'write');
        peer.role = role;
        peer.version = version;
        if (wasWriter !== can(role, 'write')) {
          this.deps.send(peer.connectionId, { type: 'doc.status', noteId: doc.noteId, readOnly: this.readOnly(doc, peer) });
        }
      }
      if (doc.peers.size === 0) await this.close(doc);
    }
    this.deps.peersChanged(workspaceId);
  }

  /** The space was archived (pending edits are saved, then every document reads only) or unarchived. */
  async setSpaceArchived(workspaceId: string, archived: boolean): Promise<void> {
    for (const doc of [...this.docs.values()].filter((d) => d.workspaceId === workspaceId)) {
      await this.mutex.run(doc.noteId, async () => {
        if (archived) await this.persistLocked(doc);
        doc.spaceArchived = archived;
      });
      for (const peer of doc.peers.values()) {
        this.deps.send(peer.connectionId, { type: 'doc.status', noteId: doc.noteId, readOnly: this.readOnly(doc, peer) });
      }
    }
  }

  /** Who is in which note of the space (presence). */
  peersIn(workspaceId: string): Array<{ connectionId: string; userId: string; noteId: string; joinedAt: number }> {
    const out: Array<{ connectionId: string; userId: string; noteId: string; joinedAt: number }> = [];
    for (const doc of this.docs.values()) {
      if (doc.workspaceId !== workspaceId) continue;
      for (const peer of doc.peers.values()) out.push({ connectionId: peer.connectionId, userId: peer.userId, noteId: doc.noteId, joinedAt: peer.joinedAt });
    }
    return out;
  }

  /**
   * The notes `userId` has open in the space, newest join first: the
   * `where` hint of space presence (§6.6, owned by the rooms code), which
   * shows it only to recipients who may open the note.
   */
  openDocsFor(userId: string, workspaceId?: string): Array<{ noteId: string; workspaceId: string; connectionId: string; joinedAt: number }> {
    const out: Array<{ noteId: string; workspaceId: string; connectionId: string; joinedAt: number }> = [];
    for (const doc of this.docs.values()) {
      if (workspaceId && doc.workspaceId !== workspaceId) continue;
      for (const peer of doc.peers.values()) {
        if (peer.userId === userId) out.push({ noteId: doc.noteId, workspaceId: doc.workspaceId, connectionId: peer.connectionId, joinedAt: peer.joinedAt });
      }
    }
    return out.sort((a, b) => b.joinedAt - a.joinedAt);
  }

  /** Persist every open document (shutdown). */
  async flushAll(): Promise<void> {
    for (const doc of [...this.docs.values()]) {
      await this.mutex.run(doc.noteId, () => this.persistLocked(doc)).catch((err) => {
        logger.error({ err, noteId: doc.noteId }, 'Persisting a live note at shutdown failed');
      });
    }
  }

  // ── Internals ──────────────────────────────────────────────────

  private open(noteId: string): Promise<LiveDoc | null> {
    const live = this.docs.get(noteId);
    if (live && !live.closing) return Promise.resolve(live);
    let pending = this.opening.get(noteId);
    if (pending) return pending;
    pending = this.mutex.run(noteId, async () => {
      const again = this.docs.get(noteId);
      if (again) {
        again.closing = false;
        return again;
      }
      const row = await this.deps.load(noteId);
      if (!row) return null;
      const doc = this.build(row);
      this.docs.set(noteId, doc);
      return doc;
    }).finally(() => this.opening.delete(noteId));
    this.opening.set(noteId, pending);
    return pending;
  }

  private build(row: SpaceNoteRow): LiveDoc {
    const ydoc = new Y.Doc();
    const text = ydoc.getText('body');
    if (row.body) text.insert(0, row.body);
    const awareness = new Awareness(ydoc);
    awareness.setLocalState(null);
    const doc: LiveDoc = {
      noteId: row.id,
      workspaceId: row.workspaceId,
      epoch: randomBytes(9).toString('base64url'),
      ydoc,
      text,
      awareness,
      peers: new Map(),
      persistedSha: row.bodySha256,
      changeSeq: 0,
      dirty: false,
      authors: new Set(),
      lastEditorUserId: null,
      needsReindex: false,
      bases: [],
      spaceArchived: row.spaceArchived,
      persistTimer: null,
      reindexTimer: null,
      closing: false,
    };
    // What `notes.body` holds was handed out (lists, earlier reads): a base.
    this.pin(doc, row.body);
    this.wire(doc);
    const every = this.deps.limits().docReindexMinutes * 60_000;
    doc.reindexTimer = setInterval(() => {
      if (doc.needsReindex) void this.reindex(doc);
    }, every);
    doc.reindexTimer.unref?.();
    return doc;
  }

  private wire(doc: LiveDoc): void {
    doc.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      const from = origin as DocOrigin | null;
      doc.changeSeq++;
      doc.dirty = true;
      if (from?.kind === 'peer') {
        doc.authors.add(from.userId);
        doc.lastEditorUserId = from.userId;
        this.schedulePersist(doc);
      } else if (from) {
        doc.lastEditorUserId = from.onBehalfOfUserId ?? from.userId;
      }
      const message: GatewayMessage = { type: 'doc.update', noteId: doc.noteId, epoch: doc.epoch, update: toBase64(update) };
      for (const peer of doc.peers.values()) {
        if (peer.connectionId !== from?.connectionId) this.deps.send(peer.connectionId, message);
      }
    });
    doc.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      if (typeof origin === 'string') {
        const peer = doc.peers.get(origin);
        if (peer) {
          for (const id of [...added, ...updated]) peer.awarenessClients.add(id);
          for (const id of removed) peer.awarenessClients.delete(id);
        }
      }
      const message: GatewayMessage = { type: 'doc.awareness', noteId: doc.noteId, update: toBase64(encodeAwarenessUpdate(doc.awareness, changed)) };
      for (const peer of doc.peers.values()) {
        if (peer.connectionId !== origin) this.deps.send(peer.connectionId, message);
      }
    });
  }

  /** The peer of an open document, with the membership version checked (D5). */
  private async peerOf(conn: { connectionId: string; userId: string }, noteId: string): Promise<{ doc: LiveDoc; peer: Peer } | null> {
    const doc = this.docs.get(noteId);
    const peer = doc?.peers.get(conn.connectionId);
    if (!doc || !peer || peer.userId !== conn.userId) {
      this.error(conn.connectionId, noteId, 'NOT_JOINED', 'Join the note first');
      return null;
    }
    const version = this.deps.membershipVersion(doc.workspaceId, conn.userId);
    if (version !== peer.version) {
      const role = await this.deps.membership(conn.userId, doc.workspaceId);
      if (!role || role === 'guest') {
        this.removePeer(doc, conn.connectionId);
        this.deps.send(conn.connectionId, { type: 'doc.closed', noteId, reason: 'access' });
        this.deps.peersChanged(doc.workspaceId);
        if (doc.peers.size === 0) await this.close(doc);
        return null;
      }
      peer.role = role;
      peer.version = version;
    }
    return { doc, peer };
  }

  private removePeer(doc: LiveDoc, connectionId: string): void {
    const peer = doc.peers.get(connectionId);
    if (!peer) return;
    doc.peers.delete(connectionId);
    this.deps.setResource(connectionId, `doc:${doc.noteId}`, false);
    const clients = [...peer.awarenessClients].filter((id) => doc.awareness.getStates().has(id));
    if (clients.length > 0) removeAwarenessStates(doc.awareness, clients, 'leave');
  }

  /** Last one out: persist, refresh the index, drop the document. */
  private async close(doc: LiveDoc): Promise<void> {
    doc.closing = true;
    let closed = false;
    await this.mutex.run(doc.noteId, async () => {
      if (doc.peers.size > 0 || !doc.closing || this.docs.get(doc.noteId) !== doc) {
        doc.closing = false;
        return;
      }
      await this.persistLocked(doc);
      this.destroy(doc);
      closed = true;
    });
    if (closed && doc.needsReindex) await this.reindex(doc);
  }

  private destroy(doc: LiveDoc): void {
    if (doc.persistTimer) clearTimeout(doc.persistTimer);
    if (doc.reindexTimer) clearInterval(doc.reindexTimer);
    doc.persistTimer = null;
    doc.reindexTimer = null;
    if (this.docs.get(doc.noteId) === doc) this.docs.delete(doc.noteId);
    doc.awareness.destroy();
    doc.ydoc.destroy();
  }

  private schedulePersist(doc: LiveDoc): void {
    if (doc.persistTimer) clearTimeout(doc.persistTimer);
    doc.persistTimer = setTimeout(() => {
      doc.persistTimer = null;
      this.mutex.run(doc.noteId, () => this.persistLocked(doc)).catch((err) => {
        logger.error({ err, noteId: doc.noteId }, 'Persisting a live note failed; retrying on the next edit');
      });
    }, this.deps.limits().docPersistDebounceMs);
    doc.persistTimer.unref?.();
  }

  /**
   * Write the text to `notes.body` with a revision when it changed. Caller
   * holds the note's mutex. Returns the revision id, or null when nothing
   * was written.
   */
  private async persistLocked(doc: LiveDoc, origin?: DocOrigin): Promise<string | null> {
    if (!doc.dirty || this.docs.get(doc.noteId) !== doc) return null;
    const seq = doc.changeSeq;
    const body = doc.text.toString();
    const sha = sha256Hex(body);
    const authors = origin && origin.kind !== 'peer' ? [origin.userId, ...doc.authors] : [...doc.authors];
    doc.authors.clear();
    if (sha === doc.persistedSha) {
      if (doc.changeSeq === seq) doc.dirty = false;
      return null;
    }
    const written = await this.deps.writeBody(doc.noteId, doc.workspaceId, doc.persistedSha, body, sha);
    if (!written) {
      await this.reloadLocked(doc);
      return null;
    }
    doc.persistedSha = sha;
    if (doc.changeSeq === seq) doc.dirty = false;
    doc.needsReindex = true;
    const kind: NoteRevisionOrigin = origin && origin.kind !== 'peer' ? origin.kind : 'live';
    const revision = await this.deps.insertRevision({
      noteId: doc.noteId,
      workspaceId: doc.workspaceId,
      body,
      bodySha256: sha,
      authors,
      onBehalfOfUserId: origin?.onBehalfOfUserId ?? null,
      origin: kind,
      restoredFrom: origin?.restoredFrom ?? null,
    });
    // What the database now holds is handed out by every list read: a base.
    this.pin(doc, body);
    const savedAt = new Date(this.deps.now()).toISOString();
    for (const peer of doc.peers.values()) {
      this.deps.send(peer.connectionId, { type: 'doc.saved', noteId: doc.noteId, sha256: sha, revisionId: revision.id, savedAt });
    }
    if (doc.dirty) this.schedulePersist(doc);
    return revision.id;
  }

  /**
   * `notes.body` moved without the hub (a write around it): rebuild the
   * document from it under a new epoch; every editor re-seeds.
   */
  private async reloadLocked(doc: LiveDoc): Promise<void> {
    const row = await this.deps.load(doc.noteId);
    logger.error({ noteId: doc.noteId, expected: doc.persistedSha, found: row?.bodySha256 ?? null }, 'Live note changed in the database behind the hub; reloading it (unsaved live edits since the last save are dropped)');
    if (!row) {
      for (const peer of [...doc.peers.values()]) {
        this.removePeer(doc, peer.connectionId);
        this.deps.send(peer.connectionId, { type: 'doc.closed', noteId: doc.noteId, reason: 'deleted' });
      }
      this.destroy(doc);
      this.deps.peersChanged(doc.workspaceId);
      return;
    }
    const peers = [...doc.peers.values()];
    this.destroy(doc);
    const fresh = this.build(row);
    for (const peer of peers) fresh.peers.set(peer.connectionId, { ...peer, awarenessClients: new Set() });
    this.docs.set(doc.noteId, fresh);
    for (const peer of peers) this.sendSync(fresh, peer.connectionId, Y.encodeStateAsUpdate(fresh.ydoc));
  }

  private async reindex(doc: LiveDoc): Promise<void> {
    const editor = doc.lastEditorUserId;
    doc.needsReindex = false;
    if (!editor) return;
    try {
      await this.deps.reindex(doc.noteId, editor);
    } catch (err) {
      doc.needsReindex = true;
      logger.error({ err, noteId: doc.noteId }, 'Refreshing the links and index of a live note failed');
    }
  }

  private sendSync(doc: LiveDoc, connectionId: string, state: Uint8Array): void {
    const peer = doc.peers.get(connectionId);
    this.deps.send(connectionId, {
      type: 'doc.sync',
      noteId: doc.noteId,
      epoch: doc.epoch,
      state: toBase64(state),
      stateVector: toBase64(Y.encodeStateVector(doc.ydoc)),
      readOnly: peer ? this.readOnly(doc, peer) : true,
      sha256: sha256Hex(doc.text.toString()),
      maxBytes: this.deps.limits().noteMaxBytes,
    });
  }

  private readOnly(doc: LiveDoc, peer: Peer): boolean {
    return doc.spaceArchived || !can(peer.role, 'write');
  }

  /** The byte size of the text after `update`, on a copy; null when the update is unreadable. */
  private probe(doc: LiveDoc, update: Uint8Array): number | null {
    const copy = new Y.Doc();
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc.ydoc));
      Y.applyUpdate(copy, update);
      return byteLength(copy.getText('body').toString());
    } catch (err) {
      logger.warn({ err, noteId: doc.noteId }, 'doc.update could not be read');
      return null;
    } finally {
      copy.destroy();
    }
  }

  /** Pin `text` as a base of the document; returns its sha. */
  private pin(doc: LiveDoc, text: string): string {
    const sha = sha256Hex(text);
    doc.bases = doc.bases.filter((b) => b.sha !== sha);
    doc.bases.push({ sha, text, at: this.deps.now() });
    this.evict(doc);
    return sha;
  }

  private lookupBase(doc: LiveDoc, sha: string): string | null {
    this.evict(doc);
    return doc.bases.find((b) => b.sha === sha)?.text ?? null;
  }

  private evict(doc: LiveDoc): void {
    const limits = this.deps.limits();
    const oldest = this.deps.now() - limits.docBaseTtlMinutes * 60_000;
    doc.bases = doc.bases.filter((b) => b.at >= oldest);
    const budget = DOC_BASES_SIZE_FACTOR * limits.noteMaxBytes;
    let size = doc.bases.reduce((n, b) => n + byteLength(b.text), 0);
    while (doc.bases.length > DOC_MAX_BASES || (size > budget && doc.bases.length > 1)) {
      const dropped = doc.bases.shift();
      if (dropped) size -= byteLength(dropped.text);
    }
  }

  private allow(connectionId: string, kind: 'updates' | 'awareness', perSecond: number): boolean {
    let entry = this.rates.get(connectionId);
    if (!entry) {
      entry = { updates: [], awareness: [] };
      this.rates.set(connectionId, entry);
    }
    const now = this.deps.now();
    const recent = entry[kind].filter((t) => t > now - 1000);
    if (recent.length >= perSecond) {
      entry[kind] = recent;
      return false;
    }
    recent.push(now);
    entry[kind] = recent;
    return true;
  }

  private error(connectionId: string, noteId: string, code: DocErrorCode, message: string): void {
    this.deps.send(connectionId, { type: 'doc.error', noteId, code, message });
  }
}
