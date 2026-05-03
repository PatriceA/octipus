import { describe, expect, test } from 'bun:test';
import { Buffer } from './buffer';
import { findAll, replaceAll } from './search';

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

  test('invalid regex returns empty', () => {
    expect(findAll(new Buffer('hello'), '[unclosed', { regex: true })).toEqual([]);
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
});
