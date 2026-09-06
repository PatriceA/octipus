/**
 * The tree-sitter grammars this install ships, and one way to get a parser
 * for each. Shared by the TUI editor's highlighter and the repo symbol
 * indexer, so both read the same `.wasm` files straight out of
 * `node_modules/` and neither vendors a copy.
 *
 * Everything here is best-effort: a missing package, a runtime that cannot
 * load WASM, or a corrupt grammar yields `null`, and the caller falls back
 * (regex highlighting, no symbols) rather than failing the feature.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export type GrammarLanguage = 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'python' | 'rust' | 'go' | 'java';

export const GRAMMAR_FILES: Record<GrammarLanguage, { pkg: string; file: string }> = {
  typescript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  tsx: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  // The TypeScript grammar parses JavaScript as a subset.
  javascript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  jsx: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  python: { pkg: 'tree-sitter-python', file: 'tree-sitter-python.wasm' },
  rust: { pkg: 'tree-sitter-rust', file: 'tree-sitter-rust.wasm' },
  go: { pkg: 'tree-sitter-go', file: 'tree-sitter-go.wasm' },
  java: { pkg: 'tree-sitter-java', file: 'tree-sitter-java.wasm' },
};

/** The subset of a tree-sitter syntax node the callers read. */
export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: SyntaxNode[];
  childForFieldName(fieldName: string): SyntaxNode | null;
  child(index: number): SyntaxNode | null;
  childCount: number;
}

export interface SyntaxTree {
  rootNode: SyntaxNode;
  delete?(): void;
}

export interface GrammarParser {
  setLanguage(lang: unknown): unknown;
  parse(text: string, oldTree?: SyntaxTree | null): SyntaxTree | null;
  delete?(): void;
}

interface ParserModule {
  Parser: {
    new (): GrammarParser;
    init(opts?: { locateFile?: (file: string) => string }): Promise<void>;
  };
  Language: { load(bytes: Uint8Array | string): Promise<unknown> };
}

/**
 * Resolve a grammar package's installed root via the module resolver, then
 * join the file. `web-tree-sitter` does not export its `package.json`, so
 * fall back to the entry point and climb to the package root.
 */
export function resolveGrammarPath(pkg: string, file: string): string | null {
  const require = createRequire(import.meta.url);
  try {
    return join(dirname(require.resolve(`${pkg}/package.json`)), file);
  } catch {
    /* not exported — try the entry point */
  }
  try {
    let dir = dirname(require.resolve(pkg));
    for (let up = 0; up < 8; up++) {
      if (existsSync(join(dir, 'package.json'))) return join(dir, file);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not installed */
  }
  return null;
}

let module: ParserModule | null = null;
let initOnce: Promise<void> | null = null;
const languages = new Map<GrammarLanguage, Promise<unknown | null>>();

async function ensureModule(): Promise<ParserModule | null> {
  if (module) return module;
  if (!initOnce) {
    initOnce = (async () => {
      try {
        const m = (await import('web-tree-sitter')) as unknown as Partial<ParserModule> & { default?: Partial<ParserModule> };
        const Parser = m.Parser ?? m.default?.Parser;
        const Language = m.Language ?? m.default?.Language;
        if (!Parser || !Language) return;
        const wtsRoot = resolveGrammarPath('web-tree-sitter', '');
        await Parser.init({ locateFile: (file) => (wtsRoot ? join(wtsRoot, file) : file) });
        module = { Parser, Language };
      } catch {
        module = null;
      }
    })();
  }
  await initOnce;
  return module;
}

async function loadLanguage(lang: GrammarLanguage): Promise<unknown | null> {
  const mod = await ensureModule();
  if (!mod) return null;
  const entry = GRAMMAR_FILES[lang];
  const wasmPath = resolveGrammarPath(entry.pkg, entry.file);
  if (!wasmPath || !existsSync(wasmPath)) return null;
  try {
    return await mod.Language.load(readFileSync(wasmPath));
  } catch {
    return null;
  }
}

/**
 * A parser set to `lang`, or null when the grammar cannot be loaded. Each
 * call returns a fresh parser (they are cheap; the language object behind
 * them is loaded once and shared). Call `delete()` when done with one.
 */
export async function createParser(lang: GrammarLanguage): Promise<GrammarParser | null> {
  const mod = await ensureModule();
  if (!mod) return null;
  let pending = languages.get(lang);
  if (!pending) {
    pending = loadLanguage(lang);
    languages.set(lang, pending);
  }
  const language = await pending;
  if (!language) return null;
  try {
    const parser = new mod.Parser();
    parser.setLanguage(language);
    return parser;
  } catch {
    return null;
  }
}

/** Test-only: forget loaded grammars so a suite can start clean. */
export function _resetGrammarsForTests(): void {
  languages.clear();
  module = null;
  initOnce = null;
}
