import { describe, expect, test } from 'vitest';
import { bodyPreview, noteTitleFrom } from './note-text';
import {
  anchorLine, anchorStates, changedAnchors, lineAt, newTodoAnchor, noteTaskLines, setAnchoredChecked, TODO_ANCHOR, TODO_TITLE_MAX,
  todoTitleFromLine,
} from './note-todos';

describe('noteTaskLines', () => {
  test('reads each task line with its box, text and anchor; fenced code is left out', () => {
    const body = 'Plan\n- [ ] Call Anna ^todo-abc12345\n  * [x] Buy milk\n```\n- [ ] not a task ^todo-zzzzzzzz\n```\n> 1. [ ] quoted';
    const lines = noteTaskLines(body);
    expect(lines.map((l) => [l.line, l.checked, l.text, l.anchor])).toEqual([
      [1, false, 'Call Anna', 'abc12345'],
      [2, true, 'Buy milk', null],
      [6, false, 'quoted', null],
    ]);
    expect(body[lines[0].box]).toBe(' ');
    expect(body.slice(lines[1].from, lines[1].to)).toBe('  * [x] Buy milk');
  });

  test('a marker only counts at the end of a task line', () => {
    expect(noteTaskLines('- [ ] see ^todo-abc12345 later')[0].anchor).toBeNull();
    expect(noteTaskLines('plain ^todo-abc12345')).toEqual([]);
  });
});

describe('changedAnchors', () => {
  test('only an anchor whose tick changed, present on both sides', () => {
    const before = '- [ ] a ^todo-aaaaaaaa\n- [ ] b ^todo-bbbbbbbb\n- [x] gone ^todo-cccccccc';
    const after = '- [x] a ^todo-aaaaaaaa\n- [ ] b ^todo-bbbbbbbb\n- [x] new ^todo-dddddddd\nsome text';
    expect(changedAnchors(before, after)).toEqual([{ anchor: 'aaaaaaaa', checked: true }]);
    expect(changedAnchors(after, after)).toEqual([]);
  });

  test('a duplicated line counts by its first copy', () => {
    expect(anchorStates('- [x] a ^todo-aaaaaaaa\n- [ ] a ^todo-aaaaaaaa').get('aaaaaaaa')).toBe(true);
  });
});

describe('setAnchoredChecked', () => {
  test('ticks every line with the anchor and leaves the rest', () => {
    const body = '- [ ] a ^todo-aaaaaaaa\n- [ ] b\n- [ ] a again ^todo-aaaaaaaa';
    expect(setAnchoredChecked(body, 'aaaaaaaa', true)).toBe('- [x] a ^todo-aaaaaaaa\n- [ ] b\n- [x] a again ^todo-aaaaaaaa');
  });

  test('null when nothing changes or the anchor is gone', () => {
    expect(setAnchoredChecked('- [x] a ^todo-aaaaaaaa', 'aaaaaaaa', true)).toBeNull();
    expect(setAnchoredChecked('- [ ] a', 'aaaaaaaa', true)).toBeNull();
  });
});

describe('anchorLine', () => {
  test('marks a task line at its end, keeping its tick', () => {
    expect(anchorLine('x\n- [x] Done thing  \ny', 1, 'abc12345')).toBe('x\n- [x] Done thing ^todo-abc12345\ny');
  });

  test('a list item or a plain line becomes an unticked task line', () => {
    expect(anchorLine('  - Buy milk', 0, 'abc12345')).toBe('  - [ ] Buy milk ^todo-abc12345');
    expect(anchorLine('1. First', 0, 'abc12345')).toBe('1. [ ] First ^todo-abc12345');
    expect(anchorLine('Call Anna', 0, 'abc12345')).toBe('- [ ] Call Anna ^todo-abc12345');
  });

  test('refuses an empty line, a heading, fenced code and a marked line', () => {
    expect(anchorLine('a\n\nb', 1, 'abc12345')).toBeNull();
    expect(anchorLine('# Title', 0, 'abc12345')).toBeNull();
    expect(anchorLine('```\ncode\n```', 1, 'abc12345')).toBeNull();
    expect(anchorLine('- [ ] a ^todo-aaaaaaaa', 0, 'abc12345')).toBeNull();
    expect(anchorLine('- ', 0, 'abc12345')).toBeNull();
    expect(() => anchorLine('a', 0, 'NOT OK')).toThrow();
  });
});

describe('todoTitleFromLine', () => {
  test('reads a line as plain text, without markers', () => {
    expect(todoTitleFromLine('- [ ] **Call** [[people/anna|Anna]] about [the bill](https://x.y) ^todo-abc12345')).toBe('Call Anna about the bill');
    expect(todoTitleFromLine('## Heading')).toBe('Heading');
    expect(todoTitleFromLine('x'.repeat(600))).toHaveLength(TODO_TITLE_MAX);
  });
});

describe('the marker stays out of what a note reads as', () => {
  test('titles and previews leave it out', () => {
    expect(noteTitleFrom('- [ ] Call Anna ^todo-abc12345')).toBe('Call Anna');
    expect(bodyPreview('Title\n- [ ] Call Anna ^todo-abc12345', 'Title')).toBe('Call Anna');
  });
});

test('newTodoAnchor makes valid, distinct anchors', () => {
  const a = newTodoAnchor();
  expect(a).toMatch(TODO_ANCHOR);
  expect(new Set(Array.from({ length: 50 }, newTodoAnchor)).size).toBe(50);
});

test('lineAt counts lines before an offset', () => {
  expect(lineAt('a\nb\nc', 0)).toBe(0);
  expect(lineAt('a\nb\nc', 2)).toBe(1);
  expect(lineAt('a\nb\nc', 4)).toBe(2);
});
