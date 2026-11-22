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
 *   Commands (NORMAL, `:` then Enter; Esc cancels):
 *     :w                        — save
 *     :q / :q!                  — close the buffer (with / without the unsaved prompt)
 *     :wq / :x                  — save, then close
 *     :qa / :qa!                — quit the editor
 *   The handler only parses them; the caller carries them out
 *   (`VimResult.command`).
 *
 *   In INSERT mode every keystroke flows back to the existing
 *   modeless handler — no special vim INSERT semantics; this
 *   keeps the implementation minimal and the user's typing
 *   experience unchanged.
 *
 *   In VISUAL mode motions extend the selection. Esc returns to
 *   NORMAL; `d` / `x` / `y` operate on the selection and return.
 *   As in vim the selection is inclusive: the characters under the
 *   anchor and under the cursor are both in it.
 *
 *   Outside INSERT the cursor stands on a character, never after
 *   the last one: it is clamped to the line's last grapheme (so `$a`
 *   appends on the same line), `h` / `l` stay on the line, Esc from
 *   INSERT steps back one, and `x` on an empty line does nothing.
 *   A register that ends with a newline (`yy`, `dd`) is line-wise:
 *   `p` puts it below the current line; any other is put after the
 *   cursor.
 *
 * Multi-key sequences (`gg`, `dd`, `yy`) buffer the leader and
 * flush on the second key or on a 600ms timeout. The TextEditor
 * component holds the state instance.
 */
import type { Buffer, Position } from './buffer';
import { nextBoundary, prevBoundary } from './columns';

export type VimMode = 'NORMAL' | 'INSERT' | 'VISUAL';

export interface VimState {
  mode: VimMode;
  /** Pending leader key for multi-key sequences (`g`, `d`, `y`, `"`). */
  pending: string | null;
  /**
   * Named registers. The default register is `"`; other names follow
   * vim convention (`"a`-`"z`, `"+` for the system clipboard).
   */
  registers: Record<string, string>;
  /**
   * Register that the next y/d/p operation reads from / writes to.
   * Set by typing `"x` in NORMAL mode; resets to `"` after the
   * operation completes.
   */
  activeRegister: string;
  /**
   * Backwards-compat mirror of `registers['"']`. Older callers still
   * read `state.register`; updates flow through this field too.
   */
  register: string;
  /** Pending leader expiry — caller compares to `Date.now()`. */
  pendingUntil: number;
  /** The `:` command being typed, without the colon; null when none. Shown in the mode bar. */
  commandLine: string | null;
}

export type VimCommand = 'write' | 'quit' | 'quit!' | 'write-quit' | 'quit-all' | 'quit-all!';

const COMMANDS: Record<string, VimCommand> = {
  w: 'write', write: 'write',
  q: 'quit', quit: 'quit', 'q!': 'quit!', 'quit!': 'quit!',
  wq: 'write-quit', x: 'write-quit', xit: 'write-quit',
  qa: 'quit-all', qall: 'quit-all', 'qa!': 'quit-all!', 'qall!': 'quit-all!',
};

export const PENDING_TIMEOUT_MS = 600;

const DEFAULT_REGISTER = '"';

export function newVimState(): VimState {
  return {
    mode: 'NORMAL',
    pending: null,
    registers: {},
    activeRegister: DEFAULT_REGISTER,
    register: '',
    pendingUntil: 0,
    commandLine: null,
  };
}

function writeRegister(state: VimState, value: string): VimState {
  const name = state.activeRegister;
  const registers = { ...state.registers, [name]: value };
  return {
    ...state,
    registers,
    register: name === DEFAULT_REGISTER ? value : (registers[DEFAULT_REGISTER] ?? state.register),
    activeRegister: DEFAULT_REGISTER,
  };
}

function readRegister(state: VimState): string {
  return state.registers[state.activeRegister] ?? (state.activeRegister === DEFAULT_REGISTER ? state.register : '');
}

export interface VimKey {
  /** Plain printable character ('a', 'A', '$', '0'). Empty for special keys. */
  char: string;
  ctrl?: boolean;
  shift?: boolean;
  escape?: boolean;
  enter?: boolean;
  backspace?: boolean;
  /**
   * True while an IME composition is in progress. Suppresses vim
   * leader matching so a multi-byte CJK / dead-key sequence doesn't
   * accidentally trigger `gg`, `dd`, `yy`, or a register prefix.
   */
  composing?: boolean;
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
  /** A `:` command the caller should carry out. */
  command?: VimCommand;
  /** A `:` command that is not one of the above. */
  unknownCommand?: string;
}

/**
 * Run one keystroke through the vim handler.
 *
 * Returns the next state + whether the key was consumed. INSERT
 * mode lets every key fall through (consumed=false) so the
 * existing modeless handler types the character into the buffer.
 */
export function step(buf: Buffer, key: VimKey, state: VimState): VimResult {
  const wasInsert = state.mode === 'INSERT';
  const result = stepKey(buf, key, state);
  if (result.state.mode !== 'INSERT') {
    // Esc from INSERT steps back onto the character typed last, as in vim.
    if (wasInsert && key.escape) {
      const c = buf.getCursor();
      if (c.col > 0) buf.setCursor({ line: c.line, col: prevBoundary(buf.getLine(c.line), c.col) });
    }
    clampToCharacter(buf, result.state.mode === 'VISUAL');
  }
  return result;
}

/** Outside INSERT the cursor stands on the line's last grapheme at most, not after it. */
function clampToCharacter(buf: Buffer, visual: boolean): void {
  const c = buf.getCursor();
  const line = buf.getLine(c.line);
  if (line.length === 0 || c.col < line.length) return;
  const to = { line: c.line, col: prevBoundary(line, line.length) };
  const selection = buf.getSelection();
  if (visual && selection) buf.select(selection.anchor, to);
  else buf.setCursor(to);
}

/** The VISUAL selection with the character under its far end included: [start, end). */
function inclusiveRange(buf: Buffer): [Position, Position] {
  const cursor = buf.getCursor();
  const [a, b] = buf.selectionRange() ?? [cursor, cursor];
  const line = buf.getLine(b.line);
  if (b.col < line.length) return [a, { line: b.line, col: nextBoundary(line, b.col) }];
  // On an empty line (or its end) the line break is what is under the cursor.
  return b.line + 1 < buf.lineCount() ? [a, { line: b.line + 1, col: 0 }] : [a, b];
}

function stepKey(buf: Buffer, key: VimKey, state: VimState): VimResult {
  if (state.commandLine !== null) return commandLineStep(key, state);

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

  // While an IME composition is active, swallow keys without matching
  // any vim leader/motion so a multi-byte CJK sequence doesn't fire
  // `gg`/`dd`/`yy` mid-compose. The composed character will arrive as
  // a normal printable once the IME commits.
  if (key.composing) {
    return { state, consumed: true };
  }

  const now = Date.now();
  const pending = state.pendingUntil > now ? state.pending : null;

  // Register prefix: `"x` selects the register for the next y/d/p.
  if (pending === '"' && key.char) {
    return {
      state: { ...state, pending: null, activeRegister: key.char },
      consumed: true,
    };
  }

  // Multi-key sequences. `gg` / `dd` / `yy`.
  if (pending === 'g' && key.char === 'g') {
    buf.moveDocStart(state.mode === 'VISUAL');
    return { state: { ...state, pending: null }, consumed: true };
  }
  if (pending === 'd' && key.char === 'd') {
    state = writeRegister(state, buf.getLine(buf.getCursor().line) + '\n');
    buf.deleteLine();
    return { state: { ...state, pending: null }, consumed: true };
  }
  if (pending === 'y' && key.char === 'y') {
    state = writeRegister(state, buf.getLine(buf.getCursor().line) + '\n');
    return { state: { ...state, pending: null }, consumed: true };
  }
  // Cancel pending if a non-matching key arrives.
  if (pending) {
    state = { ...state, pending: null };
  }

  const c = key.char;
  const extend = state.mode === 'VISUAL';

  // Motions
  // h and l stay on the line.
  if (c === 'h') { if (buf.getCursor().col > 0) buf.moveCursor(0, -1, extend); return { state, consumed: true }; }
  if (c === 'l') {
    const at = buf.getCursor();
    const line = buf.getLine(at.line);
    if (nextBoundary(line, at.col) < line.length) buf.moveCursor(0, 1, extend);
    return { state, consumed: true };
  }
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
    if (c === 'd' || c === 'x' || c === 'y') {
      const [a, b] = inclusiveRange(buf);
      state = writeRegister(state, buf.textInRange(a, b));
      if (c === 'y') buf.setCursor(a);
      else { buf.replaceRange(a, b, ''); buf.setCursor(a); }
      return { state: { ...state, mode: 'NORMAL' }, consumed: true };
    }
  }

  if (state.mode === 'NORMAL' && c === ':') {
    return { state: { ...state, commandLine: '' }, consumed: true };
  }

  // Multi-key leaders (NORMAL only). `"` opens register selection;
  // `g` / `d` / `y` open their respective two-char sequences.
  if (state.mode === 'NORMAL' && (c === 'g' || c === 'd' || c === 'y' || c === '"')) {
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
    // x deletes the character under the cursor; past the end of a line there is none (it never joins lines).
    if (c === 'x') {
      const at = buf.getCursor();
      if (at.col < buf.getLine(at.line).length) buf.deleteForward();
      return { state, consumed: true };
    }
    if (c === 'u') { buf.undo(); return { state, consumed: true }; }
    if (key.ctrl && c === 'r') { buf.redo(); return { state, consumed: true }; }
    if (c === 'p') {
      const value = readRegister(state);
      if (value.endsWith('\n')) {
        // Line-wise: below the current line, the cursor at the start of the first line put.
        const line = buf.getCursor().line;
        buf.transact(() => {
          buf.setCursor({ line, col: buf.getLine(line).length });
          buf.insert(`\n${value.slice(0, -1)}`);
        });
        buf.setCursor({ line: line + 1, col: 0 });
      } else if (value) {
        const at = buf.getCursor();
        const text = buf.getLine(at.line);
        buf.setCursor({ line: at.line, col: at.col < text.length ? nextBoundary(text, at.col) : at.col });
        buf.insert(value);
        // On the last character put.
        const end = buf.getCursor();
        buf.setCursor({ line: end.line, col: prevBoundary(buf.getLine(end.line), end.col) });
      }
      return { state: { ...state, activeRegister: DEFAULT_REGISTER }, consumed: true };
    }
  }

  // Unknown — consumed=true so we don't accidentally type characters in NORMAL.
  return { state, consumed: true };
}

/** A key while the `:` command line is open. */
function commandLineStep(key: VimKey, state: VimState): VimResult {
  const line = state.commandLine ?? '';
  if (key.escape) return { state: { ...state, commandLine: null }, consumed: true };
  if (key.backspace) {
    // Backspace on an empty command line closes it, as in vim.
    return { state: { ...state, commandLine: line.length === 0 ? null : line.slice(0, -1) }, consumed: true };
  }
  if (key.enter) {
    const name = line.trim();
    const closed = { ...state, commandLine: null };
    if (!name) return { state: closed, consumed: true };
    const command = COMMANDS[name];
    return command ? { state: closed, consumed: true, command } : { state: closed, consumed: true, unknownCommand: name };
  }
  if (key.char && !key.ctrl) return { state: { ...state, commandLine: line + key.char }, consumed: true };
  return { state, consumed: true };
}
