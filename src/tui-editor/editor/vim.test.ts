/**
 * Vim handler tests.
 *
 * Covers the motion + edit + mode-switch contract documented at
 * the top of `vim.ts`. Pure handler — no React, no Ink.
 */
import { describe, expect, test } from 'vitest';
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
    expect(b.getCursor()).toEqual({ line: 0, col: 10 }); // on the last character
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
    expect(b.getCursor()).toEqual({ line: 2, col: 0 }); // on the last line's character, not after it
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
    expect(b.text()).toBe('hello\nhello'); // put below the line
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

// Review findings: yyp put the line at the cursor, $ stood past the last character so $a appended on the next
// line, x at the end of a line joined it with the next, and VISUAL left out the character under the cursor.
describe('vim — text it must get right', () => {
  test('yyp puts the yanked line below the current one, whatever the column', () => {
    const b = new Buffer('first\nsecond');
    b.setCursor({ line: 0, col: 2 });
    let s = newVimState();
    for (const c of 'yyp') s = step(b, k(c), s).state;
    expect(b.text()).toBe('first\nfirst\nsecond');
    expect(b.getCursor()).toEqual({ line: 1, col: 0 });
    b.setCursor({ line: 2, col: 3 });
    for (const c of 'ddp') s = step(b, k(c), s).state;
    expect(b.text()).toBe('first\nfirst\nsecond');
  });

  test('a character-wise register is put after the cursor', () => {
    const b = new Buffer('abc');
    let s = newVimState();
    for (const c of 'vly') s = step(b, k(c), s).state;
    expect(s.register).toBe('ab');
    s = step(b, k('p'), s).state;
    expect(b.text()).toBe('aabbc');
  });

  test('$ stands on the last character, so $a appends on the same line', () => {
    const b = new Buffer('hello\nnext');
    let s = newVimState();
    s = step(b, k('$'), s).state;
    expect(b.getCursor()).toEqual({ line: 0, col: 4 });
    s = step(b, k('a'), s).state;
    expect(b.getCursor()).toEqual({ line: 0, col: 5 });
    b.type('!');
    expect(b.text()).toBe('hello!\nnext');
    s = step(b, ESC, s).state;
    expect(b.getCursor()).toEqual({ line: 0, col: 5 }); // Esc steps back onto the last character
    s = step(b, k('l'), s).state;
    expect(b.getCursor()).toEqual({ line: 0, col: 5 }); // l does not leave the line
    s = step(b, k('j'), s).state;
    expect(b.getCursor()).toEqual({ line: 1, col: 3 });
  });

  test('the NORMAL cursor clamps to the last grapheme, a wide one included', () => {
    const b = new Buffer('ab👍🏽');
    step(b, k('$'), newVimState());
    expect(b.getCursor()).toEqual({ line: 0, col: 2 });
  });

  test('x at or after the end of a line does nothing; it never joins lines', () => {
    const b = new Buffer('\nkeep');
    step(b, k('x'), newVimState());
    expect(b.text()).toBe('\nkeep');
    const c = new Buffer('ab\ncd');
    let s = newVimState();
    for (const key of '$xxx') s = step(c, k(key), s).state;
    expect(c.text()).toBe('\ncd');
  });

  test('VISUAL is inclusive: v d deletes the character under the cursor, vlld three, and y yanks what d would delete', () => {
    const b = new Buffer('abcdef');
    let s = newVimState();
    for (const c of 'vd') s = step(b, k(c), s).state;
    expect(b.text()).toBe('bcdef');
    expect(s.register).toBe('a');
    for (const c of 'vlld') s = step(b, k(c), s).state;
    expect(b.text()).toBe('ef');
    expect(s.register).toBe('bcd');
    const y = new Buffer('one two');
    let t = newVimState();
    y.setCursor({ line: 0, col: 4 });
    for (const c of 'v$y') t = step(y, k(c), t).state;
    expect(t.register).toBe('two');
    expect(y.text()).toBe('one two');
    expect(y.getCursor()).toEqual({ line: 0, col: 4 });
    // Backwards: the anchor's character is in too.
    const back = new Buffer('abcdef');
    back.setCursor({ line: 0, col: 3 });
    let u = newVimState();
    for (const c of 'vhhd') u = step(back, k(c), u).state;
    expect(back.text()).toBe('aef');
    expect(u.register).toBe('bcd');
  });
});
