import { describe, expect, test } from 'vitest';
import { createThinkStreamFilter, stripJsonThinkingLeak } from './litellm-client';

describe('stripJsonThinkingLeak (A1)', () => {
  test('whole-content pure thinking object is stripped', () => {
    expect(stripJsonThinkingLeak('{"thought":"x"}')).toBe('');
    expect(stripJsonThinkingLeak('  {"thinking":"plan"}  ')).toBe('');
  });

  test('embedded thought key inside valid structured JSON is untouched', () => {
    const react = '{"thought":"reason","action":"search"}';
    expect(stripJsonThinkingLeak(react)).toBe(react);
    const data = '{"data":1,"thought":"x"}';
    expect(stripJsonThinkingLeak(data)).toBe(data);
  });

  test('leading thinking wrapper is peeled, remainder kept', () => {
    expect(stripJsonThinkingLeak('{"thought":"hmm"}actual')).toBe('actual');
  });

  test('truncated/malformed leading thinking preamble blanks the content', () => {
    expect(stripJsonThinkingLeak('{"thought": "<channel|>{')).toBe('');
  });

  test('plain prose is untouched', () => {
    expect(stripJsonThinkingLeak('the answer is 42')).toBe('the answer is 42');
  });
});

describe('createThinkStreamFilter (item 24)', () => {
  test('strips a think block split across chunks', () => {
    const f = createThinkStreamFilter();
    let out = '';
    out += f.push('pre<think>se');
    out += f.push('cret');
    out += f.push('</think>post');
    const tail = f.flush();
    expect(out + tail.text).toBe('prepost');
    expect(tail.unclosed).toBe(false);
  });

  test('open tag split across a chunk boundary is caught', () => {
    const f = createThinkStreamFilter();
    let out = '';
    out += f.push('a<th');
    out += f.push('ink>secret</think>b');
    out += f.flush().text;
    expect(out).toBe('ab');
  });

  test('unclosed think block flushes remaining buffer as content (not swallowed)', () => {
    const f = createThinkStreamFilter();
    const emitted = f.push('visible<think>never closes');
    const tail = f.flush();
    expect(emitted).toBe('visible');
    expect(tail.unclosed).toBe(true);
    expect(tail.text).toBe('never closes');
  });
});
