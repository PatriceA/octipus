/**
 * Highlighter tests. Locks the contract that `tokens.map(t =>
 * t.text)` reconstructs the original line.
 */
import { describe, expect, test } from 'vitest';
import { highlight, highlightLine, resetHighlighter, setHighlighter } from './highlight';

describe('highlightLine', () => {
  test('round-trip: tokens reconstruct the input', () => {
    const cases: Array<[string, string]> = [
      ['typescript', 'const x = 42; // hello'],
      ['typescript', 'function foo(a: number): string { return "hi"; }'],
      ['shell', 'if [ $? -eq 0 ]; then echo "ok"; fi'],
      ['python', 'def f(x): return x + 1  # comment'],
      ['json', '{"a": 1, "b": null}'],
      ['markdown', '## heading and `code` and **bold**'],
      ['text', 'plain text with no rules'],
    ];
    for (const [lang, line] of cases) {
      const tokens = highlightLine(line, lang as Parameters<typeof highlightLine>[1]);
      expect(tokens.map((t) => t.text).join('')).toBe(line);
    }
  });

  test('typescript keyword is tagged as keyword', () => {
    const tokens = highlightLine('const x = 1', 'typescript');
    expect(tokens.find((t) => t.text === 'const')?.kind).toBe('keyword');
  });

  test('shell line comment is tagged as comment', () => {
    const tokens = highlightLine('echo hi # bye', 'shell');
    expect(tokens.find((t) => t.text.startsWith('#'))?.kind).toBe('comment');
  });

  test('json string + number kinds', () => {
    const tokens = highlightLine('{"x": 42}', 'json');
    expect(tokens.find((t) => t.text === '"x"')?.kind).toBe('string');
    expect(tokens.find((t) => t.text === '42')?.kind).toBe('number');
  });

  test('text language returns single plain token', () => {
    const tokens = highlightLine('hello world', 'text');
    expect(tokens.length).toBe(1);
    expect(tokens[0].kind).toBe('plain');
  });
});

describe('pluggable highlighter', () => {
  test('default highlighter is the pattern-based one', () => {
    const a = highlight('const x = 1', 'typescript');
    const b = highlightLine('const x = 1', 'typescript');
    expect(a).toEqual(b);
  });

  test('setHighlighter swaps the implementation', () => {
    setHighlighter((line) => [{ text: line, kind: 'comment' }]);
    const t = highlight('const x = 1', 'typescript');
    expect(t).toEqual([{ text: 'const x = 1', kind: 'comment' }]);
    resetHighlighter();
    expect(highlight('const x = 1', 'typescript')[0].kind).toBe('keyword');
  });
});
