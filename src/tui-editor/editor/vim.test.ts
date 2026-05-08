/**
 * Vim handler tests.
 *
 * Covers the motion + edit + mode-switch contract documented at
 * the top of `vim.ts`. Pure handler — no React, no Ink.
 */
import { describe, expect, test } from 'bun:test';
import { Buffer } from './buffer';
import { newVimState, step, type VimKey } from './vim';

const k = (char: string, ctrl = false): VimKey => ({ char, ctrl });
const ESC: VimKey = { char: '', escape: true };

describe('vim — motions in NORMAL', () => {
  test('hjkl move cursor', () => {
    const b = new Buffer('abc\ndef\nghi');
    let s = newVimState();
    s = step(b, k('l'), s).state;
    expect(b.getCursor()).toEqual({ line: 0, col: 1 });
    s = step(b, k('j'), s).state;
    expect(b.getCursor()).toEqual({ line: 1, col: 1 });
    s = step(b, k('h'), s).state;
    expect(b.getCursor()).toEqual({ line: 1, col: 0 });
    s = step(b, k('k'), s).state;
    expect(b.getCursor()).toEqual({ line: 0, col: 0 });
  });

  test('w / b word motion', () => {
    const b = new Buffer('foo bar baz');
    let s = newVimState();
    s = step(b, k('w'), s).state;
    expect(b.getCursor().col).toBeGreaterThan(0);
    s = step(b, k('b'), s).state;
    expect(b.getCursor()).toEqual({ line: 0, col: 0 });
  });

  test('0 / $ line start / end', () => {
    const b = new Buffer('hello world');
    b.setCursor({ line: 0, col: 5 });
    let s = newVimState();
    s = step(b, k('$'), s).state;
    expect(b.getCursor()).toEqual({ line: 0, col: 11 });
    s = step(b, k('0'), s).state;
    expect(b.getCursor()).toEqual({ line: 0, col: 0 });
  });

  test('gg / G jump to doc start / end', () => {
    const b = new Buffer('a\nb\nc');
    b.setCursor({ line: 1, col: 0 });
    let s = newVimState();
    s = step(b, k('g'), s).state;
    s = step(b, k('g'), s).state;
    expect(b.getCursor()).toEqual({ line: 0, col: 0 });
    s = step(b, k('G'), s).state;
    expect(b.getCursor()).toEqual({ line: 2, col: 1 });
  });

  test('pending leader expires on a non-matching key', () => {
    const b = new Buffer('a\nb\nc');
    let s = newVimState();
    s = step(b, k('g'), s).state; // pending = 'g'
    s = step(b, k('l'), s).state; // not 'g' — should clear pending and move
    expect(s.pending).toBeNull();
  });
});

describe('vim — mode switches', () => {
  test('i → INSERT', () => {
    const b = new Buffer('abc');
    const r = step(b, k('i'), newVimState());
    expect(r.state.mode).toBe('INSERT');
    expect(r.consumed).toBe(true);
    expect(r.insert).toBe(true);
  });

  test('a → INSERT and moves cursor right', () => {
    const b = new Buffer('abc');
    b.setCursor({ line: 0, col: 1 });
    const r = step(b, k('a'), newVimState());
    expect(r.state.mode).toBe('INSERT');
    expect(b.getCursor()).toEqual({ line: 0, col: 2 });
  });

  test('o opens a new line below + INSERT', () => {
    const b = new Buffer('abc\ndef');
    const r = step(b, k('o'), newVimState());
    expect(r.state.mode).toBe('INSERT');
    expect(b.text()).toBe('abc\n\ndef');
  });

  test('Esc returns to NORMAL', () => {
    const b = new Buffer('a');
    let s = step(b, k('i'), newVimState()).state; // INSERT
    s = step(b, ESC, s).state;
    expect(s.mode).toBe('NORMAL');
  });

  test('INSERT mode does not consume keystrokes', () => {
    const b = new Buffer('a');
    let s = step(b, k('i'), newVimState()).state;
    const r = step(b, k('x'), s);
    expect(r.consumed).toBe(false); // caller types 'x' into the buffer
  });
});

describe('vim — edits', () => {
  test('x deletes char under cursor', () => {
    const b = new Buffer('hello');
    b.setCursor({ line: 0, col: 1 });
    step(b, k('x'), newVimState());
    expect(b.text()).toBe('hllo');
  });

  test('dd deletes the current line', () => {
    const b = new Buffer('a\nb\nc');
    b.setCursor({ line: 1, col: 0 });
    let s = newVimState();
    s = step(b, k('d'), s).state;
    s = step(b, k('d'), s).state;
    expect(b.text()).toBe('a\nc');
  });

  test('yy + p yank line + paste', () => {
    const b = new Buffer('hello');
    let s = newVimState();
    s = step(b, k('y'), s).state;
    s = step(b, k('y'), s).state;
    expect(s.register).toBe('hello\n');
    s = step(b, k('p'), s).state;
    expect(b.text()).toBe('hello\nhello'); // paste at cursor
  });

  test('u undoes', () => {
    const b = new Buffer('abc');
    b.insert('X');
    expect(b.text()).toBe('Xabc');
    step(b, k('u'), newVimState());
    expect(b.text()).toBe('abc');
  });

  test('Ctrl+R redoes', () => {
    const b = new Buffer('abc');
    b.insert('X');
    b.undo();
    step(b, k('r', true), newVimState());
    expect(b.text()).toBe('Xabc');
  });
});

describe('vim — named registers', () => {
  test('"ayy stores into register a; "ap pastes from a', () => {
    const b = new Buffer('hello\nworld');
    let s = newVimState();
    // "ayy on first line
    s = step(b, k('"'), s).state;
    s = step(b, k('a'), s).state;
    expect(s.activeRegister).toBe('a');
    s = step(b, k('y'), s).state;
    s = step(b, k('y'), s).state;
    expect(s.registers.a).toBe('hello\n');
    // activeRegister resets to default after yank
    expect(s.activeRegister).toBe('"');

    // Move down, "ap pastes
    b.setCursor({ line: 1, col: 0 });
    s = step(b, k('"'), s).state;
    s = step(b, k('a'), s).state;
    s = step(b, k('p'), s).state;
    expect(b.text()).toContain('hello');
  });

  test('default register is unaffected by writes to a named register', () => {
    const b = new Buffer('one\ntwo');
    let s = newVimState();
    // Default yy
    s = step(b, k('y'), s).state;
    s = step(b, k('y'), s).state;
    expect(s.register).toBe('one\n');
    // "byy on second line
    b.setCursor({ line: 1, col: 0 });
    s = step(b, k('"'), s).state;
    s = step(b, k('b'), s).state;
    s = step(b, k('y'), s).state;
    s = step(b, k('y'), s).state;
    expect(s.registers.b).toBe('two\n');
    // Default register unchanged
    expect(s.register).toBe('one\n');
  });
});

describe('vim — IME composition', () => {
  test('composing keys are consumed without firing leaders', () => {
    const b = new Buffer('a\nb\nc');
    let s = newVimState();
    // Composing 'g' should not start the gg leader
    const r = step(b, { char: 'g', composing: true }, s);
    expect(r.consumed).toBe(true);
    expect(r.state.pending).toBeNull();
    s = r.state;
    // Subsequent committed 'g' should start leader
    s = step(b, k('g'), s).state;
    expect(s.pending).toBe('g');
  });
});

describe('vim — VISUAL mode', () => {
  test('motion extends selection', () => {
    const b = new Buffer('hello');
    let s = step(b, k('v'), newVimState()).state;
    expect(s.mode).toBe('VISUAL');
    s = step(b, k('l'), s).state;
    s = step(b, k('l'), s).state;
    const sel = b.getSelection();
    expect(sel).not.toBeNull();
    expect(sel?.head).toEqual({ line: 0, col: 2 });
  });

  test('d in VISUAL deletes selection + returns to NORMAL', () => {
    const b = new Buffer('abcdef');
    let s = step(b, k('v'), newVimState()).state;
    s = step(b, k('l'), s).state;
    s = step(b, k('l'), s).state;
    s = step(b, k('d'), s).state;
    expect(s.mode).toBe('NORMAL');
    expect(b.text().length).toBeLessThan(6);
  });

  test('y in VISUAL yanks selection + returns to NORMAL', () => {
    const b = new Buffer('hello');
    let s = step(b, k('v'), newVimState()).state;
    s = step(b, k('l'), s).state;
    s = step(b, k('l'), s).state;
    s = step(b, k('y'), s).state;
    expect(s.mode).toBe('NORMAL');
    expect(s.register.length).toBeGreaterThan(0);
  });
});
