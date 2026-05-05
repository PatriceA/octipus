/**
 * Pattern-based syntax highlighting.
 *
 * Pure-function tokenizer for a small set of languages. Returns an
 * array of `[text, tokenKind]` pairs covering the full input line
 * — kinds map to color tokens in `theme.syntax`.
 *
 * Not a full lexer: nested template strings, regex literals, and
 * other corner cases get the "keyword wins" cheap behavior. Good
 * enough for visual differentiation; tree-sitter slots in here
 * later if we need real parsing.
 */

import type { Language } from './lang';

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'type'
  | 'operator'
  | 'punctuation';

export interface Token {
  text: string;
  kind: TokenKind;
}

interface Rule {
  pattern: RegExp;
  kind: TokenKind;
}

const TS_KEYWORDS = /\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|is|let|new|null|of|package|private|protected|public|readonly|return|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\b/g;

const TS_TYPES = /\b(?:string|number|boolean|any|never|unknown|object|void|null|undefined|Promise|Array|Map|Set|Record|Partial|Readonly|Pick|Omit)\b/g;

const SHELL_KEYWORDS = /\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|export|local|alias|set|unset|read|echo|printf|exit|true|false)\b/g;

const PY_KEYWORDS = /\b(?:def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|pass|break|continue|raise|yield|lambda|global|nonlocal|True|False|None|and|or|not|is|in)\b/g;

const RUST_KEYWORDS = /\b(?:fn|let|mut|const|pub|use|mod|crate|self|super|impl|trait|struct|enum|match|if|else|loop|while|for|in|return|break|continue|true|false|as|where|move|async|await|dyn|ref|type|unsafe|extern|static)\b/g;

const GO_KEYWORDS = /\b(?:func|var|const|package|import|type|struct|interface|map|chan|return|if|else|for|range|switch|case|default|select|go|defer|break|continue|fallthrough|goto|nil|true|false)\b/g;

// Common across many: numbers, single + double + backtick strings, line + block comments, function calls.
const NUMBER = /\b\d+(?:\.\d+)?\b/g;
const STRING_DQ = /"(?:[^"\\\n]|\\.)*"/g;
const STRING_SQ = /'(?:[^'\\\n]|\\.)*'/g;
const STRING_BT = /`(?:[^`\\]|\\.)*`/g;
const LINE_COMMENT_DOUBLESLASH = /\/\/[^\n]*/g;
const LINE_COMMENT_HASH = /#[^\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const FUNCTION_CALL = /([A-Za-z_][A-Za-z0-9_]*)\s*(?=\()/g;
const PUNCT = /[{}()[\];,]/g;
const OPERATOR = /[=+\-*/%<>!&|^~?:]+/g;

function rulesFor(lang: Language): Rule[] {
  // Order matters — earlier rules win on overlap.
  const common: Rule[] = [
    { pattern: BLOCK_COMMENT, kind: 'comment' },
    { pattern: LINE_COMMENT_DOUBLESLASH, kind: 'comment' },
    { pattern: STRING_BT, kind: 'string' },
    { pattern: STRING_DQ, kind: 'string' },
    { pattern: STRING_SQ, kind: 'string' },
    { pattern: NUMBER, kind: 'number' },
  ];
  switch (lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      return [
        ...common,
        { pattern: TS_KEYWORDS, kind: 'keyword' },
        { pattern: TS_TYPES, kind: 'type' },
        { pattern: FUNCTION_CALL, kind: 'function' },
        { pattern: OPERATOR, kind: 'operator' },
        { pattern: PUNCT, kind: 'punctuation' },
      ];
    case 'shell':
      return [
        { pattern: LINE_COMMENT_HASH, kind: 'comment' },
        { pattern: STRING_DQ, kind: 'string' },
        { pattern: STRING_SQ, kind: 'string' },
        { pattern: NUMBER, kind: 'number' },
        { pattern: SHELL_KEYWORDS, kind: 'keyword' },
        { pattern: OPERATOR, kind: 'operator' },
        { pattern: PUNCT, kind: 'punctuation' },
      ];
    case 'python':
      return [
        { pattern: LINE_COMMENT_HASH, kind: 'comment' },
        { pattern: STRING_DQ, kind: 'string' },
        { pattern: STRING_SQ, kind: 'string' },
        { pattern: NUMBER, kind: 'number' },
        { pattern: PY_KEYWORDS, kind: 'keyword' },
        { pattern: FUNCTION_CALL, kind: 'function' },
        { pattern: OPERATOR, kind: 'operator' },
        { pattern: PUNCT, kind: 'punctuation' },
      ];
    case 'rust':
      return [
        ...common,
        { pattern: RUST_KEYWORDS, kind: 'keyword' },
        { pattern: FUNCTION_CALL, kind: 'function' },
        { pattern: OPERATOR, kind: 'operator' },
        { pattern: PUNCT, kind: 'punctuation' },
      ];
    case 'go':
      return [
        ...common,
        { pattern: GO_KEYWORDS, kind: 'keyword' },
        { pattern: FUNCTION_CALL, kind: 'function' },
        { pattern: OPERATOR, kind: 'operator' },
        { pattern: PUNCT, kind: 'punctuation' },
      ];
    case 'json':
      return [
        { pattern: STRING_DQ, kind: 'string' },
        { pattern: NUMBER, kind: 'number' },
        { pattern: /\b(?:true|false|null)\b/g, kind: 'keyword' },
        { pattern: PUNCT, kind: 'punctuation' },
      ];
    case 'markdown':
      return [
        { pattern: /^#{1,6}\s.*/gm, kind: 'keyword' },
        { pattern: /`[^`\n]+`/g, kind: 'string' },
        { pattern: /\*\*[^*\n]+\*\*/g, kind: 'function' },
        { pattern: /^\s*[-*+]\s/gm, kind: 'operator' },
      ];
    case 'yaml':
      return [
        { pattern: LINE_COMMENT_HASH, kind: 'comment' },
        { pattern: STRING_DQ, kind: 'string' },
        { pattern: STRING_SQ, kind: 'string' },
        { pattern: /^[ \t]*[A-Za-z_][A-Za-z0-9_-]*(?=:)/gm, kind: 'keyword' },
        { pattern: NUMBER, kind: 'number' },
      ];
    default:
      return [];
  }
}

/**
 * Tokenize a single line. Returns the input split into adjacent
 * spans whose `kind` covers the full line — concatenating
 * `tokens.map(t => t.text)` reproduces the input.
 */
export function highlightLine(line: string, lang: Language): Token[] {
  const rules = rulesFor(lang);
  if (rules.length === 0) return [{ text: line, kind: 'plain' }];

  // Mark every position with its winning rule (first-rule-wins).
  const marks: (TokenKind | null)[] = new Array(line.length).fill(null);
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(line)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      for (let i = start; i < end; i++) {
        if (marks[i] === null) marks[i] = rule.kind;
      }
      if (m[0].length === 0) rule.pattern.lastIndex++; // safety on zero-width matches
    }
  }

  // Coalesce consecutive same-kind chars into spans.
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

// ─────────────────────────────────────────────────────────────────
// Pluggable highlighter — tree-sitter slot
// ─────────────────────────────────────────────────────────────────
//
// `highlightLine` is the default highlighter (pattern-based). To
// swap in a real parser (tree-sitter, textmate grammars, etc.):
//
//   import { setHighlighter } from '@/tui-editor/editor/highlight';
//   setHighlighter((line, lang) => myParserBackedHighlight(line, lang));
//
// The contract is the same single-line `(line, lang) => Token[]`
// shape so the editor's render path doesn't need to know which
// implementation it's calling. A future tree-sitter integration
// would build per-language grammars (loaded via `web-tree-sitter`)
// and tokenize via incremental parses across edits — for now the
// pattern-based default is good enough for visual differentiation
// and ships zero new dependencies.
//
// Limitations of the pattern-based default (acknowledged):
//   - No nested template-string parsing.
//   - Single-line scope — block comments that span lines are only
//     correctly highlighted on the line containing the opener.
//   - No JSX tag highlighting (no syntax distinction between
//     `<Foo>` and a comparison).
//
// The interface below lets a tree-sitter or LSP-backed
// implementation slot in without touching every consumer.

export type HighlighterFn = (line: string, lang: Language) => Token[];

let activeHighlighter: HighlighterFn = highlightLine;

/**
 * Replace the active highlighter. Called once at app start by
 * whichever module wires the parser of choice; the TextEditor
 * component reads through `highlight()`.
 */
export function setHighlighter(fn: HighlighterFn): void {
  activeHighlighter = fn;
}

/** Reset to the built-in pattern-based highlighter. */
export function resetHighlighter(): void {
  activeHighlighter = highlightLine;
}

/** Highlight a single line with whichever implementation is active. */
export function highlight(line: string, lang: Language): Token[] {
  return activeHighlighter(line, lang);
}
