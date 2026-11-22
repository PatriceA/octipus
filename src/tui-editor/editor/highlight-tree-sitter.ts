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
 * `highlight(line, lang)` once per line. Re-parsing the entire buffer on
 * every line lookup would be wasteful, so each open buffer has its own
 * parse, keyed by the buffer's id: `setSource(key, lang, text)` parses and
 * caches tokens by line, `hintLine(key, index)` tells the next lookup which
 * buffer and row it is for, and `dropSource(key)` frees it when the buffer
 * closes. Two files of the same language no longer evict each other.
 *
 * The editor calls `setSource` when a buffer opens and again, debounced,
 * after edits. Each call is a full parse: an incremental parse needs the
 * old tree edited first (`tree.edit`), and handing tree-sitter an unedited
 * old tree reuses nodes at the wrong offsets. Until the new parse lands,
 * a line whose text no longer matches the cached parse is drawn by the
 * line-based highlighter instead of with stale colours.
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
import { join } from 'node:path';
import { resolveGrammarPath, GRAMMAR_FILES as SHARED_GRAMMAR_FILES } from '@/utils/tree-sitter-grammars';
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
 * Grammars come from the shared table in `utils/tree-sitter-grammars`
 * (also used by the repo symbol indexer), so both read the same `.wasm`
 * files straight out of `node_modules/`. Editor languages without an entry
 * fall through to the pattern matcher.
 */
const GRAMMAR_FILES: Partial<Record<EditorLang, { pkg: string; file: string }>> = SHARED_GRAMMAR_FILES;

let module: ParserModule | null = null;
let initOnce: Promise<void> | null = null;

/** One parser per language, shared by every buffer of that language. */
const parsers = new Map<EditorLang, WtsParser>();

/** Per-buffer parse. `cache` holds per-line tokens for `source`. */
interface SourceState {
  lang: EditorLang;
  tree: WtsTree | null;
  source: string;
  cache: Map<number, Token[]> | null;
  /** Bumped by every `setSource`, so a parse that finishes late does not overwrite a newer one. */
  generation: number;
}

const sources = new Map<string, SourceState>();

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

async function ensureParser(lang: EditorLang): Promise<WtsParser | null> {
  const cached = parsers.get(lang);
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
    const parser = parsers.get(lang) ?? new mod.Parser();
    parser.setLanguage(language);
    parsers.set(lang, parser);
    return parser;
  } catch {
    return null;
  }
}

/**
 * Tell the highlighter what buffer `key` (a buffer id) now holds. The next
 * per-line lookups for that buffer use the parse instead of the line-based
 * highlighter.
 *
 * A grammar that fails to load or a parse that throws leaves the buffer on
 * the line-based highlighter; rendering never breaks on a malformed buffer.
 */
export async function setSource(key: string, lang: EditorLang, source: string): Promise<void> {
  const previous = sources.get(key);
  if (previous && previous.lang === lang && previous.source === source && previous.tree) return;
  const generation = (previous?.generation ?? 0) + 1;
  const state: SourceState = previous && previous.lang === lang ? previous : { lang, tree: null, source: '', cache: null, generation };
  state.generation = generation;
  sources.set(key, state);
  const parser = await ensureParser(lang);
  if (!parser || sources.get(key) !== state || state.generation !== generation) return;
  try {
    const tree = parser.parse(source);
    state.tree?.delete?.();
    state.tree = tree;
    state.source = source;
    state.cache = tree ? buildLineCache(source, tree) : null;
  } catch {
    state.cache = null;
  }
}

/** Forget buffer `key`'s parse (the buffer closed). */
export function dropSource(key: string): void {
  sources.get(key)?.tree?.delete?.();
  sources.delete(key);
}

/** Test aid: whether buffer `key` has a parse for exactly `source`. */
export function hasParse(key: string, source: string): boolean {
  const state = sources.get(key);
  return !!state?.cache && state.source === source;
}

/**
 * Reset all parser state. Test-only — production code uses
 * `setSource` to update on edits.
 */
export function _resetTreeSitterForTests(): void {
  for (const state of sources.values()) state.tree?.delete?.();
  sources.clear();
  for (const parser of parsers.values()) parser.delete?.();
  parsers.clear();
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
 * The `HighlighterFn` we install via `setHighlighter`. Per line:
 *   1. If the hinted buffer has a parse of this language and the line's
 *      text still matches it, return the parsed tokens.
 *   2. Otherwise fall back to the regex highlighter — keeps the editor
 *      responsive on languages without a vendored grammar, on the first
 *      frame before `setSource` lands, and on lines edited since.
 */
let hint: { key: string; line: number } | null = null;

function lookupCachedLine(line: string, lang: EditorLang): Token[] | null {
  if (!hint) return null;
  const state = sources.get(hint.key);
  if (!state || state.lang !== lang || !state.cache) return null;
  const tokens = state.cache.get(hint.line);
  if (!tokens) return null;
  // Validate: cached line text must match what the renderer is
  // asking about. If the buffer drifted from the last setSource,
  // skip the cache rather than paint stale colors.
  const cachedText = tokens.map((t) => t.text).join('');
  if (cachedText !== line) return null;
  return tokens;
}

const treeSitterHighlighter: HighlighterFn = (line, lang) => lookupCachedLine(line, lang as EditorLang) ?? highlightLine(line, lang);

/**
 * Hint the next call's buffer and line. The editor calls this just before
 * each `highlight()` so the cache lookup knows which buffer and row to
 * fetch — keeping the existing `(line, lang) => Token[]` contract intact.
 */
export function hintLine(key: string, line: number): void {
  hint = { key, line };
}

/** Install the tree-sitter highlighter. Idempotent; safe to call from app start. */
export function installTreeSitterHighlighter(): void {
  setHighlighter(treeSitterHighlighter);
}

/** Test-only: revert to the line-based default. */
export function uninstallTreeSitterHighlighter(): void {
  resetHighlighter();
}
