import { describe, expect, test } from 'vitest';
import { Buffer } from './buffer';
import { findAll, InvalidPatternError, replaceAll } from './search';

describe('findAll', () => {
  test('substring case-insensitive default', () => {
    const b = new Buffer('Hello hello\nHELLO');
    const m = findAll(b, 'hello');
    expect(m.length).toBe(3);
  });

  test('case-sensitive narrows', () => {
    const b = new Buffer('Hello hello');
    expect(findAll(b, 'hello', { caseSensitive: true }).length).toBe(1);
  });

  test('whole-word skips substring matches', () => {
    const b = new Buffer('hello helloworld helloX');
    expect(findAll(b, 'hello', { wholeWord: true }).length).toBe(1);
  });

  test('regex mode', () => {
    const b = new Buffer('a1 b22 c333');
    expect(findAll(b, '\\d+', { regex: true }).length).toBe(3);
  });

  test('returns positions across multiple lines', () => {
    const b = new Buffer('foo\nfoo\nfoo');
    const m = findAll(b, 'foo');
    expect(m.map((x) => x.line)).toEqual([0, 1, 2]);
  });

  test('empty query returns no matches', () => {
    expect(findAll(new Buffer('hello'), '').length).toBe(0);
  });

  test('an invalid regex is reported, not taken for "no matches"', () => {
    expect(() => findAll(new Buffer('hello'), '[unclosed', { regex: true })).toThrow(InvalidPatternError);
  });

  test('case-insensitive columns are columns of the line, even where lower-casing changes its length', () => {
    const b = new Buffer('İİ foo');
    expect(findAll(b, 'FOO')).toEqual([{ line: 0, col: 3, length: 3 }]);
  });

  test('a plain query matches regex metacharacters literally', () => {
    expect(findAll(new Buffer('a.b axb'), 'a.b').length).toBe(1);
  });
});

describe('replaceAll', () => {
  test('in-place replacement preserves text shape', () => {
    const b = new Buffer('foo bar foo');
    const n = replaceAll(b, 'foo', 'BAZ');
    expect(n).toBe(2);
    expect(b.text()).toBe('BAZ bar BAZ');
  });

  test('replacement on multiple lines', () => {
    const b = new Buffer('foo\nfoo\nfoo');
    replaceAll(b, 'foo', 'X');
    expect(b.text()).toBe('X\nX\nX');
  });

  test('replace-all is one undo step, even with more matches than the undo limit', () => {
    const b = new Buffer('a\n'.repeat(300));
    expect(replaceAll(b, 'a', 'b')).toBe(300);
    expect(b.undo()).toBe(true);
    expect(b.text()).toBe('a\n'.repeat(300));
    expect(b.undo()).toBe(false);
  });

  test('regex replace expands capture groups', () => {
    const b = new Buffer('let x = 1;\nlet yy = 22;');
    replaceAll(b, '(\\w+) = (\\d+)', '$2 = $1', { regex: true });
    expect(b.text()).toBe('let 1 = x;\nlet 22 = yy;');
  });

  test('regex replace sees the match in its context (lookbehind, named groups)', () => {
    const b = new Buffer('$5 and 5');
    replaceAll(b, '(?<=\\$)(?<n>\\d)', '[$<n>]', { regex: true });
    expect(b.text()).toBe('$[5] and 5');
  });

  test('a plain replacement is literal', () => {
    const b = new Buffer('cost');
    replaceAll(b, 'cost', '$1 $&');
    expect(b.text()).toBe('$1 $&');
  });
});
