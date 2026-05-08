/**
 * Tree-sitter-backed syntax highlighter.
 *
 * Slots into the existing pluggable highlighter via `setHighlighter`.
 * The pattern-based default in `highlight.ts` stays in place as the
 * fallback when:
 *   - a grammar fails to load (corrupt .wasm, runtime mismatch)
 *   - tree-sitter init fails (older Bun without WASM threading, etc.)
 *   - the language has no grammar registered (markdown, yaml, …)
 *
 * Architecture
 * ────────────
 * Tree-sitter is buffer-oriented; the editor's render path calls
 * `highlight(line, lang)` once per line. Re-parsing the entire
 * buffer on every line lookup would be wasteful, so we cache the
 * last parse keyed on `(lang, sourceHash)` per language. The
 * source hash comes from `setSource(lang, text)` which the editor
 * calls whenever the buffer's content changes; calls without a
 * matching cache just fall through to the line-based highlighter.
 *
 * For now the wrapper does whole-buffer parsing on `setSource` and
 * stores the resulting node ranges keyed by line. A real-world
 * editor would use tree-sitter's incremental parsing (the package
 * exposes `Parser.parse(callback, oldTree)`); we leave that hook in
 * place via `parser.parse(text, oldTree)` and a per-language
 * `lastTree` slot, to be wired once the editor exposes edit deltas.
 *
 * Capture mapping
 * ───────────────
 * Tree-sitter node `type` strings collapse onto the existing
 * TokenKind union (keyword/string/number/comment/function/type/
 * operator/punctuation/plain). The mapping is intentionally
 * conservative — anything we don't have an opinion about stays
 * `plain` so the editor never paints noise.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type HighlighterFn,
  highlightLine,
  resetHighlighter,
  setHighlighter,
  type Token,
  type TokenKind,
} from './highlight';
import type { Language as EditorLang } from './lang';

type WtsParser = {
  setLanguage(lang: WtsLanguage): WtsParser;
  parse(text: string, oldTree?: WtsTree | null): WtsTree | null;
  delete?(): void;
};
type WtsLanguage = unknown;
type WtsTree = {
  rootNode: WtsNode;
  delete?(): void;
};
type WtsNode = {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  child(index: number): WtsNode | null;
  isNamed?: boolean;
};

interface ParserModule {
  Parser: {
    init(opts?: { locateFile?: (file: string) => string }): Promise<void>;
    new (): WtsParser;
  };
  Language: {
    load(input: Uint8Array | string): Promise<WtsLanguage>;
  };
}

/**
 * Languages we ship grammars for, mapped to their npm package +
 * the relative path of the `.wasm` artifact within that package.
 * Resolved at load time via `Bun.resolveSync` so the grammars come
 * directly from `node_modules/` — no vendored copies in the repo.
 *
 * Other Editor `Language` values fall through to the pattern matcher.
 */
const GRAMMAR_FILES: Partial<Record<EditorLang, { pkg: string; file: string }>> = {
  typescript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  tsx:        { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  // ts grammar parses js as a subset
  javascript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  jsx:        { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  python:     { pkg: 'tree-sitter-python',     file: 'tree-sitter-python.wasm' },
  rust:       { pkg: 'tree-sitter-rust',       file: 'tree-sitter-rust.wasm' },
  go:         { pkg: 'tree-sitter-go',         file: 'tree-sitter-go.wasm' },
  java:       { pkg: 'tree-sitter-java',       file: 'tree-sitter-java.wasm' },
};

/**
 * Resolve a grammar package's installed root via Bun's module resolver,
 * then join the wasm filename. Returns null when the package isn't
 * installed (we silently fall back to the regex highlighter).
 */
function resolveGrammarPath(pkg: string, file: string): string | null {
  try {
    // `package.json` is the most reliable resolution target — every
    // package has one, and it sits at the package root.
    const pkgJson = Bun.resolveSync(`${pkg}/package.json`, import.meta.dir);
    return join(dirname(pkgJson), file);
  } catch {
    return null;
  }
}

let module: ParserModule | null = null;
let initOnce: Promise<void> | null = null;

/** Per-language state. `tree` holds the most recent parse for `source`. */
interface LangState {
  parser: WtsParser;
  tree: WtsTree | null;
  source: string;
  /** Cached per-line tokens for the current `source`. */
  cache: Map<number, Token[]> | null;
}

const langs = new Map<EditorLang, LangState>();

async function loadModule(): Promise<ParserModule | null> {
  try {
    const m = await import('web-tree-sitter');
    // The npm package exports both default + named depending on version.
    const Parser = (m as unknown as { Parser?: ParserModule['Parser'] }).Parser
      ?? (m as unknown as ParserModule).Parser;
    const Language = (m as unknown as { Language?: ParserModule['Language'] }).Language
      ?? (m as unknown as ParserModule).Language;
    if (!Parser || !Language) return null;
    return { Parser, Language };
  } catch {
    return null;
  }
}

async function ensureInitialized(): Promise<ParserModule | null> {
  if (module) return module;
  if (!initOnce) {
    initOnce = (async () => {
      module = await loadModule();
      if (!module) return;
      try {
        const wtsRoot = resolveGrammarPath('web-tree-sitter', '');
        await module.Parser.init({
          locateFile: (file) => (wtsRoot ? join(wtsRoot, file) : file),
        });
      } catch {
        module = null;
      }
    })();
  }
  await initOnce;
  return module;
}

async function ensureLang(lang: EditorLang): Promise<LangState | null> {
  const cached = langs.get(lang);
  if (cached) return cached;
  const mod = await ensureInitialized();
  if (!mod) return null;
  const entry = GRAMMAR_FILES[lang];
  if (!entry) return null;
  const wasmPath = resolveGrammarPath(entry.pkg, entry.file);
  if (!wasmPath) return null;
  try {
    const wasm = readFileSync(wasmPath);
    const language = await mod.Language.load(wasm);
    const parser = new mod.Parser();
    parser.setLanguage(language);
    const state: LangState = { parser, tree: null, source: '', cache: null };
    langs.set(lang, state);
    return state;
  } catch {
    return null;
  }
}

/**
 * Tell the highlighter what the full buffer for a language looks
 * like. The editor calls this on buffer load + after edits; the
 * next per-line lookup uses the cached parse instead of re-tokenizing.
 *
 * Errors are swallowed so a malformed buffer never breaks rendering;
 * the line-based fallback handles those lines.
 */
export async function setSource(lang: EditorLang, source: string): Promise<void> {
  const state = await ensureLang(lang);
  if (!state) return;
  if (state.source === source && state.tree) return;
  try {
    const tree = state.parser.parse(source, state.tree);
    state.tree?.delete?.();
    state.tree = tree;
    state.source = source;
    state.cache = tree ? buildLineCache(source, tree) : null;
  } catch {
    state.cache = null;
  }
}

/**
 * Reset all parser state. Test-only — production code uses
 * `setSource` to update on edits.
 */
export function _resetTreeSitterForTests(): void {
  for (const state of langs.values()) {
    state.tree?.delete?.();
    state.parser.delete?.();
  }
  langs.clear();
  module = null;
  initOnce = null;
}

const KEYWORDS = new Set([
  // common control / declaration keywords across the languages we support
  'if', 'else', 'elif', 'while', 'for', 'do', 'return', 'break', 'continue',
  'switch', 'case', 'default', 'match', 'try', 'catch', 'finally', 'throw',
  'class', 'struct', 'enum', 'interface', 'trait', 'impl', 'extends', 'implements',
  'function', 'def', 'fn', 'func', 'lambda',
  'const', 'let', 'var', 'mut', 'static', 'final', 'public', 'private', 'protected',
  'import', 'from', 'export', 'package', 'mod', 'use', 'as', 'with',
  'new', 'this', 'self', 'super', 'in', 'of', 'is', 'not', 'and', 'or',
  'true', 'false', 'null', 'nil', 'None', 'True', 'False', 'undefined',
  'async', 'await', 'yield', 'go', 'defer', 'chan', 'select',
  'pub', 'crate', 'where', 'move', 'dyn', 'ref', 'unsafe', 'extern',
  'type', 'typeof', 'instanceof', 'void',
]);

const TYPE_NODE_TYPES = new Set([
  'type_identifier', 'predefined_type', 'primitive_type', 'generic_type',
  'class_declaration', 'interface_declaration',
]);

const STRING_NODE_TYPES = new Set([
  'string', 'string_literal', 'string_fragment', 'template_string',
  'raw_string_literal', 'interpreted_string_literal',
  'character_literal', 'char_literal',
]);

const NUMBER_NODE_TYPES = new Set([
  'number', 'integer', 'float', 'integer_literal', 'float_literal',
]);

const COMMENT_NODE_TYPES = new Set([
  'comment', 'line_comment', 'block_comment',
]);

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration', 'function_definition', 'method_declaration',
  'method_definition', 'arrow_function',
]);

function classify(node: WtsNode): TokenKind | null {
  const t = node.type;
  if (COMMENT_NODE_TYPES.has(t)) return 'comment';
  if (STRING_NODE_TYPES.has(t)) return 'string';
  if (NUMBER_NODE_TYPES.has(t)) return 'number';
  if (TYPE_NODE_TYPES.has(t)) return 'type';
  if (FUNCTION_NODE_TYPES.has(t)) return 'function';
  // Anonymous tokens (operators, punctuation) — node.isNamed === false in tree-sitter
  if (node.isNamed === false) {
    if (/^[(){}\[\];,]+$/.test(t)) return 'punctuation';
    if (KEYWORDS.has(t)) return 'keyword';
    if (/^[=+\-*/%<>!&|^~?:.]+$/.test(t)) return 'operator';
  }
  return null;
}

interface LineSpan {
  startCol: number;
  endCol: number;
  kind: TokenKind;
}

function buildLineCache(source: string, tree: WtsTree): Map<number, Token[]> {
  const lines = source.split('\n');
  const spans: Map<number, LineSpan[]> = new Map();
  walk(tree.rootNode, spans);
  const out = new Map<number, Token[]>();
  for (let i = 0; i < lines.length; i++) {
    out.set(i, materialize(lines[i], spans.get(i) ?? []));
  }
  return out;
}

function walk(node: WtsNode, spans: Map<number, LineSpan[]>): void {
  const kind = classify(node);
  if (kind) {
    pushSpan(spans, node, kind);
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) walk(c, spans);
  }
}

function pushSpan(spans: Map<number, LineSpan[]>, node: WtsNode, kind: TokenKind): void {
  const sLine = node.startPosition.row;
  const eLine = node.endPosition.row;
  if (sLine === eLine) {
    addSpan(spans, sLine, node.startPosition.column, node.endPosition.column, kind);
    return;
  }
  // Multi-line: split at line boundaries. Per-line columns reset to
  // 0 on every continuation line; the closer line ends at the node's
  // endColumn.
  addSpan(spans, sLine, node.startPosition.column, Number.POSITIVE_INFINITY, kind);
  for (let row = sLine + 1; row < eLine; row++) {
    addSpan(spans, row, 0, Number.POSITIVE_INFINITY, kind);
  }
  addSpan(spans, eLine, 0, node.endPosition.column, kind);
}

function addSpan(map: Map<number, LineSpan[]>, line: number, start: number, end: number, kind: TokenKind): void {
  const list = map.get(line) ?? [];
  list.push({ startCol: start, endCol: end, kind });
  map.set(line, list);
}

function materialize(line: string, spans: LineSpan[]): Token[] {
  if (spans.length === 0) return [{ text: line, kind: 'plain' }];
  // Mark each column with its winning kind. Earlier (outer) nodes
  // win — children walked later overwrite their parents, which is
  // actually what we want for syntax highlighting (a string literal
  // child of an expression should paint over the expression's
  // operator class).
  const marks: (TokenKind | null)[] = new Array(line.length).fill(null);
  for (const s of spans) {
    const start = Math.min(line.length, Math.max(0, s.startCol));
    const end = Math.min(line.length, Math.max(start, s.endCol));
    for (let i = start; i < end; i++) marks[i] = s.kind;
  }
  // Coalesce adjacent same-kind chars.
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const k = marks[i] ?? 'plain';
    let j = i;
    while (j < line.length && (marks[j] ?? 'plain') === k) j++;
    out.push({ text: line.slice(i, j), kind: k });
    i = j;
  }
  return out;
}

/**
 * The `HighlighterFn` we install via `setHighlighter`. Per-line:
 *   1. If we have a cached parse for this language and this line
 *      lives in the cache, return it.
 *   2. Otherwise fall back to the regex highlighter — keeps the
 *      editor responsive on languages without a vendored grammar
 *      and on the very first frame before `setSource` runs.
 */
function lookupCachedLine(line: string, lang: EditorLang, lineIndex?: number): Token[] | null {
  if (lineIndex === undefined) return null;
  const state = langs.get(lang);
  if (!state || !state.cache) return null;
  const tokens = state.cache.get(lineIndex);
  if (!tokens) return null;
  // Validate: cached line text must match what the renderer is
  // asking about. If the buffer drifted from the last setSource,
  // skip the cache rather than paint stale colors.
  const cachedText = tokens.map((t) => t.text).join('');
  if (cachedText !== line) return null;
  return tokens;
}

const treeSitterHighlighter: HighlighterFn = (line, lang) => {
  const idx = (treeSitterHighlighter as unknown as { _lineIndex?: number })._lineIndex;
  const cached = lookupCachedLine(line, lang as EditorLang, idx);
  if (cached) return cached;
  return highlightLine(line, lang);
};

/**
 * Hint the next call's line index. The editor calls this just
 * before each `highlight()` so the per-line cache lookup knows
 * which row to fetch — keeping the existing
 * `(line, lang) => Token[]` contract intact.
 */
export function hintLineIndex(idx: number): void {
  (treeSitterHighlighter as unknown as { _lineIndex?: number })._lineIndex = idx;
}

/** Install the tree-sitter highlighter. Idempotent; safe to call from app start. */
export function installTreeSitterHighlighter(): void {
  setHighlighter(treeSitterHighlighter);
}

/** Test-only: revert to the line-based default. */
export function uninstallTreeSitterHighlighter(): void {
  resetHighlighter();
}
