import { describe, expect, test } from 'bun:test';
import { DEEPSEEK_TEMPLATE_LEAK, parseDsmlToolCalls } from './deepseek-template-recovery';

describe('DEEPSEEK_TEMPLATE_LEAK detector', () => {
  test('matches DSML tool_calls block (V4-flash, V4-pro real-world)', () => {
    const sample = '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="filesystem__read_file">\n<｜｜DSML｜｜parameter name="path" string="true">/x</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';
    expect(DEEPSEEK_TEMPLATE_LEAK.test(sample)).toBe(true);
  });

  test('matches V3 SentencePiece tool_call_begin token', () => {
    const sample = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>x\n```json\n{}\n```\n<｜tool▁call▁end｜>';
    expect(DEEPSEEK_TEMPLATE_LEAK.test(sample)).toBe(true);
  });

  test('matches V3 with underscore separator (alt serializer)', () => {
    const sample = '<｜tool_calls_begin｜>...';
    expect(DEEPSEEK_TEMPLATE_LEAK.test(sample)).toBe(true);
  });

  test('does not match prose mentioning tool calls', () => {
    expect(DEEPSEEK_TEMPLATE_LEAK.test('I will invoke the parameter tool to read the file.')).toBe(false);
    expect(DEEPSEEK_TEMPLATE_LEAK.test('The tool_calls field is required.')).toBe(false);
  });

  test('does not match code fences that include the words', () => {
    expect(DEEPSEEK_TEMPLATE_LEAK.test('```json\n{"tool_calls": []}\n```')).toBe(false);
  });
});

describe('parseDsmlToolCalls', () => {
  test('parses a single DSML invoke with one string parameter', () => {
    const sample = '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="filesystem__read_file">\n<｜｜DSML｜｜parameter name="path" string="true">/home/patrice/x.js</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';
    expect(parseDsmlToolCalls(sample)).toEqual([
      { id: 'dsml_0', name: 'filesystem__read_file', arguments: { path: '/home/patrice/x.js' } },
    ]);
  });

  test('parses DSML invoke with string="false" — coerces number/bool/null', () => {
    const sample = '<｜｜DSML｜｜invoke name="t">\n<｜｜DSML｜｜parameter name="n" string="false">3</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="b" string="false">true</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="x" string="false">null</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>';
    expect(parseDsmlToolCalls(sample)).toEqual([
      { id: 'dsml_0', name: 't', arguments: { n: 3, b: true, x: null } },
    ]);
  });

  test('parses multiple DSML invokes in one block', () => {
    const sample = '<｜｜DSML｜｜invoke name="a"><｜｜DSML｜｜parameter name="p" string="true">1</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke><｜｜DSML｜｜invoke name="b"><｜｜DSML｜｜parameter name="q" string="true">2</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>';
    const parsed = parseDsmlToolCalls(sample);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe('a');
    expect(parsed[1].name).toBe('b');
  });

  test('parses V3 SentencePiece tool_call with JSON args', () => {
    const sample = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>filesystem__read_file\n```json\n{"path": "/tmp/x"}\n```\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    expect(parseDsmlToolCalls(sample)).toEqual([
      { id: 'v3_0', name: 'filesystem__read_file', arguments: { path: '/tmp/x' } },
    ]);
  });

  test('V3 SentencePiece tolerates truncated JSON via repairTruncatedJson', () => {
    const sample = '<｜tool▁call▁begin｜>function<｜tool▁sep｜>x\n```json\n{"path": "/tmp/y\n```\n<｜tool▁call▁end｜>';
    expect(parseDsmlToolCalls(sample)).toEqual([
      { id: 'v3_0', name: 'x', arguments: { path: '/tmp/y' } },
    ]);
  });

  test('returns [] on prose with no invoke blocks', () => {
    expect(parseDsmlToolCalls('I would normally invoke the tool, but cannot.')).toEqual([]);
  });
});
