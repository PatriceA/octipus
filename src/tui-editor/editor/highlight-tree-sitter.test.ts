/**
 * Tree-sitter highlighter tests.
 *
 * Loads real grammar WASMs from `src/tui-editor/editor/grammars/`,
 * parses small snippets per language, and asserts the cache returns
 * non-trivial token kinds (keyword/string/comment/...). Falls back to
 * the regex highlighter on grammar / module load failure.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { highlight, resetHighlighter } from './highlight';
import {
  _resetTreeSitterForTests,
  hintLineIndex,
  installTreeSitterHighlighter,
  setSource,
} from './highlight-tree-sitter';

beforeAll(() => {
  installTreeSitterHighlighter();
});

afterAll(() => {
  resetHighlighter();
  _resetTreeSitterForTests();
});

function kinds(line: string, lang: Parameters<typeof highlight>[1], idx: number): Set<string> {
  hintLineIndex(idx);
  const out = highlight(line, lang);
  return new Set(out.map((t) => t.kind));
}

function assertHasOne(set: Set<string>, kinds: string[], line: string): void {
  const hit = kinds.some((k) => set.has(k));
  if (!hit) throw new Error(`expected one of [${kinds.join(',')}] in tokens for "${line}", got [${[...set].join(',')}]`);
}

describe('tree-sitter highlighter', () => {
  test('typescript: keywords + strings + comments', async () => {
    const src = [
      '// hello',
      'export const x: string = "hi";',
      'function add(a: number, b: number) { return a + b; }',
    ].join('\n');
    await setSource('typescript', src);

    const lines = src.split('\n');
    assertHasOne(kinds(lines[0], 'typescript', 0), ['comment'], lines[0]);
    assertHasOne(kinds(lines[1], 'typescript', 1), ['keyword'], lines[1]);
    assertHasOne(kinds(lines[1], 'typescript', 1), ['string'], lines[1]);
    assertHasOne(kinds(lines[2], 'typescript', 2), ['keyword'], lines[2]);
  });

  test('python: comments + keywords', async () => {
    const src = [
      '# top comment',
      'def add(a, b):',
      '    return a + b',
    ].join('\n');
    await setSource('python', src);

    const lines = src.split('\n');
    assertHasOne(kinds(lines[0], 'python', 0), ['comment'], lines[0]);
    assertHasOne(kinds(lines[1], 'python', 1), ['keyword'], lines[1]);
  });

  test('rust: line comment + fn keyword', async () => {
    const src = [
      '// rust',
      'fn main() { let x: i32 = 1; }',
    ].join('\n');
    await setSource('rust', src);

    expect(kinds(src.split('\n')[0], 'rust', 0).has('comment')).toBe(true);
    expect(kinds(src.split('\n')[1], 'rust', 1).has('keyword')).toBe(true);
  });

  test('go: package declaration', async () => {
    const src = [
      'package main',
      'func main() { return }',
    ].join('\n');
    await setSource('go', src);

    expect(kinds(src.split('\n')[0], 'go', 0).has('keyword')).toBe(true);
  });

  test('java: class + string literal', async () => {
    const src = [
      'public class Greet {',
      '  String hi = "world";',
      '}',
    ].join('\n');
    await setSource('java', src);

    const lines = src.split('\n');
    assertHasOne(kinds(lines[0], 'java', 0), ['keyword'], lines[0]);
    assertHasOne(kinds(lines[1], 'java', 1), ['string'], lines[1]);
  });

  test('falls back to regex highlighter for languages without a grammar', async () => {
    // markdown has no vendored grammar — the regex highlighter still runs.
    hintLineIndex(0);
    const out = highlight('# heading', 'markdown');
    expect(out.length).toBeGreaterThan(0);
  });

  test('cache is invalidated when source drifts from setSource', async () => {
    await setSource('typescript', 'const x = 1;');
    hintLineIndex(0);
    // Asking about a line the cache doesn't know → falls back, no throw.
    const out = highlight('const y = 2;', 'typescript');
    expect(out.length).toBeGreaterThan(0);
  });
});
