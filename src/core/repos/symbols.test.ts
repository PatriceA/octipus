/**
 * Symbol extraction over real grammars (the WASM files in node_modules), one
 * small fixture per language, plus the index walk and the two readers.
 */
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as grammars from '@/utils/tree-sitter-grammars';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
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
      ['util.helper', 'function', true],
      ['N', 'constant', true],
    ]);
  });

  test('java: classes, nested types, methods, public modifier', async () => {
    const src = ['package a;', 'public class Server {', '  public void start() {}', '  void tick() {}', '  static class Inner { public int size() { return 0; } }', '}', 'interface Runner { void run(); }', 'enum Mode { A }'].join('\n');
    const out = await extractSymbols(src, 'java');
    expect(out!.map((s) => [s.name, s.kind, s.exported])).toEqual([
      ['Server', 'class', true],
      ['Server.start', 'method', true],
      ['Server.tick', 'method', false],
      ['Server.Inner', 'class', false],
      ['Server.Inner.size', 'method', true],
      ['Runner', 'interface', false],
      ['Runner.run', 'method', true],
      ['Mode', 'enum', false],
      ['Mode.A', 'constant', true],
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
    expect(index.truncated).toBe(true);
    expect(index.skippedFiles).toBe(1);

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


describe('symbol index access and partial-result evidence', () => {
  test.each([false, true])('honors nested gitignore and negation (Git repository: %s)', async git => {
    const root = mkdtempSync(join(tmpdir(), 'octi-symbol-ignore-'));
    if (git) execFileSync('git', ['init', '--quiet', root]);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, '.gitignore'), 'secret.ts\n*.generated.ts\n!keep.generated.ts\n');
    writeFileSync(join(root, 'secret.ts'), 'export const SECRET = 1;');
    writeFileSync(join(root, 'other.generated.ts'), 'export const Generated = 1;');
    writeFileSync(join(root, 'keep.generated.ts'), 'export const Kept = 1;');
    writeFileSync(join(root, 'src', '.gitignore'), 'local.ts\n');
    writeFileSync(join(root, 'src', 'local.ts'), 'export const Local = 1;');
    writeFileSync(join(root, 'src', 'visible.ts'), 'export const Visible = 1;');
    const index = await indexRepoSymbols(root);
    expect(index.files.map(f => f.path).sort()).toEqual(['keep.generated.ts', 'src/visible.ts']);
    expect(index.warnings).toEqual([]);
    if (git) {
      execFileSync('git', ['-C', root, 'add', '-f', 'secret.ts']);
      expect((await indexRepoSymbols(root)).files.some(f => f.path === 'secret.ts')).toBe(true);
    }
  });

  test('never follows symlink files, directories, or tracked directories replaced with links', async () => {
    const root = mkdtempSync(join(tmpdir(), 'octi-symbol-safe-'));
    const outside = mkdtempSync(join(tmpdir(), 'octi-symbol-outside-'));
    writeFileSync(join(outside, 'secret.ts'), 'export function privateOutside() {}');
    execFileSync('git', ['init', '--quiet', root]);
    mkdirSync(join(root, 'tracked'));
    writeFileSync(join(root, 'tracked', 'secret.ts'), 'export function before() {}');
    execFileSync('git', ['-C', root, 'add', '.']);
    rmSync(join(root, 'tracked'), { recursive: true });
    symlinkSync(outside, join(root, 'tracked'), 'dir');
    symlinkSync(root, join(root, 'loop'), 'dir');
    symlinkSync(join(outside, 'secret.ts'), join(root, 'alias.ts'));
    const index = await indexRepoSymbols(root);
    expect(index.symbolCount).toBe(0);
    expect(index.skippedFiles).toBeGreaterThan(0);
    expect(index.warnings).toContain('Unreadable, missing, or symlink source files were skipped.');
  });

  test('marks final-file symbol clipping and candidate traversal caps as truncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'octi-symbol-cap-'));
    writeFileSync(join(root, 'a.ts'), 'export const One=1; export const Two=2;');
    expect(await indexRepoSymbols(root, { maxSymbols: 1 })).toMatchObject({ symbolCount: 1, truncated: true });
    expect(await indexRepoSymbols(root, { maxEntries: 0 })).toMatchObject({ fileCount: 0, truncated: true });
    expect(await indexRepoSymbols(root, { maxSymbols: NaN })).toMatchObject({ symbolCount: 2, truncated: false });
  });

  test('retains unavailable grammar and unsupported-extension evidence for empty indexes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'octi-symbol-unavailable-'));
    writeFileSync(join(root, 'a.ts'), 'export const One=1;');
    writeFileSync(join(root, 'b.ts'), 'export const Two=2;');
    writeFileSync(join(root, 'app.dart'), 'class Application {}');
    const parser = vi.spyOn(grammars, 'createParser').mockResolvedValue(null);
    try { expect(await indexRepoSymbols(root)).toMatchObject({ fileCount: 0, skippedFiles: 2, skippedLanguages: ['typescript'], unsupportedExtensions: ['.dart'] }); }
    finally { parser.mockRestore(); }
  });

  test('continues after a parse error and releases native parser resources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'octi-symbol-parse-'));
    writeFileSync(join(root, 'a.ts'), 'export const One=1;');
    writeFileSync(join(root, 'b.ts'), 'export const Two=2;');
    const dispose = vi.fn();
    const parser = vi.spyOn(grammars, 'createParser').mockResolvedValueOnce({ setLanguage() {}, parse() { throw new Error('parse failed'); }, delete: dispose });
    try {
      expect(await indexRepoSymbols(root)).toMatchObject({ fileCount: 1, symbolCount: 1, skippedFiles: 1, warnings: ['Some source files could not be parsed.'] });
      expect(dispose).toHaveBeenCalledOnce();
    } finally { parser.mockRestore(); }
  });

  test('a new scan replaces changed/deleted definitions; previous results remain explicit snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'octi-symbol-fresh-'));
    writeFileSync(join(root, 'a.ts'), 'export function Old() {}');
    const old = await indexRepoSymbols(root);
    rmSync(join(root, 'a.ts'));
    writeFileSync(join(root, 'b.ts'), 'export function New() {}');
    const fresh = await indexRepoSymbols(root);
    expect(findSymbols(old, 'Old')).toHaveLength(1);
    expect(findSymbols(fresh, 'Old')).toEqual([]);
    expect(findSymbols(fresh, 'New')).toHaveLength(1);
  });

  test('private TypeScript members are not presented as exports', async () => {
    const out = await extractSymbols('export class A { private hidden() {} protected inherited() {} visible() {} }', 'typescript');
    expect(out?.map(s => [s.name, s.exported])).toEqual([['A', true], ['A.hidden', false], ['A.inherited', false], ['A.visible', true]]);
  });
});


test('findSymbols normalizes queries and clamps numeric limits', () => {
  const index: RepoSymbolIndex = { version: 1, indexedAt: new Date().toISOString(), fileCount: 1, symbolCount: 250,
    truncated: false, skippedLanguages: [], files: [{ path: 'a.ts', language: 'typescript',
      symbols: Array.from({ length: 250 }, (_, i) => ({ name: `Item${i}`, kind: 'constant', line: i + 1 })) }] };
  expect(findSymbols(index, '  iTeM  ', { limit: 2.8 })).toHaveLength(2);
  expect(findSymbols(index, 'Item', { limit: -1 })).toHaveLength(1);
  expect(findSymbols(index, 'Item', { limit: 0 })).toHaveLength(1);
  expect(findSymbols(index, 'Item', { limit: 999 })).toHaveLength(200);
  for (const limit of [NaN, Infinity, -Infinity]) expect(findSymbols(index, 'Item', { limit })).toHaveLength(50);
  expect(findSymbols(index, '   ')).toEqual([]);
});

test('production-style ESM bundle loads all shipped WASM grammars without a source loader', async () => {
  const { build } = await import('esbuild');
  const root = mkdtempSync(join(tmpdir(), 'octi-symbol-bundle-'));
  // Mirror the installed artifact's adjacent node_modules without copying it.
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const output = join(root, 'symbols.mjs');
  await build({ entryPoints: [resolve('src/core/repos/symbols.ts')], outfile: output, bundle: true,
    platform: 'node', target: 'node24', format: 'esm', packages: 'external',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  const fixtures = { typescript: 'export function Typed() {}', tsx: 'export function TypedJsx() { return <div/> }',
    javascript: 'function Plain() {}', jsx: 'function PlainJsx() { return <div/> }', python: 'def Python(): pass',
    go: 'package main\nfunc Go() {}', rust: 'pub fn Rust() {}', java: 'class Java {}' };
  const program = `const {extractSymbols} = await import(${JSON.stringify(output)}); const results = {}; for(const [lang, source] of Object.entries(${JSON.stringify(fixtures)})) results[lang] = (await extractSymbols(source,lang))?.map(s=>s.name); process.stdout.write(JSON.stringify(results));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 10000 }));
  expect(result).toEqual({ typescript: ['Typed'], tsx: ['TypedJsx'], javascript: ['Plain'], jsx: ['PlainJsx'], python: ['Python'], go: ['Go'], rust: ['Rust'], java: ['Java'] });
});


test('TypeScript declaration files expose ambient APIs and explicit local exports', async () => {
  const out = await extractSymbols('export declare function api(x: string): void;\ndeclare class Public { method(): void }\nexport { Public as Service };\nexport interface Handler { run(): void }', 'typescript');
  expect(out?.map(s => [s.name, s.kind, s.exported])).toEqual([
    ['api', 'function', true], ['Public', 'class', true], ['Public.method', 'method', true],
    ['Handler', 'interface', true], ['Handler.run', 'method', true],
  ]);
});

test('Go type aliases retain their declaration names', async () => {
  expect(await extractSymbols('package main\ntype Name = string\n', 'go')).toEqual([{ name: 'Name', kind: 'type', line: 2, exported: true }]);
});

test('a missing root produces explicit unavailable metadata, not a silently empty successful index', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'octi-symbol-missing-'));
  expect(await indexRepoSymbols(join(parent, 'missing'))).toMatchObject({ fileCount: 0, truncated: true, warnings: [expect.stringContaining('unavailable')] });
});


test('explicit exports apply to each const/let declarator and its aliases', async () => {
  const symbols = await extractSymbols('const api = () => {}, internal = 1; let version = 2; export { api as call, version }; export class Other {}', 'typescript');
  expect(symbols?.map(s => [s.name, s.exported])).toEqual([['api', true], ['internal', false], ['version', true], ['Other', true]]);
  const index: RepoSymbolIndex = { version: 1, indexedAt: new Date().toISOString(), fileCount: 1, symbolCount: symbols!.length,
    truncated: false, skippedLanguages: [], files: [{ path: 'api.ts', language: 'typescript', symbols: symbols! }] };
  expect(outlineSymbols(index)).toBe('api.ts: api, version, Other');
});


describe('modern Java symbols with the shipped grammar', () => {
  test('records include explicitly declared compact and overloaded constructors and methods', async () => {
    const source = [
      'public record User(String name, int age) {',
      '  public User { if (age < 0) throw new IllegalArgumentException(); }',
      '  public User(String name) { this(name, 0); }',
      '  public String label() { return name; }',
      '  private void validate() {}',
      '}',
    ].join('\n');
    expect((await extractSymbols(source, 'java'))?.map(s => [s.name, s.kind, s.line, s.exported])).toEqual([
      ['User', 'class', 1, true], ['User.User', 'method', 2, true], ['User.User', 'method', 3, true],
      ['User.label', 'method', 4, true], ['User.validate', 'method', 5, false],
    ]);
  });

  test('annotation types/elements and interface members use implicit public visibility', async () => {
    const source = [
      'public @interface Route { String value(); int retries() default 3; }',
      'public interface Service {',
      '  void run(); default void close() {} static void create() {} private void helper() {}',
      '  int VERSION = 1, REVISION = 2;',
      '  class Impl { public Impl() {} }',
      '  @interface Nested { String value(); }',
      '}',
    ].join('\n');
    expect((await extractSymbols(source, 'java'))?.map(s => [s.name, s.kind, s.exported])).toEqual([
      ['Route', 'interface', true], ['Route.value', 'method', true], ['Route.retries', 'method', true],
      ['Service', 'interface', true], ['Service.run', 'method', true], ['Service.close', 'method', true],
      ['Service.create', 'method', true], ['Service.helper', 'method', false],
      ['Service.VERSION', 'constant', true], ['Service.REVISION', 'constant', true],
      ['Service.Impl', 'class', true], ['Service.Impl.Impl', 'method', true],
      ['Service.Nested', 'interface', true], ['Service.Nested.value', 'method', true],
    ]);
  });

  test('enum constants and members after the semicolon retain qualified owners', async () => {
    const source = [
      'public enum Mode {',
      '  ONE { public void run() {} }, TWO;',
      '  Mode() {}',
      '  public void run() {}',
      '  public static class Nested { public Nested() {} }',
      '}',
    ].join('\n');
    expect((await extractSymbols(source, 'java'))?.map(s => [s.name, s.kind, s.line, s.exported])).toEqual([
      ['Mode', 'enum', 1, true], ['Mode.ONE', 'constant', 2, true], ['Mode.ONE.run', 'method', 2, true],
      ['Mode.TWO', 'constant', 2, true], ['Mode.Mode', 'method', 3, false], ['Mode.run', 'method', 4, true],
      ['Mode.Nested', 'class', 5, true], ['Mode.Nested.Nested', 'method', 5, true],
    ]);
  });

  test('annotation arguments cannot grant public visibility or hide sealed declarations', async () => {
    const source = '@Label("public") class PackagePrivate { @Label("public") private void hidden() {} }\npublic sealed interface Shape permits Circle {}\nfinal class Circle implements Shape {}';
    expect((await extractSymbols(source, 'java'))?.map(s => [s.name, s.exported])).toEqual([
      ['PackagePrivate', false], ['PackagePrivate.hidden', false], ['Shape', true], ['Circle', false],
    ]);
  });

  test('method-local and anonymous class declarations are not promoted to repository symbols', async () => {
    const symbols = await extractSymbols('public class Outer { public void run() { class Local { void hidden() {} } Runnable r = new Runnable() { public void run() {} }; } public static record Nested(int value) {} }', 'java');
    expect(symbols?.map(s => s.name)).toEqual(['Outer', 'Outer.run', 'Outer.Nested']);
  });
});
