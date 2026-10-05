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
 *   database: the local document is discarded and re-seeded (`onReset`
 *   listeners rebind the editor), so a reconnect never duplicates text.
 *   With the same epoch, only what is missing travels both ways.
 * - **Batching.** Local edits are merged and sent at most every 50 ms, well
 *   under `spaces.docMaxUpdatesPerSecond`; cursor updates every 100 ms.
 * - **Refusals.** An update the server refused leaves this copy ahead of it:
 *   a size or permission refusal re-seeds from the server; a rate refusal
 *   resyncs after a second, sending what was refused again.
 * - **Saved.** `doc.saved` drives the "Saved" indicator.
 */
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { GatewayMessage } from '../../src/core/gateway/protocol';
import type { WebGateway } from './gateway';

export type LiveNoteStatus = 'connecting' | 'saved' | 'unsaved' | 'offline' | 'closed';

export interface LiveNoteState {
  status: LiveNoteStatus;
  readOnly: boolean;
  savedAt: string | null;
  /** Set when the server ended the session (access lost, archived, deleted) or refused an edit. */
  notice: string | null;
}

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
  private state: LiveNoteState = { status: 'connecting', readOnly: true, savedAt: null, notice: null };
  private closed = false;

  constructor(
    private readonly gateway: WebGateway,
    readonly noteId: string,
    private readonly user: { id: string; name: string },
  ) {
    this.wireDoc();
    this.unsubscribers.push(gateway.onMessage((m) => this.handle(m)));
    this.unsubscribers.push(gateway.onStatus((status) => {
      if (status === 'connected') this.join();
      else if (!this.closed) this.setState({ status: 'offline' });
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
    this.flush();
    this.gateway.send(this.epoch
      ? { type: 'doc.join', noteId: this.noteId, epoch: this.epoch, stateVector: toBase64(Y.encodeStateVector(this.doc)) }
      : { type: 'doc.join', noteId: this.noteId });
  }

  private flush(): void {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    if (this.pending.length === 0 || !this.epoch || this.state.readOnly) {
      if (this.state.readOnly) this.pending = [];
      return;
    }
    const update = Y.mergeUpdates(this.pending);
    // Not connected: keep it, the next join sends what the server lacks.
    if (this.gateway.send({ type: 'doc.update', noteId: this.noteId, epoch: this.epoch, update: toBase64(update) })) this.pending = [];
  }

  private flushAwareness(): void {
    this.awarenessTimer = null;
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
        if (message.epoch !== this.epoch) this.reseed();
        this.epoch = message.epoch;
        Y.applyUpdate(this.doc, fromBase64(message.state), 'remote');
        this.setState({ status: 'saved', readOnly: message.readOnly, notice: null });
        // What this copy has beyond the server's (edits made offline).
        const missing = Y.encodeStateAsUpdate(this.doc, fromBase64(message.stateVector));
        if (!message.readOnly && missing.length > 2) {
          this.pending.push(missing);
          this.flush();
          this.setState({ status: 'unsaved' });
        }
        this.awareness.setLocalStateField('user', { id: this.user.id, name: this.user.name, color: colorFor(this.user.id) });
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
        break;
      case 'doc.status':
        this.setState({ readOnly: message.readOnly });
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
        // The server kept its text: take it back.
        this.setState({ notice: text });
        this.epoch = null;
        this.pending = [];
        this.join();
        break;
      case 'NOT_FOUND':
        this.setState({ status: 'closed', readOnly: true, notice: text });
        break;
      default:
        // STALE_EPOCH (a doc.sync follows), NOT_JOINED (rejoin).
        if (code === 'NOT_JOINED') this.join();
        break;
    }
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
