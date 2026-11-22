import { describe, expect, it } from 'vitest';
import {
  evaluateExpression,
  findComputedCycle,
  formatDate,
  INLINE_UI_VIEW_LIMITS,
  InlineUiExprError,
  interpolate,
  parseExpression,
  parseInterpolation,
  tokenizeExpression,
  valueToText,
  type ExprScope,
  type JsonObject,
} from '../index';

const scope = (data: JsonObject = {}, computed: Record<string, string> = {}, extra: Partial<ExprScope> = {}): ExprScope => ({ data, computed, ...extra });
const ev = (src: string, data: JsonObject = {}, computed: Record<string, string> = {}, extra: Partial<ExprScope> = {}) => evaluateExpression(src, scope(data, computed, extra));

function parseError(src: string): InlineUiExprError {
  try {
    parseExpression(src);
  } catch (err) {
    if (err instanceof InlineUiExprError) return err;
    throw err;
  }
  throw new Error(`"${src}" parsed`);
}

describe('expression tokenizer and parser', () => {
  it('tokenizes numbers, strings with escapes, names and operators', () => {
    expect(tokenizeExpression("1.5e2 'a\\'b' plan.price >= !").map((t) => t.type === 'eof' ? 'eof' : t.value)).toEqual([150, "a'b", 'plan', '.', 'price', '>=', '!', 'eof']);
  });

  it('reports the position of a problem', () => {
    expect(parseError('price * ').position).toBe(8);
    expect(parseError('a = 1')).toMatchObject({ position: 2, message: expect.stringContaining('==') });
    expect(parseError('(1 + 2').message).toContain('expected ")"');
    expect(parseError("'open").position).toBe(0);
    expect(parseError('1 2').message).toContain('unexpected "2"');
    expect(parseError('a # b').message).toContain('unexpected character');
  });

  it('refuses unknown functions, wrong arity and calls on anything else', () => {
    expect(parseError('eval(1)').message).toContain('unknown function eval()');
    expect(parseError('constructor(1)').message).toContain('unknown function');
    expect(parseError('round()').message).toContain('round() takes 1 or 2 arguments, not 0');
    expect(parseError('if(1, 2)').message).toContain('takes 3 arguments');
    expect(parseError('a.b(1)').message).toContain('only the built-in functions');
  });

  it('bounds length and nesting', () => {
    expect(parseError('1+'.repeat(300) + '1').message).toContain(`limit is ${INLINE_UI_VIEW_LIMITS.exprChars}`);
    expect(parseError(`${'('.repeat(40)}1${')'.repeat(40)}`).message).toContain('nested more than 32');
    expect(parseError('-'.repeat(40) + '1').message).toContain('nested');
    expect(() => parseExpression(`${'('.repeat(30)}1${')'.repeat(30)}`)).not.toThrow();
    expect(parseError('  ').message).toContain('empty');
  });
});

describe('expression evaluation', () => {
  it('follows precedence and associativity', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 - 4 - 3')).toBe(3);
    expect(ev('2 ^ 3 ^ 2')).toBe(512);
    expect(ev('-2 ^ 2')).toBe(-4);
    expect(ev('2 ^ -1')).toBe(0.5);
    expect(ev('7 % 3 * 2')).toBe(2);
    expect(ev('1 < 2 == true')).toBe(true);
    expect(ev('true || false && false')).toBe(true);
    expect(ev('1 > 2 ? 1 : 2 > 1 ? 3 : 4')).toBe(3);
    expect(ev('!0 && !!1')).toBe(true);
  });

  it('concatenates with a string and compares structurally', () => {
    expect(ev("'n=' + 1 + 2")).toBe('n=12');
    expect(ev("1 + 2 + '!'")).toBe('3!');
    expect(ev('a == b', { a: [1, { x: 2 }], b: [1, { x: 2 }] })).toBe(true);
    expect(ev("'b' > 'a'")).toBe(true);
    expect(ev("'10' > 9")).toBe(true);
    expect(ev('null + 1')).toBeNaN();
    expect(ev('1 / 0')).toBe(Number.POSITIVE_INFINITY);
  });

  it('short-circuits and returns operands like JavaScript', () => {
    expect(ev("name || 'anon'")).toBe('anon');
    expect(ev("name && name.first", { name: { first: 'A' } })).toBe('A');
    expect(ev('if(true, 1, missing.deep)')).toBe(1);
  });

  it('resolves computed names, then the template item, then data', () => {
    const data = { price: 10, qty: 3, name: 'data', plans: [{ name: 'S', price: 5 }] };
    expect(ev('total', data, { total: 'price * qty' })).toBe(30);
    expect(ev('name', data, {}, { item: { name: 'item' } })).toBe('item');
    expect(ev('name', data, { name: "'computed'" }, { item: { name: 'item' } })).toBe('computed');
    expect(ev('$item.price + $index', data, {}, { item: { price: 5 }, index: 2 })).toBe(7);
    expect(ev('plans[0].name')).toBeNull();
    expect(ev('plans[0].name', data)).toBe('S');
    expect(ev("plans[0]['price']", data)).toBe(5);
    expect(ev('plans.length + len(plans)', data)).toBe(2);
    expect(ev('nothing.here')).toBeNull();
  });

  it('gives a computed name no template item and evaluates it once', () => {
    expect(ev('label', { name: 'data' }, { label: 'name' }, { item: { name: 'item' } })).toBe('data');
    // 20 names each reading the previous twice: exponential without memoization.
    const computed: Record<string, string> = { c0: '1' };
    for (let i = 1; i < 20; i++) computed[`c${i}`] = `c${i - 1} + c${i - 1}`;
    expect(ev('c19', {}, computed)).toBe(2 ** 19);
  });

  it('detects computed cycles statically and at evaluation', () => {
    expect(findComputedCycle({ a: 'b + 1', b: 'c', c: 'a' })).toEqual(['a', 'b', 'c', 'a']);
    expect(findComputedCycle({ a: 'a' })).toEqual(['a', 'a']);
    expect(findComputedCycle({ a: 'b', b: '1', c: 'a + b' })).toBeNull();
    expect(() => ev('a', {}, { a: 'b', b: 'a' })).toThrow(/refers to itself/);
  });

  it('never reads through the prototype chain', () => {
    expect(ev('constructor')).toBeNull();
    expect(ev('constructor.constructor')).toBeNull();
    expect(() => parseExpression("constructor.constructor('return 1')")).toThrow(/only the built-in functions/);
    expect(ev('__proto__', { a: 1 })).toBeNull();
    expect(ev("a['__proto__']", { a: {} })).toBeNull();
    expect(ev("a['constructor']['prototype']", { a: {} })).toBeNull();
    expect(ev('toString')).toBeNull();
    expect(ev('a.hasOwnProperty', { a: {} })).toBeNull();
    expect(ev('s.length', { s: 'abc' })).toBe(3);
    expect(ev('s.charAt', { s: 'abc' })).toBeNull();
    const own = JSON.parse('{"__proto__": {"x": 1}}') as JsonObject;
    expect(ev('__proto__.x', own)).toBeNull();
  });

  it('enforces the step budget', () => {
    const big = { list: Array.from({ length: INLINE_UI_VIEW_LIMITS.exprSteps }, (_, i) => i) };
    expect(() => ev('sum(list) + sum(list)', big)).toThrow(/steps/);
    expect(ev('count(list)', big)).toBe(INLINE_UI_VIEW_LIMITS.exprSteps);
  });

  it('implements the function table', () => {
    const data = { rows: [{ v: 1 }, { v: 2 }, { v: 'x' }, { v: 3 }], nums: [4, 1, 9] };
    expect(ev('min(3, 1, 2)')).toBe(1);
    expect(ev('max(nums)', data)).toBe(9);
    expect(ev('round(2.345, 2)')).toBe(2.35);
    expect(ev('round(2.5)')).toBe(3);
    expect(ev('floor(-1.5) + ceil(1.2) + abs(-3) + sqrt(16) + pow(2, 3)')).toBe(-2 + 2 + 3 + 4 + 8);
    expect(ev("sum(rows, 'v')", data)).toBe(6);
    expect(ev("avg(rows, 'v')", data)).toBe(2);
    expect(ev('avg(missing)')).toBeNaN();
    expect(ev('count(rows) + len("abc") + len(rows[0])', data)).toBe(4 + 3 + 1);
    expect(ev('contains(nums, 9) && contains("hello", "ell") && !contains(nums, 2)', data)).toBe(true);
    expect(ev("upper('a') + lower('B')")).toBe('Ab');
    expect(ev('formatNumber(1234.5, 2)')).toBe('1,234.50');
    expect(ev("formatCurrency(12.5, 'eur')")).toBe('€12.50');
    expect(ev('formatPercent(0.256, 1)')).toBe('25.6%');
    expect(ev("formatDate('2026-03-01')")).toBe('Mar 1, 2026');
    expect(ev("formatDate('2026-03-01T15:30:00Z', 'datetime')")).toBe('Mar 1, 2026, 3:30 PM');
    expect(ev("formatDate('nope')")).toBe('—');
  });

  it('reports bad format arguments with the position of the call', () => {
    expect(() => ev("1 + formatCurrency(1, 'euro')")).toThrow(InlineUiExprError);
    try {
      ev("1 + formatCurrency(1, 'euro')");
    } catch (err) {
      expect(err).toMatchObject({ position: 4, message: expect.stringContaining('ISO 4217') });
    }
    expect(() => ev("formatDate(0, 'weekday')")).toThrow(/date style/);
  });

  it('formats with a locale and time zone the caller chooses', () => {
    expect(ev('formatNumber(1234.5, 1)', {}, {}, { locale: 'de-DE' })).toBe('1.234,5');
    expect(ev("formatDate('2026-03-01T23:30:00Z', 'datetime')", {}, {}, { timeZone: 'Asia/Tokyo' })).toBe('Mar 2, 2026, 8:30 AM');
    // A calendar date never shifts with the time zone.
    expect(formatDate('2026-03-01', 'medium', { timeZone: 'America/Los_Angeles' })).toBe('Mar 1, 2026');
  });
});

describe('interpolation', () => {
  const s = scope({ plan: { name: 'Pro', price: 12.5 }, n: 1234567, bad: 0 });

  it('replaces each ${…} with its value as text', () => {
    expect(interpolate('I take ${plan.name} at ${plan.price * 2}', s)).toBe('I take Pro at 25');
    expect(interpolate('${n}', s)).toBe('1234567');
    expect(interpolate('${1 / bad}', s)).toBe('—');
    expect(interpolate('${missing}!', s)).toBe('!');
  });

  it('keeps an escaped \\${ and a } inside a quoted string', () => {
    expect(interpolate('cost \\${plan.price}', s)).toBe('cost ${plan.price}');
    expect(interpolate("${'a}b'}", s)).toBe('a}b');
    expect(interpolate('no expressions', s)).toBe('no expressions');
  });

  it('reports an unclosed or invalid expression at its place in the text', () => {
    expect(() => parseInterpolation('total ${a + ')).toThrow(/without its closing/);
    try {
      parseInterpolation('ab ${1 +}');
    } catch (err) {
      expect(err).toMatchObject({ position: 8 });
    }
    expect(parseInterpolation('a ${b} c')).toMatchObject(['a ', { source: 'b', start: 4 }, ' c']);
  });

  it('writes values as text deterministically', () => {
    expect(valueToText(0.1 + 0.2)).toBe('0.3');
    expect(valueToText(2026)).toBe('2026');
    expect(valueToText([1, 'a', true, null])).toBe('1, a, true, ');
    expect(valueToText({ a: 1 })).toBe('{"a":1}');
    expect(valueToText(Number.NaN)).toBe('—');
  });
});
