import { describe, expect, test } from 'bun:test';
import { repairTruncatedJson } from './json-repair';

describe('repairTruncatedJson', () => {
  test('returns original for valid JSON (round-trip safe)', () => {
    const input = '{"a":1,"b":"hello"}';
    const out = repairTruncatedJson(input);
    expect(out).toBe(input);
  });

  test('closes unterminated string at EOF', () => {
    const input = '{"path":"/tmp/x","content":"line1\\nline2';
    const out = repairTruncatedJson(input);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.path).toBe('/tmp/x');
    expect(typeof parsed.content).toBe('string');
  });

  test('closes unterminated string + missing closing brace', () => {
    const input = '{"path":"/a","content":"hello world';
    const out = repairTruncatedJson(input);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.path).toBe('/a');
    expect(parsed.content).toBe('hello world');
  });

  test('closes nested arrays and objects', () => {
    const input = '{"items":[{"a":1},{"b":"x';
    const out = repairTruncatedJson(input);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.items[0].a).toBe(1);
    expect(parsed.items[1].b).toBe('x');
  });

  test('strips trailing comma before truncation', () => {
    const input = '{"a":1,"b":2,';
    const out = repairTruncatedJson(input);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.a).toBe(1);
    expect(parsed.b).toBe(2);
  });

  test('fills dangling colon with null', () => {
    const input = '{"a":';
    const out = repairTruncatedJson(input);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.a).toBeNull();
  });

  test('preserves escaped quotes inside strings', () => {
    const input = '{"msg":"she said \\"hi\\"';
    const out = repairTruncatedJson(input);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.msg).toBe('she said "hi"');
  });

  test('drops trailing lone backslash that would create an invalid escape', () => {
    const input = '{"path":"/tmp\\';
    const out = repairTruncatedJson(input);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.path).toBe('/tmp');
  });

  test('returns null on mismatched brace types', () => {
    const input = '{"a":[1,2}';
    const out = repairTruncatedJson(input);
    expect(out).toBeNull();
  });

  test('returns null on extra close', () => {
    const input = '{"a":1}}';
    const out = repairTruncatedJson(input);
    expect(out).toBeNull();
  });

  test('returns null on empty / non-string input', () => {
    expect(repairTruncatedJson('')).toBeNull();
    expect(repairTruncatedJson(null as unknown as string)).toBeNull();
  });

  test('repairs a realistic write_file truncation', () => {
    const input =
      '{"path":"/home/user/docs/plan.md","content":"# Architecture Plan\\n\\n## Components\\n- Gateway\\n- Orchestra';
    const out = repairTruncatedJson(input);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.path).toBe('/home/user/docs/plan.md');
    expect(parsed.content.startsWith('# Architecture Plan')).toBe(true);
  });
});
