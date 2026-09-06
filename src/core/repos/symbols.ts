/**
 * Per-repo symbol index — the "what is defined where" layer of the repo map.
 *
 * The registry already knows a repo's layout, commands and dependency
 * graph; this adds its top-level declarations (functions, classes, types,
 * methods) with file and line, parsed with the tree-sitter grammars the TUI
 * already ships. A worker reads `get_repo`'s outline and `find_symbol`
 * before it reads files, so it opens the two that matter instead of ten.
 *
 * Extraction is deliberately shallow: top-level declarations plus one level
 * of members (a class's methods, an impl's functions). Locals are noise at
 * this altitude. Every cap below exists so a monorepo cannot turn a scan
 * into a minute of parsing or a row into megabytes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { CodeSymbol, FileSymbols, RepoSymbolIndex, SymbolKind } from '@db/schema/workspace-repos';
import { createParser, type GrammarLanguage, type SyntaxNode } from '@/utils/tree-sitter-grammars';

export type { CodeSymbol, FileSymbols, RepoSymbolIndex, SymbolKind };

export interface IndexOptions {
  /** Stop after this many source files. */
  maxFiles?: number;
  /** Skip files larger than this. */
  maxFileBytes?: number;
  /** Keep at most this many symbols in the index. */
  maxSymbols?: number;
}

const DEFAULTS: Required<IndexOptions> = { maxFiles: 2500, maxFileBytes: 400_000, maxSymbols: 20_000 };

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '.next', '.nuxt', '.turbo',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', 'site-packages', '.cache', 'tmp', '.idea', '.vscode',
]);

const EXT_LANG: Record<string, GrammarLanguage> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
};

/** The grammar a file would parse with, by extension; null for anything else. */
export function languageForFile(path: string): GrammarLanguage | null {
  if (path.endsWith('.d.ts')) return 'typescript';
  return EXT_LANG[extname(path).toLowerCase()] ?? null;
}

// ── Extraction ───────────────────────────────────────────────────

function nameOf(node: SyntaxNode, field = 'name'): string | null {
  const n = node.childForFieldName(field);
  return n?.text?.trim() || null;
}

function sym(name: string | null, kind: SymbolKind, node: SyntaxNode, exported?: boolean): CodeSymbol | null {
  if (!name) return null;
  const s: CodeSymbol = { name, kind, line: node.startPosition.row + 1 };
  if (exported !== undefined) s.exported = exported;
  return s;
}

function push(out: CodeSymbol[], s: CodeSymbol | null): void {
  if (s) out.push(s);
}

/** Members of a class/interface/impl body, named `Owner.member`. */
function members(out: CodeSymbol[], owner: string, body: SyntaxNode | null, memberTypes: Set<string>, kind: SymbolKind, exported?: boolean): void {
  if (!body) return;
  for (const child of body.namedChildren) {
    if (!memberTypes.has(child.type)) continue;
    const name = nameOf(child) ?? (child.type === 'function_item' ? nameOf(child) : null);
    push(out, sym(name ? `${owner}.${name}` : null, kind, child, exported));
  }
}

const TS_MEMBERS = new Set(['method_definition', 'method_signature', 'abstract_method_signature']);

function extractTs(root: SyntaxNode, out: CodeSymbol[]): void {
  const visit = (node: SyntaxNode, exported: boolean) => {
    switch (node.type) {
      case 'export_statement': {
        const decl = node.childForFieldName('declaration');
        if (decl) visit(decl, true);
        return;
      }
      case 'function_declaration':
      case 'generator_function_declaration':
        push(out, sym(nameOf(node), 'function', node, exported));
        return;
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const name = nameOf(node);
        push(out, sym(name, 'class', node, exported));
        if (name) members(out, name, node.childForFieldName('body'), TS_MEMBERS, 'method', exported);
        return;
      }
      case 'interface_declaration': {
        const name = nameOf(node);
        push(out, sym(name, 'interface', node, exported));
        return;
      }
      case 'type_alias_declaration':
        push(out, sym(nameOf(node), 'type', node, exported));
        return;
      case 'enum_declaration':
        push(out, sym(nameOf(node), 'enum', node, exported));
        return;
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const decl of node.namedChildren) {
          if (decl.type !== 'variable_declarator') continue;
          const value = decl.childForFieldName('value');
          const isFn = value?.type === 'arrow_function' || value?.type === 'function_expression' || value?.type === 'function';
          push(out, sym(nameOf(decl), isFn ? 'function' : 'constant', decl, exported));
        }
        return;
      }
      case 'module':
      case 'internal_module':
        push(out, sym(nameOf(node), 'module', node, exported));
        return;
      default:
        return;
    }
  };
  for (const child of root.namedChildren) visit(child, false);
}

function extractPython(root: SyntaxNode, out: CodeSymbol[]): void {
  const visit = (node: SyntaxNode, owner: string | null) => {
    const inner = node.type === 'decorated_definition' ? node.childForFieldName('definition') : node;
    if (!inner) return;
    if (inner.type === 'function_definition') {
      const name = nameOf(inner);
      push(out, sym(name ? (owner ? `${owner}.${name}` : name) : null, owner ? 'method' : 'function', inner, name ? !name.startsWith('_') : undefined));
    } else if (inner.type === 'class_definition') {
      const name = nameOf(inner);
      push(out, sym(name, 'class', inner, name ? !name.startsWith('_') : undefined));
      const body = inner.childForFieldName('body');
      if (name && body) for (const m of body.namedChildren) visit(m, name);
    }
  };
  for (const child of root.namedChildren) visit(child, null);
}

function goExported(name: string | null): boolean | undefined {
  return name ? /^[A-Z]/.test(name) : undefined;
}

function extractGo(root: SyntaxNode, out: CodeSymbol[]): void {
  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'function_declaration': {
        const name = nameOf(node);
        push(out, sym(name, 'function', node, goExported(name)));
        break;
      }
      case 'method_declaration': {
        const name = nameOf(node);
        // Receiver `(s *Server)` → `Server.Name`.
        const receiver = node.childForFieldName('receiver');
        const recvText = receiver?.text.replace(/[()*\s]/g, '') ?? '';
        const recvType = recvText.includes(',') ? recvText.split(',')[0] : recvText.replace(/^[a-zA-Z_]\w*(?=[A-Z])/, '');
        const owner = receiver ? (receiver.namedChildren[0]?.childForFieldName('type')?.text.replace(/^\*/, '') ?? recvType) : '';
        push(out, sym(name ? (owner ? `${owner}.${name}` : name) : null, 'method', node, goExported(name)));
        break;
      }
      case 'type_declaration': {
        for (const spec of node.namedChildren) {
          if (spec.type !== 'type_spec') continue;
          const name = nameOf(spec);
          const t = spec.childForFieldName('type')?.type;
          const kind: SymbolKind = t === 'struct_type' ? 'struct' : t === 'interface_type' ? 'interface' : 'type';
          push(out, sym(name, kind, spec, goExported(name)));
        }
        break;
      }
      default:
        break;
    }
  }
}

function rustPublic(node: SyntaxNode): boolean {
  return node.namedChildren.some((c) => c.type === 'visibility_modifier');
}

function extractRust(root: SyntaxNode, out: CodeSymbol[]): void {
  const visit = (node: SyntaxNode, owner: string | null) => {
    switch (node.type) {
      case 'function_item':
      case 'function_signature_item': {
        const name = nameOf(node);
        push(out, sym(name ? (owner ? `${owner}.${name}` : name) : null, owner ? 'method' : 'function', node, rustPublic(node)));
        break;
      }
      case 'struct_item':
        push(out, sym(nameOf(node), 'struct', node, rustPublic(node)));
        break;
      case 'enum_item':
        push(out, sym(nameOf(node), 'enum', node, rustPublic(node)));
        break;
      case 'type_item':
        push(out, sym(nameOf(node), 'type', node, rustPublic(node)));
        break;
      case 'trait_item': {
        const name = nameOf(node);
        push(out, sym(name, 'trait', node, rustPublic(node)));
        const body = node.childForFieldName('body');
        if (name && body) for (const m of body.namedChildren) visit(m, name);
        break;
      }
      case 'impl_item': {
        const typeName = node.childForFieldName('type')?.text ?? null;
        const body = node.childForFieldName('body');
        if (typeName && body) for (const m of body.namedChildren) visit(m, typeName);
        break;
      }
      case 'mod_item': {
        const name = nameOf(node);
        push(out, sym(name, 'module', node, rustPublic(node)));
        const body = node.childForFieldName('body');
        if (name && body) for (const m of body.namedChildren) visit(m, name);
        break;
      }
      case 'const_item':
      case 'static_item':
        push(out, sym(nameOf(node), 'constant', node, rustPublic(node)));
        break;
      default:
        break;
    }
  };
  for (const child of root.namedChildren) visit(child, null);
}

const JAVA_TYPES = new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration']);

function javaPublic(node: SyntaxNode): boolean | undefined {
  const mods = node.namedChildren.find((c) => c.type === 'modifiers');
  return mods ? /\bpublic\b/.test(mods.text) : undefined;
}

function extractJava(root: SyntaxNode, out: CodeSymbol[]): void {
  const visit = (node: SyntaxNode, owner: string | null) => {
    if (JAVA_TYPES.has(node.type)) {
      const name = nameOf(node);
      const kind: SymbolKind = node.type === 'interface_declaration' ? 'interface' : node.type === 'enum_declaration' ? 'enum' : 'class';
      const full = name ? (owner ? `${owner}.${name}` : name) : null;
      push(out, sym(full, kind, node, javaPublic(node)));
      const body = node.childForFieldName('body');
      if (full && body) for (const m of body.namedChildren) visit(m, full);
    } else if ((node.type === 'method_declaration' || node.type === 'constructor_declaration') && owner) {
      const name = nameOf(node);
      push(out, sym(name ? `${owner}.${name}` : null, 'method', node, javaPublic(node)));
    }
  };
  for (const child of root.namedChildren) visit(child, null);
}

/** Symbols in one source text, for the given grammar. Pure apart from the parser. */
export async function extractSymbols(source: string, lang: GrammarLanguage): Promise<CodeSymbol[] | null> {
  const parser = await createParser(lang);
  if (!parser) return null;
  try {
    const tree = parser.parse(source);
    if (!tree) return [];
    const out: CodeSymbol[] = [];
    switch (lang) {
      case 'typescript':
      case 'tsx':
      case 'javascript':
      case 'jsx':
        extractTs(tree.rootNode, out);
        break;
      case 'python':
        extractPython(tree.rootNode, out);
        break;
      case 'go':
        extractGo(tree.rootNode, out);
        break;
      case 'rust':
        extractRust(tree.rootNode, out);
        break;
      case 'java':
        extractJava(tree.rootNode, out);
        break;
    }
    tree.delete?.();
    return out;
  } finally {
    parser.delete?.();
  }
}

// ── Walking a repo ───────────────────────────────────────────────

function* walkSourceFiles(root: string): Generator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile() && languageForFile(entry)) yield full;
    }
  }
}

/** Build the symbol index for a repository root. Never throws; caps make it bounded. */
export async function indexRepoSymbols(repoRoot: string, opts: IndexOptions = {}): Promise<RepoSymbolIndex> {
  const o = { ...DEFAULTS, ...opts };
  const files: FileSymbols[] = [];
  const skippedLanguages = new Set<string>();
  let fileCount = 0;
  let symbolCount = 0;
  let truncated = false;

  for (const full of walkSourceFiles(repoRoot)) {
    if (fileCount >= o.maxFiles || symbolCount >= o.maxSymbols) {
      truncated = true;
      break;
    }
    const lang = languageForFile(full)!;
    if (skippedLanguages.has(lang)) continue;
    let source: string;
    try {
      if (statSync(full).size > o.maxFileBytes) continue;
      source = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    const symbols = await extractSymbols(source, lang);
    if (symbols === null) {
      skippedLanguages.add(lang);
      continue;
    }
    fileCount += 1;
    if (symbols.length === 0) continue;
    const kept = symbols.slice(0, Math.max(0, o.maxSymbols - symbolCount));
    symbolCount += kept.length;
    files.push({ path: relative(repoRoot, full).split('\\').join('/'), language: lang, symbols: kept });
  }

  return { version: 1, indexedAt: new Date().toISOString(), files, fileCount, symbolCount, truncated, skippedLanguages: [...skippedLanguages] };
}

// ── Reading the index ────────────────────────────────────────────

export interface SymbolHit extends CodeSymbol {
  path: string;
}

/** Case-insensitive substring match on the symbol name; exact and prefix matches first. */
export function findSymbols(index: RepoSymbolIndex | null | undefined, query: string, opts: { kind?: SymbolKind; limit?: number } = {}): SymbolHit[] {
  if (!index) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const hits: { hit: SymbolHit; rank: number }[] = [];
  for (const file of index.files) {
    for (const s of file.symbols) {
      if (opts.kind && s.kind !== opts.kind) continue;
      const name = s.name.toLowerCase();
      const short = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
      let rank: number;
      if (short === q || name === q) rank = 0;
      else if (short.startsWith(q) || name.startsWith(q)) rank = 1;
      else if (name.includes(q)) rank = 2;
      else continue;
      hits.push({ hit: { ...s, path: file.path }, rank });
    }
  }
  return hits
    .sort((a, b) => a.rank - b.rank || a.hit.name.localeCompare(b.hit.name) || a.hit.path.localeCompare(b.hit.path))
    .slice(0, limit)
    .map((h) => h.hit);
}

/**
 * The outline a worker reads before opening files: one line per file with
 * its exported (or all, when the language cannot tell) symbol names, the
 * busiest files first, capped so it fits a tool result.
 */
export function outlineSymbols(index: RepoSymbolIndex | null | undefined, opts: { maxFiles?: number; maxPerFile?: number } = {}): string {
  if (!index || index.files.length === 0) return '';
  const maxFiles = opts.maxFiles ?? 60;
  const maxPerFile = opts.maxPerFile ?? 12;
  const ranked = [...index.files]
    .map((f) => {
      const visible = f.symbols.filter((s) => s.exported !== false);
      return { path: f.path, names: (visible.length > 0 ? visible : f.symbols).map((s) => s.name), total: f.symbols.length };
    })
    .sort((a, b) => b.total - a.total || a.path.localeCompare(b.path));
  const lines = ranked.slice(0, maxFiles).map((f) => {
    const shown = f.names.slice(0, maxPerFile);
    const more = f.names.length - shown.length;
    return `${f.path}: ${shown.join(', ')}${more > 0 ? ` (+${more})` : ''}`;
  });
  if (ranked.length > maxFiles) lines.push(`… ${ranked.length - maxFiles} more files (find_symbol searches all of them)`);
  return lines.join('\n');
}
