/**
 * Vim-like motion + edit handler.
 *
 * Pure handler that takes a buffer + a key event + the current
 * vim-mode state, and returns the next state. The TextEditor
 * component routes input through here when `editorMode === 'vim'`.
 *
 * Coverage (intentionally a small "v0.1 vim" — enough to feel
 * familiar without claiming completeness):
 *
 *   Motions (NORMAL + VISUAL):
 *     h / j / k / l             — character / line motion
 *     w / b                     — word forward / backward
 *     0 / $                     — line start / end
 *     gg / G                    — document start / end
 *
 *   Mode switches:
 *     i                         — INSERT (cursor stays)
 *     a                         — INSERT (cursor moves right)
 *     o                         — open new line below + INSERT
 *     O                         — open new line above + INSERT
 *     v                         — VISUAL
 *     Esc                       — back to NORMAL
 *
 *   Edits (NORMAL):
 *     x                         — delete char under cursor
 *     dd                        — delete current line
 *     u                         — undo
 *     Ctrl+R                    — redo
 *     yy                        — yank line into register
 *     p                         — paste register after cursor
 *
 *   In INSERT mode every keystroke flows back to the existing
 *   modeless handler — no special vim INSERT semantics; this
 *   keeps the implementation minimal and the user's typing
 *   experience unchanged.
 *
 *   In VISUAL mode motions extend the selection. Esc returns to
 *   NORMAL; `d` / `x` / `y` operate on the selection and return.
 *
 * Multi-key sequences (`gg`, `dd`, `yy`) buffer the leader and
 * flush on the second key or on a 600ms timeout. The TextEditor
 * component holds the state instance.
 */
import type { Buffer } from './buffer';

export type VimMode = 'NORMAL' | 'INSERT' | 'VISUAL';

export interface VimState {
  mode: VimMode;
  /** Pending leader key for multi-key sequences (`g`, `d`, `y`). */
  pending: string | null;
  /** Last yanked text (single register, `"`). */
  register: string;
  /** Pending leader expiry — caller compares to `Date.now()`. */
  pendingUntil: number;
}

export const PENDING_TIMEOUT_MS = 600;

export function newVimState(): VimState {
  return { mode: 'NORMAL', pending: null, register: '', pendingUntil: 0 };
}

export interface VimKey {
  /** Plain printable character ('a', 'A', '$', '0'). Empty for special keys. */
  char: string;
  ctrl?: boolean;
  shift?: boolean;
  escape?: boolean;
  /**
   * Special "j/k/h/l only" — Ink fires arrow keys for those, but
   * vim purists also bind to the letter keys. We accept either; the
   * caller passes whichever one the UI library produced.
   */
}

export interface VimResult {
  state: VimState;
  /** Whether this key was consumed; if false, the caller routes it
   *  to the modeless handler (only happens in INSERT mode). */
  consumed: boolean;
  /** Set when the editor should switch to a different mode externally. */
  insert?: boolean;
}

/**
 * Run one keystroke through the vim handler.
 *
 * Returns the next state + whether the key was consumed. INSERT
 * mode lets every key fall through (consumed=false) so the
 * existing modeless handler types the character into the buffer.
 */
export function step(buf: Buffer, key: VimKey, state: VimState): VimResult {
  // Esc always returns to NORMAL and clears pending.
  if (key.escape) {
    if (state.mode !== 'NORMAL') {
      buf.clearSelection();
    }
    return { state: { ...state, mode: 'NORMAL', pending: null }, consumed: true };
  }

  // INSERT lets the caller handle text entry.
  if (state.mode === 'INSERT') {
    return { state, consumed: false };
  }

  const now = Date.now();
  const pending = state.pendingUntil > now ? state.pending : null;

  // Multi-key sequences first. `gg` / `dd` / `yy`.
  if (pending === 'g' && key.char === 'g') {
    buf.moveDocStart(state.mode === 'VISUAL');
    return { state: { ...state, pending: null }, consumed: true };
  }
  if (pending === 'd' && key.char === 'd') {
    state = { ...state, register: buf.getLine(buf.getCursor().line) + '\n' };
    buf.deleteLine();
    return { state: { ...state, pending: null }, consumed: true };
  }
  if (pending === 'y' && key.char === 'y') {
    return { state: { ...state, pending: null, register: buf.getLine(buf.getCursor().line) + '\n' }, consumed: true };
  }
  // Cancel pending if a non-matching key arrives.
  if (pending) {
    state = { ...state, pending: null };
  }

  const c = key.char;
  const extend = state.mode === 'VISUAL';

  // Motions
  if (c === 'h') { buf.moveCursor(0, -1, extend); return { state, consumed: true }; }
  if (c === 'l') { buf.moveCursor(0, 1, extend); return { state, consumed: true }; }
  if (c === 'j') { buf.moveCursor(1, 0, extend); return { state, consumed: true }; }
  if (c === 'k') { buf.moveCursor(-1, 0, extend); return { state, consumed: true }; }
  if (c === 'w') { buf.moveWordRight(extend); return { state, consumed: true }; }
  if (c === 'b') { buf.moveWordLeft(extend); return { state, consumed: true }; }
  if (c === '0') { buf.moveLineStart(extend); return { state, consumed: true }; }
  if (c === '$') { buf.moveLineEnd(extend); return { state, consumed: true }; }
  if (c === 'G') { buf.moveDocEnd(extend); return { state, consumed: true }; }

  // VISUAL operations — handled BEFORE multi-key leaders so `d` /
  // `y` delete / yank the selection rather than starting a dd / yy
  // leader sequence.
  if (state.mode === 'VISUAL') {
    if (c === 'd' || c === 'x') {
      const range = buf.selectionRange();
      if (range) {
        const [a, b] = range;
        const lines = buf.getLines();
        const text = lines.slice(a.line, b.line + 1).map((line, i) => {
          const start = i === 0 ? a.col : 0;
          const end = i === b.line - a.line ? b.col : line.length;
          return line.slice(start, end);
        }).join('\n');
        state = { ...state, register: text };
      }
      buf.deleteForward();
      return { state: { ...state, mode: 'NORMAL' }, consumed: true };
    }
    if (c === 'y') {
      const range = buf.selectionRange();
      if (range) {
        const [a, b] = range;
        const lines = buf.getLines();
        const text = lines.slice(a.line, b.line + 1).map((line, i) => {
          const start = i === 0 ? a.col : 0;
          const end = i === b.line - a.line ? b.col : line.length;
          return line.slice(start, end);
        }).join('\n');
        state = { ...state, register: text };
      }
      buf.clearSelection();
      return { state: { ...state, mode: 'NORMAL' }, consumed: true };
    }
  }

  // Multi-key leaders (NORMAL only).
  if (state.mode === 'NORMAL' && (c === 'g' || c === 'd' || c === 'y')) {
    return { state: { ...state, pending: c, pendingUntil: now + PENDING_TIMEOUT_MS }, consumed: true };
  }

  // Mode switches.
  if (state.mode === 'NORMAL') {
    if (c === 'i') return { state: { ...state, mode: 'INSERT' }, consumed: true, insert: true };
    if (c === 'a') {
      buf.moveCursor(0, 1);
      return { state: { ...state, mode: 'INSERT' }, consumed: true, insert: true };
    }
    if (c === 'o') {
      buf.moveLineEnd();
      buf.insert('\n');
      return { state: { ...state, mode: 'INSERT' }, consumed: true, insert: true };
    }
    if (c === 'O') {
      buf.moveLineStart();
      buf.insert('\n');
      buf.moveCursor(-1, 0);
      return { state: { ...state, mode: 'INSERT' }, consumed: true, insert: true };
    }
    if (c === 'v') return { state: { ...state, mode: 'VISUAL' }, consumed: true };

    // Edits
    if (c === 'x') { buf.deleteForward(); return { state, consumed: true }; }
    if (c === 'u') { buf.undo(); return { state, consumed: true }; }
    if (key.ctrl && c === 'r') { buf.redo(); return { state, consumed: true }; }
    if (c === 'p') { buf.insert(state.register); return { state, consumed: true }; }
  }

  // Unknown — consumed=true so we don't accidentally type characters in NORMAL.
  return { state, consumed: true };
}
