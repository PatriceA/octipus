/**
 * TUI editor — text-buffer tests.
 *
 * Locks down the cursor / selection / insert / delete / undo
 * semantics so the renderer can safely assume them.
 */
import { describe, expect, test } from 'vitest';
import { Buffer, positionEq, positionLte } from './buffer';

describe('construction', () => {
  test('empty input produces a single empty line', () => {
    const b = new Buffer('');
    expect(b.lineCount()).toBe(1);
    expect(b.getLine(0)).toBe('');
    expect(b.text()).toBe('');
  });

  test('multi-line input splits on newlines', () => {
    const b = new Buffer('a\nbb\nccc');
    expect(b.lineCount()).toBe(3);
    expect(b.getLine(0)).toBe('a');
    expect(b.getLine(2)).toBe('ccc');
  });

  test('cursor starts at (0, 0)', () => {
    expect(new Buffer('hello').getCursor()).toEqual({ line: 0, col: 0 });
  });
});

describe('cursor movement', () => {
  test('moveCursor clamps to line bounds', () => {
    const b = new Buffer('abc\ndef');
    b.setCursor({ line: 0, col: 2 });
    b.moveCursor(0, 5); // past EOL → wraps to next line start
    expect(b.getCursor()).toEqual({ line: 1, col: 0 });
  });

  test('moveCursor wraps backwards to previous EOL', () => {
    const b = new Buffer('abc\ndef');
    b.setCursor({ line: 1, col: 0 });
    b.moveCursor(0, -1);
    expect(b.getCursor()).toEqual({ line: 0, col: 3 });
  });

  test('moveLineEnd / moveLineStart', () => {
    const b = new Buffer('hello\nworld');
    b.setCursor({ line: 0, col: 2 });
    b.moveLineEnd();
    expect(b.getCursor()).toEqual({ line: 0, col: 5 });
    b.moveLineStart();
    expect(b.getCursor()).toEqual({ line: 0, col: 0 });
  });

  test('moveDocStart / moveDocEnd', () => {
    const b = new Buffer('a\nb\nc');
    b.moveDocEnd();
    expect(b.getCursor()).toEqual({ line: 2, col: 1 });
    b.moveDocStart();
    expect(b.getCursor()).toEqual({ line: 0, col: 0 });
  });

  test('moveWordRight / moveWordLeft', () => {
    const b = new Buffer('hello  world  foo');
    b.moveWordRight();
    expect(b.getCursor().col).toBeGreaterThan(0);
    expect(b.getCursor().col).toBeLessThanOrEqual(7); // past first word + spaces, before "world" or right at it
    b.moveWordLeft();
    expect(b.getCursor()).toEqual({ line: 0, col: 0 });
  });
});

describe('selection', () => {
  test('extending selection sets anchor + head', () => {
    const b = new Buffer('abcdef');
    b.setCursor({ line: 0, col: 2 });
    b.setCursor({ line: 0, col: 5 }, true);
    const sel = b.getSelection();
    expect(sel?.anchor).toEqual({ line: 0, col: 2 });
    expect(sel?.head).toEqual({ line: 0, col: 5 });
  });

  test('selectionRange normalizes order', () => {
    const b = new Buffer('abcdef');
    b.setCursor({ line: 0, col: 5 });
    b.setCursor({ line: 0, col: 2 }, true); // anchor 5, head 2
    const range = b.selectionRange();
    expect(range?.[0]).toEqual({ line: 0, col: 2 });
    expect(range?.[1]).toEqual({ line: 0, col: 5 });
  });

  test('plain setCursor clears selection', () => {
    const b = new Buffer('abcdef');
    b.setCursor({ line: 0, col: 0 });
    b.setCursor({ line: 0, col: 3 }, true);
    expect(b.getSelection()).not.toBeNull();
    b.setCursor({ line: 0, col: 5 });
    expect(b.getSelection()).toBeNull();
  });
});

describe('insert', () => {
  test('single-character insert at cursor', () => {
    const b = new Buffer('aXb');
    b.setCursor({ line: 0, col: 1 });
    b.insert('Y');
    expect(b.text()).toBe('aYXb');
    expect(b.getCursor()).toEqual({ line: 0, col: 2 });
  });

  test('multi-line insert splits the current line', () => {
    const b = new Buffer('foo bar');
    b.setCursor({ line: 0, col: 4 });
    b.insert('one\ntwo\n');
    expect(b.text()).toBe('foo one\ntwo\nbar');
    expect(b.getCursor()).toEqual({ line: 2, col: 0 });
  });

  test('insert replaces selection', () => {
    const b = new Buffer('abcdef');
    b.setCursor({ line: 0, col: 2 });
    b.setCursor({ line: 0, col: 4 }, true);
    b.insert('XY');
    expect(b.text()).toBe('abXYef');
  });
});

describe('delete', () => {
  test('deleteBackward removes char left of cursor', () => {
    const b = new Buffer('abc');
    b.setCursor({ line: 0, col: 2 });
    b.deleteBackward();
    expect(b.text()).toBe('ac');
    expect(b.getCursor()).toEqual({ line: 0, col: 1 });
  });

  test('deleteBackward at line start merges with previous line', () => {
    const b = new Buffer('aaa\nbbb');
    b.setCursor({ line: 1, col: 0 });
    b.deleteBackward();
    expect(b.text()).toBe('aaabbb');
    expect(b.getCursor()).toEqual({ line: 0, col: 3 });
  });

  test('deleteForward at line end merges next line', () => {
    const b = new Buffer('aaa\nbbb');
    b.setCursor({ line: 0, col: 3 });
    b.deleteForward();
    expect(b.text()).toBe('aaabbb');
  });

  test('deleteLine drops the current line', () => {
    const b = new Buffer('a\nb\nc');
    b.setCursor({ line: 1, col: 0 });
    b.deleteLine();
    expect(b.text()).toBe('a\nc');
    expect(b.getCursor()).toEqual({ line: 1, col: 0 });
  });

  test('deleteSelection drops the range and collapses cursor', () => {
    const b = new Buffer('aXXXXb');
    b.setCursor({ line: 0, col: 1 });
    b.setCursor({ line: 0, col: 5 }, true);
    b.deleteForward();
    expect(b.text()).toBe('ab');
  });
});

describe('replaceRange', () => {
  test('single-line replace', () => {
    const b = new Buffer('abcdef');
    b.replaceRange({ line: 0, col: 2 }, { line: 0, col: 4 }, 'XY');
    expect(b.text()).toBe('abXYef');
  });

  test('multi-line replace', () => {
    const b = new Buffer('aaa\nbbb\nccc');
    b.replaceRange({ line: 0, col: 1 }, { line: 2, col: 1 }, 'X\nY');
    expect(b.text()).toBe('aX\nYcc');
  });
});

describe('undo / redo', () => {
  test('undo reverts last edit; redo reapplies', () => {
    const b = new Buffer('abc');
    b.setCursor({ line: 0, col: 3 });
    b.insert('def');
    expect(b.text()).toBe('abcdef');
    b.undo();
    expect(b.text()).toBe('abc');
    b.redo();
    expect(b.text()).toBe('abcdef');
  });

  test('undo across multiple ops', () => {
    const b = new Buffer('');
    b.insert('a');
    b.insert('b');
    b.insert('c');
    expect(b.text()).toBe('abc');
    b.undo(); b.undo();
    expect(b.text()).toBe('a');
    b.redo();
    expect(b.text()).toBe('ab');
  });

  test('a fresh edit clears the redo stack', () => {
    const b = new Buffer('');
    b.insert('a');
    b.insert('b');
    b.undo();
    expect(b.text()).toBe('a');
    b.insert('c');
    expect(b.redo()).toBe(false);
    expect(b.text()).toBe('ac');
  });

  test('undo on empty stack is a safe no-op', () => {
    const b = new Buffer('hi');
    expect(b.undo()).toBe(false);
    expect(b.text()).toBe('hi');
  });
});

describe('helpers', () => {
  test('positionEq + positionLte', () => {
    expect(positionEq({ line: 1, col: 2 }, { line: 1, col: 2 })).toBe(true);
    expect(positionEq({ line: 1, col: 2 }, { line: 1, col: 3 })).toBe(false);
    expect(positionLte({ line: 1, col: 2 }, { line: 1, col: 5 })).toBe(true);
    expect(positionLte({ line: 2, col: 0 }, { line: 1, col: 99 })).toBe(false);
  });
});
