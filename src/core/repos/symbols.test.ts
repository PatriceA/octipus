/**
 * Symbol extraction over real grammars (the WASM files in node_modules), one
 * small fixture per language, plus the index walk and the two readers.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { extractSymbols, findSymbols, indexRepoSymbols, languageForFile, outlineSymbols, type RepoSymbolIndex } from './symbols';

const names = (list: { name: string }[] | null) => (list ?? []).map((s) => s.name);

describe('extractSymbols', () => {
  test('typescript: exports, classes with methods, types, arrow-function consts', async () => {
    const src = [
      'import x from "y";',
      'export function ship(a: number) { return a; }',
      'function helper() {}',
      'export const parse = (s: string) => s;',
      'const LIMIT = 3;',
      'export class Queue<T> {',
      '  private items: T[] = [];',
      '  push(item: T) { this.items.push(item); }',
      '  static of<T>(x: T) { return new Queue<T>(); }',
      '}',
      'export interface Job { id: string }',
      'export type Status = "a" | "b";',
      'enum Colour { Red }',
    ].join('\n');
    const out = await extractSymbols(src, 'typescript');
    expect(out).not.toBeNull();
    expect(out!.map((s) => [s.name, s.kind, s.line, s.exported])).toEqual([
      ['ship', 'function', 2, true],
      ['helper', 'function', 3, false],
      ['parse', 'function', 4, true],
      ['LIMIT', 'constant', 5, false],
      ['Queue', 'class', 6, true],
      ['Queue.push', 'method', 8, true],
      ['Queue.of', 'method', 9, true],
      ['Job', 'interface', 11, true],
      ['Status', 'type', 12, true],
      ['Colour', 'enum', 13, false],
    ]);
  });

  test('python: functions, classes with methods, underscore means private', async () => {
    const src = ['def run():', '    pass', '', 'class Server:', '    def start(self): ...', '    def _tick(self): ...', '', 'def _hidden(): ...', '@decorated', 'def wrapped(): ...'].join('\n');
    const out = await extractSymbols(src, 'python');
    expect(out!.map((s) => [s.name, s.kind, s.exported])).toEqual([
      ['run', 'function', true],
      ['Server', 'class', true],
      ['Server.start', 'method', true],
      ['Server._tick', 'method', false],
      ['_hidden', 'function', false],
      ['wrapped', 'function', true],
    ]);
  });

  test('go: functions, receiver methods, structs and interfaces, capital means exported', async () => {
    const src = ['package main', 'type Server struct{}', 'type Runner interface{ Run() }', 'type id int', 'func (s *Server) Start() {}', 'func helper() {}', 'func Main() {}'].join('\n');
    const out = await extractSymbols(src, 'go');
    expect(out!.map((s) => [s.name, s.kind, s.exported])).toEqual([
      ['Server', 'struct', true],
      ['Runner', 'interface', true],
      ['id', 'type', false],
      ['Server.Start', 'method', true],
      ['helper', 'function', false],
      ['Main', 'function', true],
    ]);
  });

  test('rust: items, impl methods, traits, pub visibility', async () => {
    const src = ['pub struct Server;', 'enum Mode { A }', 'pub trait Run { fn run(&self); }', 'impl Server { pub fn new() -> Self { Server } fn tick(&self) {} }', 'pub fn main() {}', 'mod util { pub fn helper() {} }', 'pub const N: u8 = 1;'].join('\n');
    const out = await extractSymbols(src, 'rust');
    expect(out!.map((s) => [s.name, s.kind, s.exported])).toEqual([
      ['Server', 'struct', true],
      ['Mode', 'enum', false],
      ['Run', 'trait', true],
      ['Run.run', 'method', false],
      ['Server.new', 'method', true],
      ['Server.tick', 'method', false],
      ['main', 'function', true],
      ['util', 'module', false],
      ['util.helper', 'method', true],
      ['N', 'constant', true],
    ]);
  });

  test('java: classes, nested types, methods, public modifier', async () => {
    const src = ['package a;', 'public class Server {', '  public void start() {}', '  void tick() {}', '  static class Inner { public int size() { return 0; } }', '}', 'interface Runner { void run(); }', 'enum Mode { A }'].join('\n');
    const out = await extractSymbols(src, 'java');
    expect(out!.map((s) => [s.name, s.kind, s.exported])).toEqual([
      ['Server', 'class', true],
      ['Server.start', 'method', true],
      ['Server.tick', 'method', undefined],
      ['Server.Inner', 'class', false],
      ['Server.Inner.size', 'method', true],
      ['Runner', 'interface', undefined],
      ['Runner.run', 'method', undefined],
      ['Mode', 'enum', undefined],
    ]);
  });

  test('languageForFile maps extensions and leaves the rest alone', () => {
    expect(languageForFile('a/b.tsx')).toBe('tsx');
    expect(languageForFile('types.d.ts')).toBe('typescript');
    expect(languageForFile('main.go')).toBe('go');
    expect(languageForFile('README.md')).toBeNull();
  });
});

describe('indexRepoSymbols', () => {
  test('walks a repo, skips build dirs and oversized files, and respects the file cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'octi-symbols-'));
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'src', 'index.ts'), 'export function main() {}\nexport const VERSION = "1";');
    writeFileSync(join(root, 'src', 'core', 'queue.ts'), 'export class Queue { push() {} pop() {} }');
    writeFileSync(join(root, 'src', 'core', 'empty.ts'), '// nothing here');
    writeFileSync(join(root, 'src', 'big.ts'), `export function huge() {}\n${'/'.repeat(5000)}`);
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'function ignored() {}');
    writeFileSync(join(root, 'dist', 'out.js'), 'function alsoIgnored() {}');
    writeFileSync(join(root, 'README.md'), '# hi');

    const index = await indexRepoSymbols(root, { maxFileBytes: 4000 });
    expect(index.version).toBe(1);
    expect(index.fileCount).toBe(3);
    expect(index.files.map((f) => f.path).sort()).toEqual(['src/core/queue.ts', 'src/index.ts']);
    expect(index.symbolCount).toBe(5);
    expect(index.truncated).toBe(false);

    const capped = await indexRepoSymbols(root, { maxFiles: 1 });
    expect(capped.fileCount).toBe(1);
    expect(capped.truncated).toBe(true);
  });
});

describe('readers', () => {
  const index: RepoSymbolIndex = {
    version: 1,
    indexedAt: '2026-09-06T00:00:00.000Z',
    fileCount: 2,
    symbolCount: 5,
    truncated: false,
    skippedLanguages: [],
    files: [
      { path: 'src/queue.ts', language: 'typescript', symbols: [
        { name: 'Queue', kind: 'class', line: 1, exported: true },
        { name: 'Queue.push', kind: 'method', line: 2, exported: true },
        { name: 'helper', kind: 'function', line: 9, exported: false },
      ] },
      { path: 'src/push.ts', language: 'typescript', symbols: [
        { name: 'pushAll', kind: 'function', line: 1, exported: true },
        { name: 'Pusher', kind: 'class', line: 5, exported: true },
      ] },
    ],
  };

  test('findSymbols ranks exact, then prefix, then substring, and filters by kind', () => {
    expect(findSymbols(index, 'push').map((h) => `${h.name}@${h.path}:${h.line}`)).toEqual([
      'Queue.push@src/queue.ts:2',
      'pushAll@src/push.ts:1',
      'Pusher@src/push.ts:5',
    ]);
    expect(findSymbols(index, 'push', { kind: 'function' }).map((h) => h.name)).toEqual(['pushAll']);
    expect(findSymbols(index, '')).toEqual([]);
    expect(findSymbols(null, 'x')).toEqual([]);
  });

  test('outlineSymbols lists exported names per file, busiest first, and caps', () => {
    const outline = outlineSymbols(index);
    expect(outline.split('\n')).toEqual(['src/queue.ts: Queue, Queue.push', 'src/push.ts: pushAll, Pusher']);
    expect(outlineSymbols(index, { maxFiles: 1, maxPerFile: 1 })).toBe('src/queue.ts: Queue (+1)\n… 1 more files (find_symbol searches all of them)');
    expect(outlineSymbols(null)).toBe('');
  });
});
