/**
 * A space note open for live editing (docs/plans/coworking-spec.md §7.3,
 * §7.6): the browser side of the document hub (`src/core/docs/hub.ts`).
 *
 * Holds the note's Yjs document and awareness, synced over the tab's
 * gateway connection with `doc.join` / `doc.update` / `doc.awareness` /
 * `doc.leave`:
 *
 * - **Epoch.** `doc.sync` names the epoch the server built the document at.
 *   A different epoch than the one held means the server rebuilt it from the
 *   database (a restart, a reload, or the note was closed longer than the
 *   hub keeps it): the local document is discarded and re-seeded (`onReset`
 *   listeners rebind the editor), so a reconnect never duplicates text.
 *   What this copy had beyond the last server text it knew (typed offline,
 *   or not yet sent) is not dropped: it is merged into the new document as
 *   text, three-way from that server text (`merge`, `POST /notes/:id/merge`,
 *   which goes through the hub). A clash keeps the member's text on the
 *   state (`unmerged`) with a notice, for them to copy.
 *   With the same epoch, only what is missing travels both ways.
 * - **Batching.** Local edits are merged and sent at most every 50 ms, well
 *   under `spaces.docMaxUpdatesPerSecond`; cursor updates every 100 ms.
 * - **Refusals.** An update the server refused leaves this copy ahead of it:
 *   a size or permission refusal re-seeds from the server (dropping what was
 *   refused, not merging it back); a rate refusal resyncs after a second,
 *   sending what was refused again.
 * - **Saved.** `doc.saved` drives the "Saved" indicator.
 */
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { ClientMessage, GatewayMessage } from '../../src/core/gateway/protocol';

/**
 * The part of the tab's gateway connection (`WebGateway`, ./gateway) a live
 * note uses. Stated structurally rather than imported, so this module stays
 * free of the browser API client: the backend test suite drives it directly.
 */
export interface LiveNoteGateway {
  getStatus(): string;
  send(message: ClientMessage): boolean;
  onMessage(listener: (message: GatewayMessage) => void): () => void;
  onStatus(listener: (status: string) => void): () => void;
}

export type LiveNoteStatus = 'connecting' | 'saved' | 'unsaved' | 'offline' | 'closed';

export interface LiveNoteState {
  status: LiveNoteStatus;
  readOnly: boolean;
  savedAt: string | null;
  /** Set when the server ended the session (access lost, archived, deleted) or refused an edit. */
  notice: string | null;
  /** The first `doc.sync` arrived: the document holds the note. */
  synced: boolean;
  /** This member's text that could not be merged after a rebuild (a clash): theirs to copy. */
  unmerged: string | null;
}

/**
 * Merge `text` (this copy) into the note, from `base` (the last server text
 * it synced): `merged`, or `conflict` when the two changes clash. Throws
 * when the server could not be reached or refused it otherwise.
 */
export type LiveMerge = (base: string, text: string) => Promise<'merged' | 'conflict'>;

const SEND_EVERY_MS = 50;
const AWARENESS_EVERY_MS = 100;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A stable color per user for cursors and avatars. */
export function colorFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 70% 62%)`;
}

export class LiveNoteSession {
  doc = new Y.Doc();
  awareness = new Awareness(this.doc);
  private epoch: string | null = null;
  private pending: Uint8Array[] = [];
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessDirty = new Set<number>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribers: Array<() => void> = [];
  private readonly resetListeners = new Set<() => void>();
  private readonly stateListeners = new Set<(state: LiveNoteState) => void>();
  private state: LiveNoteState = { status: 'connecting', readOnly: true, savedAt: null, notice: null, synced: false, unmerged: null };
  private closed = false;
  /**
   * The last text this copy knows the server held (after a `doc.sync` with
   * nothing to send back, or a `doc.saved` of this very text): the base of
   * a merge after a rebuild. Null before the first sync.
   */
  private serverText: string | null = null;
  /** The server refused this copy's edits: the next re-seed drops them instead of merging them back. */
  private discardLocal = false;
  /**
   * A `doc.sync` answered the last `doc.join` on this connection. Until it
   * does, nothing is sent: an update or cursor ahead of the join is refused
   * (`NOT_JOINED`), and the sync's state vector says what to send anyway.
   */
  private joined = false;

  constructor(
    private readonly gateway: LiveNoteGateway,
    readonly noteId: string,
    private readonly user: { id: string; name: string },
    private readonly merge: LiveMerge,
  ) {
    this.wireDoc();
    this.unsubscribers.push(gateway.onMessage((m) => this.handle(m)));
    this.unsubscribers.push(gateway.onStatus((status) => {
      if (status === 'connected') this.join();
      else if (!this.closed) {
        this.joined = false;
        this.setState({ status: 'offline' });
      }
    }));
    if (gateway.getStatus() === 'connected') this.join();
  }

  get text(): Y.Text {
    return this.doc.getText('body');
  }

  getState(): LiveNoteState {
    return this.state;
  }

  /** Called after the document was replaced (a new epoch): rebind the editor to `text` / `awareness`. */
  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

  onState(listener: (state: LiveNoteState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Leave the note (unmount, another note opened). */
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    this.gateway.send({ type: 'doc.leave', noteId: this.noteId });
    for (const off of this.unsubscribers) off();
    this.clearTimers();
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'leave');
    this.awareness.destroy();
    this.doc.destroy();
  }

  /** The member copied (or dismissed) their unmerged text. */
  dismissUnmerged(): void {
    this.setState({ unmerged: null, notice: null });
  }

  // ── Internals ──────────────────────────────────────────────────

  private wireDoc(): void {
    this.awareness.setLocalStateField('user', { id: this.user.id, name: this.user.name, color: colorFor(this.user.id) });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      this.pending.push(update);
      this.setState({ status: 'unsaved' });
      this.sendTimer ??= setTimeout(() => this.flush(), SEND_EVERY_MS);
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === 'remote') return;
      for (const id of [...added, ...updated, ...removed]) this.awarenessDirty.add(id);
      this.awarenessTimer ??= setTimeout(() => this.flushAwareness(), AWARENESS_EVERY_MS);
    });
  }

  private join(): void {
    if (this.closed) return;
    // What is unsent goes after the sync, from its state vector.
    this.joined = false;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    this.pending = [];
    this.gateway.send(this.epoch
      ? { type: 'doc.join', noteId: this.noteId, epoch: this.epoch, stateVector: toBase64(Y.encodeStateVector(this.doc)) }
      : { type: 'doc.join', noteId: this.noteId });
  }

  private flush(): void {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    if (this.pending.length === 0 || !this.epoch || !this.joined || this.state.readOnly) {
      if (this.state.readOnly) this.pending = [];
      return;
    }
    const update = Y.mergeUpdates(this.pending);
    // Not connected: keep it, the next join sends what the server lacks.
    if (this.gateway.send({ type: 'doc.update', noteId: this.noteId, epoch: this.epoch, update: toBase64(update) })) this.pending = [];
  }

  private flushAwareness(): void {
    this.awarenessTimer = null;
    // Sent once joined (the sync flushes what is dirty).
    if (!this.joined) return;
    // Only clients this awareness knows (a reseed replaced the old one).
    const changed = [...this.awarenessDirty].filter((id) => this.awareness.meta.has(id));
    this.awarenessDirty.clear();
    if (changed.length === 0 || this.closed) return;
    this.gateway.send({ type: 'doc.awareness', noteId: this.noteId, update: toBase64(encodeAwarenessUpdate(this.awareness, changed)) });
  }

  private handle(message: GatewayMessage): void {
    if (this.closed || !('noteId' in message) || message.noteId !== this.noteId) return;
    switch (message.type) {
      case 'doc.sync': {
        let unsent: { base: string; text: string } | null = null;
        // After a refusal its notice stays up over the resync.
        const refused = this.discardLocal;
        if (message.epoch !== this.epoch) {
          // A rebuilt document: what this copy had beyond the last server
          // text it knew goes back in as text once re-seeded.
          const text = this.text.toString();
          if (this.epoch !== null && this.serverText !== null && !this.discardLocal && text !== this.serverText) {
            unsent = { base: this.serverText, text };
          }
          this.discardLocal = false;
          this.reseed();
        }
        this.epoch = message.epoch;
        this.joined = true;
        // Whatever was queued is in `missing` below.
        this.pending = [];
        Y.applyUpdate(this.doc, fromBase64(message.state), 'remote');
        this.setState({ status: 'saved', readOnly: message.readOnly, notice: refused ? this.state.notice : null, synced: true });
        // What this copy has beyond the server's (edits made offline).
        const missing = Y.encodeStateAsUpdate(this.doc, fromBase64(message.stateVector));
        if (!message.readOnly && missing.length > 2) {
          this.pending.push(missing);
          this.flush();
          this.setState({ status: 'unsaved' });
        } else {
          this.serverText = this.text.toString();
        }
        this.awareness.setLocalStateField('user', { id: this.user.id, name: this.user.name, color: colorFor(this.user.id) });
        // Cursors moved while not joined: send them now.
        if (this.awarenessDirty.size > 0) this.awarenessTimer ??= setTimeout(() => this.flushAwareness(), AWARENESS_EVERY_MS);
        if (unsent) void this.mergeUnsent(unsent, message.readOnly);
        break;
      }
      case 'doc.update':
        if (message.epoch === this.epoch) Y.applyUpdate(this.doc, fromBase64(message.update), 'remote');
        break;
      case 'doc.awareness':
        applyAwarenessUpdate(this.awareness, fromBase64(message.update), 'remote');
        break;
      case 'doc.saved':
        if (this.pending.length === 0 && !this.sendTimer) this.setState({ status: 'saved', savedAt: message.savedAt });
        else this.setState({ savedAt: message.savedAt });
        void this.trackSaved(message.sha256);
        break;
      case 'doc.status':
        this.setState({ readOnly: message.readOnly });
        // Edits not yet sent can no longer be: take the server's text back.
        if (message.readOnly && (this.pending.length > 0 || this.sendTimer)) {
          this.epoch = null;
          this.pending = [];
          this.discardLocal = true;
          this.join();
        }
        break;
      case 'doc.closed':
        this.closed = true;
        this.clearTimers();
        this.setState({
          status: 'closed',
          readOnly: true,
          notice: message.reason === 'access' ? 'You no longer have access to this note.'
            : message.reason === 'archived' ? 'This note was archived.' : 'This note was deleted.',
        });
        break;
      case 'doc.error':
        this.onError(message.code, message.message);
        break;
      default:
        break;
    }
  }

  private onError(code: string, text: string): void {
    switch (code) {
      case 'RATE_LIMITED':
        this.retryTimer ??= setTimeout(() => { this.retryTimer = null; this.join(); }, 1000);
        break;
      case 'TOO_LARGE':
      case 'FORBIDDEN':
      case 'ARCHIVED':
      case 'INVALID_UPDATE':
        // The server kept its text: take it back (what it refused is dropped).
        this.setState({ notice: text });
        this.epoch = null;
        this.pending = [];
        this.discardLocal = true;
        this.join();
        break;
      case 'NOT_FOUND':
        this.setState({ status: 'closed', readOnly: true, notice: text });
        break;
      default:
        // STALE_EPOCH (a doc.sync follows), NOT_JOINED (the server lost
        // this connection's join: rejoin, unless a join is in flight).
        if (code === 'NOT_JOINED' && this.joined) this.join();
        break;
    }
  }

  /** Merge what this copy had into the rebuilt document (through the server, which broadcasts the result). */
  private async mergeUnsent(unsent: { base: string; text: string }, readOnly: boolean): Promise<void> {
    if (readOnly) {
      this.setState({ notice: 'You can no longer edit this note; what you typed while disconnected was not saved.', unmerged: unsent.text });
      return;
    }
    this.setState({ status: 'unsaved' });
    try {
      const outcome = await this.merge(unsent.base, unsent.text);
      if (this.closed) return;
      if (outcome === 'conflict') {
        this.setState({
          status: 'saved',
          notice: 'Some of what you typed while disconnected clashes with changes made meanwhile and was not applied. Copy your version to redo it.',
          unmerged: unsent.text,
        });
      }
      // Merged: the server's doc.update brings the text here, doc.saved follows.
    } catch (err) {
      console.error('Merging the edits made while disconnected failed', err);
      if (this.closed) return;
      this.setState({
        status: 'saved',
        notice: `What you typed while disconnected could not be saved (${err instanceof Error ? err.message : String(err)}). Copy your version to redo it.`,
        unmerged: unsent.text,
      });
    }
  }

  /** A `doc.saved` of exactly this copy's text: the server holds it (the next merge's base). */
  private async trackSaved(sha256: string): Promise<void> {
    // Hashing needs a secure context; without one the base stays the last sync's.
    if (!globalThis.crypto?.subtle) return;
    const epoch = this.epoch;
    const text = this.text.toString();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex === sha256 && epoch === this.epoch && !this.closed) this.serverText = text;
  }

  /** Replace the document (a new epoch): the editor rebinds. */
  private reseed(): void {
    this.pending = [];
    this.awarenessDirty.clear();
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    this.awareness.destroy();
    this.doc.destroy();
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.wireDoc();
    for (const listener of this.resetListeners) listener();
  }

  private setState(patch: Partial<LiveNoteState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener(this.state);
  }

  private clearTimers(): void {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.sendTimer = null;
    this.awarenessTimer = null;
    this.retryTimer = null;
  }
}
