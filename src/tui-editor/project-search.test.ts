import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MAX_HITS, type ProjectHit, parseRipgrepLine, searchProject, type SearchProjectOptions } from './project-search';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-search-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'const greeting = "hello";\nexport const Greeting = 1;\n');
  writeFileSync(join(root, 'src', 'b.txt'), 'say 😀 greeting\r\nno match here\r\n');
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'greeting in a dependency');
  writeFileSync(join(root, 'binary.bin'), globalThis.Buffer.from([0x67, 0x72, 0x65, 0x65, 0x74, 0x0, 0x69, 0x6e, 0x67]));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function run(query: string, options: SearchProjectOptions): Promise<{ hits: ProjectHit[]; done: Awaited<ReturnType<typeof searchProject>['done']> }> {
  const hits: ProjectHit[] = [];
  const search = searchProject(root, query, options, (batch) => hits.push(...batch));
  const done = await search.done;
  hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { hits, done };
}

const hasRg = (() => { try { execFileSync('rg', ['--version']); return true; } catch { return false; } })();

for (const [name, rg] of [['the fallback walk', null], ['ripgrep', 'rg']] as const) {
  describe.skipIf(rg !== null && !hasRg)(`project search with ${name}`, () => {
    test('finds every match with its line and UTF-16 column, skipping node_modules and binary files', async () => {
      const { hits, done } = await run('greeting', { rg });
      expect(done).toMatchObject({ source: rg ? 'rg' : 'walk', truncated: false });
      expect(hits.map((h) => [h.path.slice(root.length + 1), h.line, h.col, h.length])).toEqual([
        ['src/a.ts', 0, 6, 8],
        ['src/a.ts', 1, 13, 8],
        ['src/b.txt', 0, 7, 8], // after an emoji: two UTF-16 units, four UTF-8 bytes
      ]);
      expect(hits[2].text).toBe('say 😀 greeting'); // without the CR of a CRLF line end
    });

    test('case-sensitive, whole-word and regex searches', async () => {
      expect((await run('Greeting', { rg, caseSensitive: true })).hits).toHaveLength(1);
      expect((await run('greet', { rg, wholeWord: true })).hits).toHaveLength(0);
      expect((await run('gr[e]+ting', { rg, regex: true })).hits).toHaveLength(3);
    });

    test('stops at the hit limit and says so', async () => {
      writeFileSync(join(root, 'many.txt'), 'x\n'.repeat(MAX_HITS + 50));
      const { hits, done } = await run('x', { rg });
      expect(hits).toHaveLength(MAX_HITS);
      expect(done.truncated).toBe(true);
    });
  });
}

test('without ripgrep installed the search falls back to the walk', async () => {
  const { hits, done } = await run('greeting', { rg: join(root, 'no-such-rg') });
  expect(done.source).toBe('walk');
  expect(hits).toHaveLength(3);
});

test('an invalid regex is reported, not thrown', async () => {
  const { done } = await run('(unclosed', { rg: null, regex: true });
  expect(done.error).toMatch(/Invalid regex/);
});

test('a cancelled search reports no more hits', async () => {
  for (let i = 0; i < 50; i++) writeFileSync(join(root, `f${i}.txt`), 'greeting\n');
  const hits: ProjectHit[] = [];
  const search = searchProject(root, 'greeting', { rg: null }, (batch) => hits.push(...batch));
  search.cancel();
  expect((await search.done).cancelled).toBe(true);
  expect(hits.length).toBeLessThan(50);
});

test('ripgrep JSON lines: byte offsets become columns; other messages are ignored', () => {
  const line = JSON.stringify({ type: 'match', data: { path: { text: 'x.ts' }, lines: { text: 'é a é\n' }, line_number: 3, submatches: [{ start: 5, end: 7 }] } });
  expect(parseRipgrepLine('/p', line)).toEqual([{ path: '/p/x.ts', line: 2, col: 4, length: 1, text: 'é a é' }]);
  expect(parseRipgrepLine('/p', '{"type":"begin","data":{}}')).toEqual([]);
  expect(parseRipgrepLine('/p', 'not json')).toEqual([]);
});
