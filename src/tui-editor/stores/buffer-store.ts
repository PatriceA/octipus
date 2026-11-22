/**
 * Buffer store — the editor's working set.
 *
 * Each buffer pairs a file path with an in-memory text buffer + cursor +
 * selection, and the text it was last loaded from or saved as. The store
 * mediates "open file" (dedupe by path), "saved" (new baseline), Save As
 * (rebind to a path) and "close" (drop). The text buffer itself lives in
 * `editor/buffer.ts` so the store doesn't double as the data structure for
 * cursor / undo logic; reading and writing files is the bridge's
 * (`workspace-fs-bridge.ts`).
 *
 * `dirty` is a comparison, not a flag: the buffer's text differs from the
 * saved text. Undoing back to what was saved makes the buffer clean again.
 *
 * Path keys are absolute. Display labels strip the workspace root
 * for shorter tab labels.
 */
import { Buffer as TextBuffer } from '../editor/buffer';
import { detectIndent } from '../editor/indent';
import { detectLanguage, type Language } from '../editor/lang';
import type { DiskInfo } from '../workspace-fs-bridge';

export interface BufferRecord {
  id: string;            // stable id; `file:<absPath>` for buffers opened from a file
  path: string | null;   // absolute path; null for scratch buffers
  label: string;         // display name (basename or "Scratch <n>")
  language: Language;
  buffer: TextBuffer;
  /** The text as last read from or written to disk (`''` for a scratch buffer). */
  savedText: string;
  /** The file as last seen on disk; null for a scratch buffer or one not yet saved. */
  disk: DiskInfo | null;
  /** What the Tab key inserts: `'\t'` or the file's indent of spaces. */
  indent: string;
  /** True when the in-memory text differs from `savedText`. */
  dirty: boolean;
  /**
   * When the agent has taken a write lock on this buffer (the diff
   * overlay), the user's input is blocked until they accept /
   * reject the pending diff.
   */
  agentLocked: boolean;
  createdAt: number;
}

export type BufferListener = (state: BufferState) => void;

export interface BufferState {
  buffers: readonly BufferRecord[];
  activeId: string | null;
}

export interface OpenFileOptions {
  label?: string;
  disk?: DiskInfo | null;
}

export class BufferStore {
  private state: BufferState = { buffers: [], activeId: null };
  private listeners = new Set<BufferListener>();
  private scratchCounter = 1;

  get(): BufferState { return this.state; }

  subscribe(fn: BufferListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<BufferState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  private update(id: string, patch: (b: BufferRecord) => Partial<BufferRecord>): void {
    this.set({ buffers: this.state.buffers.map((b) => b.id === id ? withDirty({ ...b, ...patch(b) }) : b) });
  }

  /** Find by path (for the dedup behavior of `open`). */
  findByPath(absPath: string): BufferRecord | null {
    return this.state.buffers.find((b) => b.path === absPath) ?? null;
  }

  byId(id: string): BufferRecord | null {
    return this.state.buffers.find((b) => b.id === id) ?? null;
  }

  /**
   * Open or focus a file-backed buffer. `savedText` is the file's text as
   * the bridge read it; it is both the buffer's content and its baseline.
   *
   * Returns the buffer (existing if dedup fires, new otherwise).
   */
  openFile(absPath: string, savedText: string, options: OpenFileOptions = {}): BufferRecord {
    const existing = this.findByPath(absPath);
    if (existing) {
      this.set({ activeId: existing.id });
      return existing;
    }
    const rec = this.track({
      id: `file:${absPath}`,
      path: absPath,
      label: options.label ?? basename(absPath),
      language: detectLanguage(absPath),
      buffer: new TextBuffer(savedText),
      savedText,
      disk: options.disk ?? null,
      indent: detectIndent(savedText),
      dirty: false,
      agentLocked: false,
      createdAt: Date.now(),
    });
    this.set({ buffers: [...this.state.buffers, rec], activeId: rec.id });
    return rec;
  }

  /** Open an unbacked scratch buffer ("Scratch 1", "Scratch 2", …). */
  openScratch(language: Language = 'text'): BufferRecord {
    const n = this.scratchCounter++;
    const rec = this.track({
      id: `scratch:${n}`,
      path: null,
      label: `Scratch ${n}`,
      language,
      buffer: new TextBuffer(''),
      savedText: '',
      disk: null,
      indent: detectIndent(''),
      dirty: false,
      agentLocked: false,
      createdAt: Date.now(),
    });
    this.set({ buffers: [...this.state.buffers, rec], activeId: rec.id });
    return rec;
  }

  /** Every change to a buffer's text re-checks it against its saved text. */
  private track(rec: BufferRecord): BufferRecord {
    rec.buffer.onChange = () => this.update(rec.id, () => ({}));
    return rec;
  }

  /** Close a buffer by id. The next buffer in the list becomes active. */
  close(id: string): void {
    const idx = this.state.buffers.findIndex((b) => b.id === id);
    if (idx === -1) return;
    this.state.buffers[idx].buffer.onChange = null;
    const next = [...this.state.buffers.slice(0, idx), ...this.state.buffers.slice(idx + 1)];
    let active = this.state.activeId;
    if (active === id) {
      active = next[Math.min(idx, next.length - 1)]?.id ?? null;
    }
    this.set({ buffers: next, activeId: active });
  }

  setActive(id: string): void {
    if (this.state.buffers.some((b) => b.id === id)) {
      this.set({ activeId: id });
    }
  }

  active(): BufferRecord | null {
    return this.state.buffers.find((b) => b.id === this.state.activeId) ?? null;
  }

  /** The buffer's text is now what is on disk: after a save, a reload, or a check that found the disk had caught up. */
  markSaved(id: string, savedText: string, disk: DiskInfo | null): void {
    this.update(id, () => ({ savedText, disk }));
  }

  /** Give a buffer a (new) file: Save As. Its id stays the same. */
  rebind(id: string, absPath: string, savedText: string, disk: DiskInfo): void {
    this.update(id, () => ({ path: absPath, label: basename(absPath), language: detectLanguage(absPath), savedText, disk }));
  }

  /** Put the saved text back (Discard). One undo step. */
  revert(id: string): void {
    const rec = this.byId(id);
    if (rec && rec.dirty) rec.buffer.setText(rec.savedText);
  }

  /** Take or release the agent write lock for a buffer. */
  setAgentLocked(id: string, locked: boolean): void {
    this.update(id, () => ({ agentLocked: locked }));
  }

  /**
   * Cycle to the next / previous buffer (Ctrl+Tab / Ctrl+Shift+Tab).
   * No-op when ≤1 buffer is open.
   */
  cycle(direction: 1 | -1): void {
    if (this.state.buffers.length <= 1) return;
    const idx = this.state.buffers.findIndex((b) => b.id === this.state.activeId);
    const next = this.state.buffers[(idx + direction + this.state.buffers.length) % this.state.buffers.length];
    this.set({ activeId: next.id });
  }

  /**
   * Drop every buffer — used by the "close all" command + by tests
   * to reset between cases.
   */
  reset(): void {
    for (const b of this.state.buffers) b.buffer.onChange = null;
    this.set({ buffers: [], activeId: null });
    this.scratchCounter = 1;
  }
}

function withDirty(rec: BufferRecord): BufferRecord {
  rec.dirty = rec.buffer.text() !== rec.savedText;
  return rec;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? p : p.slice(i + 1);
}
