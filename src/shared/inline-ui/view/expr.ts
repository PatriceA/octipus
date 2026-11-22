/**
 * The expression language of a view (docs/plans/inline-ui-views-spec.md §2.5):
 * a tokenizer, a recursive-descent parser to an AST, and an evaluator with a
 * step budget. Never `eval`/`Function`: generated text is data here.
 *
 * Precedence, loosest first: `?:`, `||`, `&&`, `== !=`, `< <= > >=`, `+ -`,
 * `* / %`, unary `- !`, `^` (right-associative, so `-2^2` is -4), then
 * member access `.name` / `[expr]` and calls.
 */
import { INLINE_UI_VIEW_LIMITS } from '../limits';
import { type FormatOptions, formatCurrency, formatDate, formatNumber, formatPercent, isTruthy, toNumber, valueToText } from './format';
import { isJsonObject, jsonEqual, readProperty } from './json';
import type { JsonObject, JsonPrimitive, JsonValue } from './types';

/** A parse or evaluation error. `position` is a 0-based offset into `expression`. */
export class InlineUiExprError extends Error {
  readonly expression: string;
  readonly position: number;
  constructor(message: string, expression: string, position: number) {
    super(message);
    this.name = 'InlineUiExprError';
    this.expression = expression;
    this.position = position;
  }
}

/** What an expression sees. */
export interface ExprScope extends FormatOptions {
  data: JsonObject;
  computed: Record<string, string>;
  /** The template item, inside a template. */
  item?: JsonValue;
  index?: number;
  /** Absolute JSON Pointer of the template item, for relative paths. */
  itemPath?: string;
}

// ── Tokens ──────────────────────────────────────────────────────────────

export type ExprToken =
  | { type: 'number'; value: number; pos: number }
  | { type: 'string'; value: string; pos: number }
  | { type: 'name'; value: string; pos: number }
  | { type: 'op'; value: string; pos: number }
  | { type: 'eof'; pos: number };

const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '&&', '||']);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '%', '^', '!', '<', '>', '?', ':', '(', ')', '[', ']', '.', ',']);
const NUMBER_RE = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const NAME_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };

export function tokenizeExpression(source: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let i = 0;
  const fail = (message: string, at: number): never => { throw new InlineUiExprError(message, source, at); };
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(source);
      if (!m) return fail('bad number', i);
      tokens.push({ type: 'number', value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = i;
      let value = '';
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') {
          const next = source[i + 1];
          if (next === undefined) break;
          if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          value += ESCAPES[next] ?? next;
          i += 2;
          continue;
        }
        value += source[i++];
      }
      if (i >= source.length) return fail(`unclosed string starting with ${ch}`, start);
      i++;
      tokens.push({ type: 'string', value, pos: start });
      continue;
    }
    NAME_RE.lastIndex = i;
    const name = NAME_RE.exec(source);
    if (name) {
      tokens.push({ type: 'name', value: name[0], pos: i });
      i += name[0].length;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) { tokens.push({ type: 'op', value: two, pos: i }); i += 2; continue; }
    if (ONE_CHAR_OPS.has(ch)) { tokens.push({ type: 'op', value: ch, pos: i }); i++; continue; }
    if (ch === '=') return fail('use == to compare (there is no assignment)', i);
    if (ch === '&' || ch === '|') return fail(`use ${ch}${ch}`, i);
    return fail(`unexpected character "${ch}"`, i);
  }
  tokens.push({ type: 'eof', pos: source.length });
  return tokens;
}

// ── AST ─────────────────────────────────────────────────────────────────

export type ExprBinaryOp = '+' | '-' | '*' | '/' | '%' | '^' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||';

export type ExprNode =
  | { type: 'literal'; value: JsonPrimitive; pos: number }
  | { type: 'name'; name: string; pos: number }
  | { type: 'member'; object: ExprNode; property: ExprNode; pos: number }
  | { type: 'unary'; op: '-' | '!'; argument: ExprNode; pos: number }
  | { type: 'binary'; op: ExprBinaryOp; left: ExprNode; right: ExprNode; pos: number }
  | { type: 'conditional'; test: ExprNode; consequent: ExprNode; alternate: ExprNode; pos: number }
  | { type: 'call'; name: ExprFunctionName; args: ExprNode[]; pos: number };

// ── Functions ───────────────────────────────────────────────────────────

interface FnSpec {
  min: number;
  max: number;
  call: (args: JsonValue[], st: EvalState) => JsonValue;
}

/** Numbers of a call's arguments, or of its one list argument; non-numbers are skipped. */
function numbersOf(args: JsonValue[], st: EvalState): number[] {
  const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  spend(st, list.length);
  return list.map(toNumber).filter((n) => !Number.isNaN(n));
}

function listValues(list: JsonValue, key: JsonValue | undefined, st: EvalState): number[] {
  if (!Array.isArray(list)) return [];
  spend(st, list.length);
  const k = key === undefined || key === null ? undefined : valueToText(key);
  return list.map((item) => toNumber(k === undefined ? item : readProperty(item, k))).filter((n) => !Number.isNaN(n));
}

const optDigits = (v: JsonValue | undefined): number | undefined => (v === undefined || v === null ? undefined : toNumber(v));

const FUNCTIONS = {
  min: { min: 1, max: 50, call: (a, st) => { const n = numbersOf(a, st); return n.length ? Math.min(...n) : Number.NaN; } },
  max: { min: 1, max: 50, call: (a, st) => { const n = numbersOf(a, st); return n.length ? Math.max(...n) : Number.NaN; } },
  round: {
    min: 1, max: 2, call: ([x, d]) => {
      const digits = Math.max(0, Math.min(10, Math.trunc(optDigits(d) ?? 0)));
      const f = 10 ** digits;
      return Math.round(toNumber(x) * f) / f;
    },
  },
  floor: { min: 1, max: 1, call: ([x]) => Math.floor(toNumber(x)) },
  ceil: { min: 1, max: 1, call: ([x]) => Math.ceil(toNumber(x)) },
  abs: { min: 1, max: 1, call: ([x]) => Math.abs(toNumber(x)) },
  sqrt: { min: 1, max: 1, call: ([x]) => Math.sqrt(toNumber(x)) },
  pow: { min: 2, max: 2, call: ([x, y]) => toNumber(x) ** toNumber(y) },
  sum: { min: 1, max: 2, call: ([list, key], st) => listValues(list, key, st).reduce((s, n) => s + n, 0) },
  avg: { min: 1, max: 2, call: ([list, key], st) => { const n = listValues(list, key, st); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : Number.NaN; } },
  count: { min: 1, max: 1, call: ([list]) => (Array.isArray(list) ? list.length : 0) },
  len: { min: 1, max: 1, call: ([x]) => (typeof x === 'string' || Array.isArray(x) ? x.length : isJsonObject(x) ? Object.keys(x).length : 0) },
  // `if` is evaluated lazily in `evaluateNode`; this entry gives its arity.
  if: { min: 3, max: 3, call: ([c, a, b]) => (isTruthy(c) ? a : b) },
  contains: {
    min: 2, max: 2, call: ([x, v], st) => {
      if (typeof x === 'string') return x.includes(valueToText(v, st.scope));
      if (!Array.isArray(x)) return false;
      spend(st, x.length);
      return x.some((item) => jsonEqual(item, v));
    },
  },
  lower: { min: 1, max: 1, call: ([x], st) => valueToText(x, st.scope).toLowerCase() },
  upper: { min: 1, max: 1, call: ([x], st) => valueToText(x, st.scope).toUpperCase() },
  formatNumber: { min: 1, max: 2, call: ([x, d], st) => formatNumber(x, optDigits(d), st.scope) },
  formatCurrency: { min: 2, max: 2, call: ([x, code], st) => formatCurrency(x, valueToText(code), st.scope) },
  formatPercent: { min: 1, max: 2, call: ([x, d], st) => formatPercent(x, optDigits(d) ?? 0, st.scope) },
  formatDate: { min: 1, max: 2, call: ([x, style], st) => formatDate(x, style === undefined || style === null ? 'medium' : valueToText(style), st.scope) },
} satisfies Record<string, FnSpec>;

export type ExprFunctionName = keyof typeof FUNCTIONS;
export const INLINE_UI_EXPR_FUNCTIONS = Object.keys(FUNCTIONS) as ExprFunctionName[];

function isFunctionName(name: string): name is ExprFunctionName {
  return Object.hasOwn(FUNCTIONS, name);
}

/** Words that cannot name a computed value. */
export const INLINE_UI_RESERVED_NAMES: ReadonlySet<string> = new Set(['true', 'false', 'null', ...INLINE_UI_EXPR_FUNCTIONS]);

// ── Parser ──────────────────────────────────────────────────────────────

const COMPARISON_OPS = new Set(['<', '<=', '>', '>=']);

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly source: string, private readonly tokens: ExprToken[]) {}

  parse(): ExprNode {
    const node = this.ternary();
    const t = this.peek();
    if (t.type !== 'eof') this.fail(`unexpected ${describeToken(t)}`, t.pos);
    return node;
  }

  private peek(): ExprToken { return this.tokens[this.i]; }
  private next(): ExprToken { return this.tokens[this.i++]; }
  private isOp(value: string): boolean { const t = this.peek(); return t.type === 'op' && t.value === value; }
  private fail(message: string, pos: number): never { throw new InlineUiExprError(message, this.source, pos); }

  private expectOp(value: string): void {
    const t = this.next();
    if (t.type !== 'op' || t.value !== value) this.fail(`expected "${value}" but found ${describeToken(t)}`, t.pos);
  }

  /** Enter one level of nesting; the bound keeps the evaluator's recursion shallow too. */
  private nest<T>(pos: number, f: () => T): T {
    if (++this.depth > INLINE_UI_VIEW_LIMITS.exprDepth) this.fail(`nested more than ${INLINE_UI_VIEW_LIMITS.exprDepth} levels deep`, pos);
    const out = f();
    this.depth--;
    return out;
  }

  private ternary(): ExprNode {
    const test = this.binary(0);
    if (!this.isOp('?')) return test;
    const pos = this.next().pos;
    return this.nest(pos, () => {
      const consequent = this.ternary();
      this.expectOp(':');
      const alternate = this.ternary();
      return { type: 'conditional', test, consequent, alternate, pos };
    });
  }

  /** Binary levels, loosest first; every level is left-associative. */
  private static readonly LEVELS: ReadonlyArray<(op: string) => boolean> = [
    (op) => op === '||',
    (op) => op === '&&',
    (op) => op === '==' || op === '!=',
    (op) => COMPARISON_OPS.has(op),
    (op) => op === '+' || op === '-',
    (op) => op === '*' || op === '/' || op === '%',
  ];

  private binary(level: number): ExprNode {
    if (level >= Parser.LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || !Parser.LEVELS[level](t.value)) return left;
      this.next();
      const right = this.binary(level + 1);
      left = { type: 'binary', op: t.value as ExprBinaryOp, left, right, pos: t.pos };
    }
  }

  private unary(): ExprNode {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '!')) {
      this.next();
      return this.nest(t.pos, () => ({ type: 'unary', op: t.value as '-' | '!', argument: this.unary(), pos: t.pos }));
    }
    return this.power();
  }

  private power(): ExprNode {
    const base = this.postfix();
    if (!this.isOp('^')) return base;
    const pos = this.next().pos;
    return this.nest(pos, () => ({ type: 'binary', op: '^', left: base, right: this.unary(), pos }));
  }

  private postfix(): ExprNode {
    let node = this.primary();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op') return node;
      if (t.value === '.') {
        this.next();
        const name = this.next();
        if (name.type !== 'name') this.fail(`expected a property name after "." but found ${describeToken(name)}`, name.pos);
        node = { type: 'member', object: node, property: { type: 'literal', value: name.value, pos: name.pos }, pos: t.pos };
      } else if (t.value === '[') {
        this.next();
        const property = this.nest(t.pos, () => this.ternary());
        this.expectOp(']');
        node = { type: 'member', object: node, property, pos: t.pos };
      } else if (t.value === '(') {
        this.fail('only the built-in functions can be called', t.pos);
      } else {
        return node;
      }
    }
  }

  private primary(): ExprNode {
    const t = this.next();
    switch (t.type) {
      case 'number': return { type: 'literal', value: t.value, pos: t.pos };
      case 'string': return { type: 'literal', value: t.value, pos: t.pos };
      case 'name': {
        if (t.value === 'true' || t.value === 'false') return { type: 'literal', value: t.value === 'true', pos: t.pos };
        if (t.value === 'null') return { type: 'literal', value: null, pos: t.pos };
        if (!this.isOp('(')) return { type: 'name', name: t.value, pos: t.pos };
        if (!isFunctionName(t.value)) this.fail(`unknown function ${t.value}(); the functions are ${INLINE_UI_EXPR_FUNCTIONS.join(', ')}`, t.pos);
        return this.call(t.value, t.pos);
      }
      case 'op':
        if (t.value === '(') {
          const inner = this.nest(t.pos, () => this.ternary());
          this.expectOp(')');
          return inner;
        }
        return this.fail(`unexpected ${describeToken(t)}`, t.pos);
      case 'eof':
        return this.fail('the expression ends too early', t.pos);
    }
  }

  private call(name: ExprFunctionName, pos: number): ExprNode {
    this.expectOp('(');
    const args: ExprNode[] = [];
    this.nest(pos, () => {
      if (this.isOp(')')) return;
      for (;;) {
        args.push(this.ternary());
        if (!this.isOp(',')) return;
        this.next();
      }
    });
    this.expectOp(')');
    const spec: FnSpec = FUNCTIONS[name];
    if (args.length < spec.min || args.length > spec.max) {
      const want = spec.min === spec.max ? `${spec.min}` : spec.max >= 50 ? `at least ${spec.min}` : `${spec.min} or ${spec.max}`;
      this.fail(`${name}() takes ${want} argument${want === '1' ? '' : 's'}, not ${args.length}`, pos);
    }
    return { type: 'call', name, args, pos };
  }
}

function describeToken(t: ExprToken): string {
  if (t.type === 'eof') return 'the end of the expression';
  if (t.type === 'string') return 'a string';
  return `"${t.value}"`;
}

const parsed = new Map<string, ExprNode | InlineUiExprError>();
const MAX_CACHED_PARSES = 1_000;

/** Parse an expression; throws `InlineUiExprError` with the position of the problem. Results are cached. */
export function parseExpression(source: string): ExprNode {
  const hit = parsed.get(source);
  if (hit instanceof InlineUiExprError) throw hit;
  if (hit) return hit;
  let result: ExprNode | InlineUiExprError;
  if (source.length > INLINE_UI_VIEW_LIMITS.exprChars) {
    result = new InlineUiExprError(`the expression is ${source.length} characters; the limit is ${INLINE_UI_VIEW_LIMITS.exprChars}`, source, INLINE_UI_VIEW_LIMITS.exprChars);
  } else if (!source.trim()) {
    result = new InlineUiExprError('the expression is empty', source, 0);
  } else {
    try {
      result = new Parser(source, tokenizeExpression(source)).parse();
    } catch (err) {
      if (!(err instanceof InlineUiExprError)) throw err;
      result = err;
    }
  }
  if (parsed.size >= MAX_CACHED_PARSES) parsed.clear();
  parsed.set(source, result);
  if (result instanceof InlineUiExprError) throw result;
  return result;
}

/** The names an expression reads at its top level (`a` in `a.b[c]` and `c`); `$item`/`$index` included. */
export function expressionNames(node: ExprNode): string[] {
  const names = new Set<string>();
  const walk = (n: ExprNode): void => {
    switch (n.type) {
      case 'name': names.add(n.name); break;
      case 'member': walk(n.object); walk(n.property); break;
      case 'unary': walk(n.argument); break;
      case 'binary': walk(n.left); walk(n.right); break;
      case 'conditional': walk(n.test); walk(n.consequent); walk(n.alternate); break;
      case 'call': n.args.forEach(walk); break;
      case 'literal': break;
    }
  };
  walk(node);
  return [...names];
}

/**
 * A cycle among computed names (`['a', 'b', 'a']`), or null. Entries that do
 * not parse are skipped: the lint reports them on their own.
 */
export function findComputedCycle(computed: Record<string, string>): string[] | null {
  const edges = new Map<string, string[]>();
  for (const [name, source] of Object.entries(computed)) {
    let refs: string[] = [];
    try {
      refs = expressionNames(parseExpression(source)).filter((r) => Object.hasOwn(computed, r));
    } catch (err) {
      if (!(err instanceof InlineUiExprError)) throw err;
    }
    edges.set(name, refs);
  }
  const state = new Map<string, 'active' | 'done'>();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    if (state.get(name) === 'done') return null;
    if (state.get(name) === 'active') return [...path.slice(path.indexOf(name)), name];
    state.set(name, 'active');
    path.push(name);
    for (const ref of edges.get(name) ?? []) {
      const cycle = visit(ref);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(name, 'done');
    return null;
  };
  for (const name of edges.keys()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

// ── Evaluator ───────────────────────────────────────────────────────────

interface EvalState {
  source: string;
  steps: number;
  scope: ExprScope;
  /** Computed values of this evaluation: each is evaluated once. */
  memo: Map<string, JsonValue>;
  active: Set<string>;
}

function spend(st: EvalState, n: number): void {
  st.steps += n;
  if (st.steps > INLINE_UI_VIEW_LIMITS.exprSteps) {
    throw new InlineUiExprError(`the expression took more than ${INLINE_UI_VIEW_LIMITS.exprSteps} steps`, st.source, 0);
  }
}

function lookupName(name: string, node: ExprNode, scope: ExprScope, st: EvalState): JsonValue {
  if (name === '$item') return scope.item ?? null;
  if (name === '$index') return scope.index ?? null;
  if (Object.hasOwn(scope.computed, name) && typeof scope.computed[name] === 'string') return computedValue(name, node, st);
  const fromItem = readProperty(scope.item, name);
  if (fromItem !== undefined) return fromItem;
  return readProperty(scope.data, name) ?? null;
}

/** A computed name sees the data model and other computed names, never a template item, so it has one value per evaluation. */
function computedValue(name: string, node: ExprNode, st: EvalState): JsonValue {
  const memo = st.memo.get(name);
  if (memo !== undefined) return memo;
  if (st.active.has(name)) throw new InlineUiExprError(`computed "${name}" refers to itself (${[...st.active, name].join(' → ')})`, st.source, node.pos);
  st.active.add(name);
  const source = st.scope.computed[name];
  let ast: ExprNode;
  try {
    ast = parseExpression(source);
  } catch (err) {
    if (!(err instanceof InlineUiExprError)) throw err;
    throw new InlineUiExprError(`computed "${name}": ${err.message}`, st.source, node.pos);
  }
  const value = evaluateNode(ast, { data: st.scope.data, computed: st.scope.computed }, st);
  st.active.delete(name);
  st.memo.set(name, value);
  return value;
}

function compare(op: string, a: JsonValue, b: JsonValue): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  }
  const x = toNumber(a);
  const y = toNumber(b);
  return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
}

function evaluateNode(node: ExprNode, scope: ExprScope, st: EvalState): JsonValue {
  spend(st, 1);
  switch (node.type) {
    case 'literal': return node.value;
    case 'name': return lookupName(node.name, node, scope, st);
    case 'member': {
      const object = evaluateNode(node.object, scope, st);
      const key = evaluateNode(node.property, scope, st);
      if (typeof key !== 'string' && typeof key !== 'number') return null;
      return readProperty(object, key) ?? null;
    }
    case 'unary': {
      const v = evaluateNode(node.argument, scope, st);
      return node.op === '!' ? !isTruthy(v) : -toNumber(v);
    }
    case 'conditional':
      return isTruthy(evaluateNode(node.test, scope, st)) ? evaluateNode(node.consequent, scope, st) : evaluateNode(node.alternate, scope, st);
    case 'binary': {
      if (node.op === '&&' || node.op === '||') {
        const left = evaluateNode(node.left, scope, st);
        if (node.op === '&&' ? !isTruthy(left) : isTruthy(left)) return left;
        return evaluateNode(node.right, scope, st);
      }
      const a = evaluateNode(node.left, scope, st);
      const b = evaluateNode(node.right, scope, st);
      switch (node.op) {
        case '+':
          return typeof a === 'string' || typeof b === 'string' ? valueToText(a, scope) + valueToText(b, scope) : toNumber(a) + toNumber(b);
        case '-': return toNumber(a) - toNumber(b);
        case '*': return toNumber(a) * toNumber(b);
        case '/': return toNumber(a) / toNumber(b);
        case '%': return toNumber(a) % toNumber(b);
        case '^': return toNumber(a) ** toNumber(b);
        case '==': return jsonEqual(a, b);
        case '!=': return !jsonEqual(a, b);
        default: return compare(node.op, a, b);
      }
    }
    case 'call': {
      if (node.name === 'if') {
        const [c, a, b] = node.args;
        return isTruthy(evaluateNode(c, scope, st)) ? evaluateNode(a, scope, st) : evaluateNode(b, scope, st);
      }
      const args = node.args.map((arg) => evaluateNode(arg, scope, st));
      const spec: FnSpec = FUNCTIONS[node.name];
      try {
        return spec.call(args, st);
      } catch (err) {
        // The formatters refuse bad codes and styles with a RangeError; give it the expression's position.
        if (err instanceof RangeError) throw new InlineUiExprError(`${node.name}(): ${err.message}`, st.source, node.pos);
        throw err;
      }
    }
  }
}

/**
 * Evaluate an expression (source or parsed). Throws `InlineUiExprError` for a
 * parse error, a computed cycle, a bad format argument or an exhausted step
 * budget. Unknown names are null.
 */
export function evaluateExpression(expression: string | ExprNode, scope: ExprScope): JsonValue {
  const source = typeof expression === 'string' ? expression : '';
  const ast = typeof expression === 'string' ? parseExpression(expression) : expression;
  return evaluateNode(ast, scope, { source, steps: 0, scope, memo: new Map(), active: new Set() });
}

// ── Interpolation ───────────────────────────────────────────────────────

/** A text split into literal parts and `${…}` expressions; `start` is the offset of the expression source in the text. */
export type InterpolationPart = string | { source: string; start: number; ast: ExprNode };

/**
 * Split a text at its `${…}` expressions. `\${` is a literal `${`; other
 * backslashes are kept. A `}` inside a quoted string does not end the
 * expression. Throws `InlineUiExprError` (position in the text) for an
 * unclosed or invalid expression.
 */
export function parseInterpolation(text: string): InterpolationPart[] {
  const parts: InterpolationPart[] = [];
  let literal = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('\\${', i)) { literal += '${'; i += 3; continue; }
    if (!text.startsWith('${', i)) { literal += text[i++]; continue; }
    const start = i + 2;
    let j = start;
    let quote = '';
    for (; j < text.length; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = '';
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === '}') {
        break;
      }
    }
    if (j >= text.length) throw new InlineUiExprError('"${" without its closing "}" (write \\${ for a literal ${)', text, i);
    const source = text.slice(start, j);
    let ast: ExprNode;
    try {
      ast = parseExpression(source);
    } catch (err) {
      if (!(err instanceof InlineUiExprError)) throw err;
      throw new InlineUiExprError(err.message, text, start + err.position);
    }
    if (literal) parts.push(literal);
    literal = '';
    parts.push({ source, start, ast });
    i = j + 1;
  }
  if (literal) parts.push(literal);
  return parts;
}

/** Replace each `${expr}` with its value as text (`valueToText`). Throws like `parseInterpolation` and `evaluateExpression`. */
export function interpolate(text: string, scope: ExprScope): string {
  if (!text.includes('${')) return text;
  const st: EvalState = { source: text, steps: 0, scope, memo: new Map(), active: new Set() };
  return parseInterpolation(text).map((part) => (typeof part === 'string' ? part : valueToText(evaluateNode(part.ast, scope, st), scope))).join('');
}
