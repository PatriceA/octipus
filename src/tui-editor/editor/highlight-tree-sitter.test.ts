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
  dropSource,
  hasParse,
  hintLine,
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

function kinds(line: string, lang: Parameters<typeof highlight>[1], idx: number, key: string = lang): Set<string> {
  hintLine(key, idx);
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
    await setSource('typescript', 'typescript', src);

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
    await setSource('python', 'python', src);

    const lines = src.split('\n');
    assertHasOne(kinds(lines[0], 'python', 0), ['comment'], lines[0]);
    assertHasOne(kinds(lines[1], 'python', 1), ['keyword'], lines[1]);
  });

  test('rust: line comment + fn keyword', async () => {
    const src = [
      '// rust',
      'fn main() { let x: i32 = 1; }',
    ].join('\n');
    await setSource('rust', 'rust', src);

    expect(kinds(src.split('\n')[0], 'rust', 0).has('comment')).toBe(true);
    expect(kinds(src.split('\n')[1], 'rust', 1).has('keyword')).toBe(true);
  });

  test('go: package declaration', async () => {
    const src = [
      'package main',
      'func main() { return }',
    ].join('\n');
    await setSource('go', 'go', src);

    expect(kinds(src.split('\n')[0], 'go', 0).has('keyword')).toBe(true);
  });

  test('java: class + string literal', async () => {
    const src = [
      'public class Greet {',
      '  String hi = "world";',
      '}',
    ].join('\n');
    await setSource('java', 'java', src);

    const lines = src.split('\n');
    assertHasOne(kinds(lines[0], 'java', 0), ['keyword'], lines[0]);
    assertHasOne(kinds(lines[1], 'java', 1), ['string'], lines[1]);
  });

  test('falls back to regex highlighter for languages without a grammar', async () => {
    // markdown has no vendored grammar — the regex highlighter still runs.
    hintLine('markdown', 0);
    const out = highlight('# heading', 'markdown');
    expect(out.length).toBeGreaterThan(0);
  });

  test('cache is invalidated when source drifts from setSource', async () => {
    await setSource('typescript', 'typescript', 'const x = 1;');
    hintLine('typescript', 0);
    // Asking about a line the cache doesn't know → falls back, no throw.
    const out = highlight('const y = 2;', 'typescript');
    expect(out.length).toBeGreaterThan(0);
  });

  test('two buffers of the same language keep their own parse (docs/plans/tui-modernization.md §5.2)', async () => {
    await setSource('a.ts', 'typescript', '// only a comment');
    await setSource('b.ts', 'typescript', 'const s = "a string";');
    expect(hasParse('a.ts', '// only a comment')).toBe(true);
    expect(kinds('// only a comment', 'typescript', 0, 'a.ts').has('comment')).toBe(true);
    expect(kinds('const s = "a string";', 'typescript', 0, 'b.ts').has('string')).toBe(true);
    dropSource('a.ts'); dropSource('b.ts');
  });

  test('a re-parse after an edit picks up structure the edit created', async () => {
    // Line 1 alone is an identifier; once line 0 opens a block comment it is comment text.
    await setSource('edit.ts', 'typescript', 'let a;\nhello world');
    expect(kinds('hello world', 'typescript', 1, 'edit.ts').has('comment')).toBe(false);
    await setSource('edit.ts', 'typescript', '/* let a;\nhello world */');
    expect(kinds('hello world */', 'typescript', 1, 'edit.ts')).toEqual(new Set(['comment']));
    dropSource('edit.ts');
  });

  test('a parse that finishes after a newer one does not replace it', async () => {
    const older = setSource('race.ts', 'typescript', 'const older = 1;');
    const newer = setSource('race.ts', 'typescript', 'const newer = 2;');
    await Promise.all([older, newer]);
    expect(hasParse('race.ts', 'const newer = 2;')).toBe(true);
    dropSource('race.ts');
  });
});
