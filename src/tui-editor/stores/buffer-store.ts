/**
 * Buffer store — the editor's working set.
 *
 * Each buffer pairs a file path with an in-memory text buffer +
 * cursor + selection + dirty flag. The store mediates "open file"
 * (load from FS, dedupe by path), "save" (write through), and
 * "close" (drop). The text buffer itself lives in
 * `editor/buffer.ts` so the store doesn't double as the data
 * structure for cursor / undo logic.
 *
 * Path keys are absolute. Display labels strip the workspace root
 * for shorter tab labels.
 */
import { Buffer as TextBuffer } from '../editor/buffer';
import { detectLanguage, type Language } from '../editor/lang';

export interface BufferRecord {
  id: string;            // stable id; `file:<absPath>` for file-backed buffers
  path: string | null;   // absolute path; null for scratch buffers
  label: string;         // display name (basename or "Scratch <n>")
  language: Language;
  buffer: TextBuffer;
  /** True when the in-memory text differs from the last save. */
  dirty: boolean;
  /**
   * When the agent has taken a write lock on this buffer (Phase 4
   * diff overlay), the user's input is blocked until they accept /
   * reject the pending diff. Only meaningful when `lockMode` is
   * `'lock'`.
   */
  agentLocked: boolean;
  /**
   * How agent edits to this buffer are presented:
   *
   *   - `'lock'`  (default) — the diff overlay opens, the user
   *     accepts / rejects, the buffer is read-only meanwhile.
   *
   *   - `'merge'` — the agent's edit applies directly to the
   *     buffer's text. The change lands on the buffer's undo
   *     stack so Ctrl+Z rolls it back, and a one-line "merged
   *     edit from agent" notice shows in the chat for traceability.
   *     The user keeps typing alongside the agent without an
   *     interrupting overlay.
   *
   * Per-buffer setting so a user can have a "scratchpad" merge
   * buffer open while keeping their main code under the safer
   * `'lock'` discipline.
   */
  lockMode: 'lock' | 'merge';
  createdAt: number;
}

export type BufferListener = (state: BufferState) => void;

export interface BufferState {
  buffers: readonly BufferRecord[];
  activeId: string | null;
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

  /** Find by path (for the dedup behavior of `open`). */
  findByPath(absPath: string): BufferRecord | null {
    return this.state.buffers.find((b) => b.path === absPath) ?? null;
  }

  /**
   * Open or focus a file-backed buffer. Initial text is whatever
   * the caller supplies — the bridge `workspace-fs-bridge` reads
   * the file and hands it in, keeping this store's I/O surface
   * empty.
   *
   * Returns the buffer (existing if dedup fires, new otherwise).
   */
  openFile(absPath: string, initialText: string, label?: string): BufferRecord {
    const existing = this.findByPath(absPath);
    if (existing) {
      this.set({ activeId: existing.id });
      return existing;
    }
    const id = `file:${absPath}`;
    const language = detectLanguage(absPath);
    const buf = new TextBuffer(initialText);
    const rec: BufferRecord = {
      id,
      path: absPath,
      label: label ?? basename(absPath),
      language,
      buffer: buf,
      dirty: false,
      agentLocked: false,
      lockMode: 'lock',
      createdAt: Date.now(),
    };
    this.set({ buffers: [...this.state.buffers, rec], activeId: id });
    return rec;
  }

  /** Open an unbacked scratch buffer ("Scratch 1", "Scratch 2", …). */
  openScratch(language: Language = 'text'): BufferRecord {
    const n = this.scratchCounter++;
    const id = `scratch:${n}`;
    const rec: BufferRecord = {
      id,
      path: null,
      label: `Scratch ${n}`,
      language,
      buffer: new TextBuffer(''),
      dirty: false,
      agentLocked: false,
      lockMode: 'lock',
      createdAt: Date.now(),
    };
    this.set({ buffers: [...this.state.buffers, rec], activeId: id });
    return rec;
  }

  /** Close a buffer by id. The next buffer in the list becomes active. */
  close(id: string): void {
    const idx = this.state.buffers.findIndex((b) => b.id === id);
    if (idx === -1) return;
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

  /** Mark a buffer dirty / clean — called after edits and saves. */
  markDirty(id: string, dirty: boolean): void {
    const next = this.state.buffers.map((b) => b.id === id ? { ...b, dirty } : b);
    this.set({ buffers: next });
  }

  /** Take or release the agent write lock for a buffer. */
  setAgentLocked(id: string, locked: boolean): void {
    const next = this.state.buffers.map((b) => b.id === id ? { ...b, agentLocked: locked } : b);
    this.set({ buffers: next });
  }

  /** Switch a buffer between `'lock'` and `'merge'` agent-edit modes. */
  setLockMode(id: string, mode: 'lock' | 'merge'): void {
    const next = this.state.buffers.map((b) => b.id === id ? { ...b, lockMode: mode } : b);
    this.set({ buffers: next });
  }

  /**
   * Apply an agent-proposed edit to a buffer.
   *
   *   - `'lock'` mode: take the agent lock and return false. The
   *     caller (the chat → diff-overlay glue) is expected to open
   *     the diff overlay against `proposed`; the user accepts or
   *     rejects.
   *   - `'merge'` mode: replace the buffer's text in-place via the
   *     existing `setText` (which pushes onto the undo stack), mark
   *     the buffer dirty, and return true. No overlay needed.
   *
   * Returns whether the edit was applied directly. `false` means
   * the caller should open the overlay flow.
   */
  applyAgentEdit(id: string, proposed: string): boolean {
    const rec = this.state.buffers.find((b) => b.id === id);
    if (!rec) return false;
    if (rec.lockMode === 'merge') {
      rec.buffer.setText(proposed);
      this.markDirty(id, true);
      return true;
    }
    this.setAgentLocked(id, true);
    return false;
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
    this.set({ buffers: [], activeId: null });
    this.scratchCounter = 1;
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
