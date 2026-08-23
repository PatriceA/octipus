import { describe, expect, test } from 'vitest';
import { ClassifiedError, FailoverReason } from '@/core/errors/classification';
import { parseToolCallArguments } from './tool-call-args';

describe('parseToolCallArguments', () => {
  test('empty string → {}', () => {
    expect(parseToolCallArguments('', 'do', 'openai')).toEqual({});
    expect(parseToolCallArguments('   ', 'do', 'openai')).toEqual({});
  });

  test('null/undefined → {}', () => {
    expect(parseToolCallArguments(null, 'do', 'openai')).toEqual({});
    expect(parseToolCallArguments(undefined, 'do', 'openai')).toEqual({});
  });

  test('already-an-object passes through', () => {
    const obj = { a: 1 };
    expect(parseToolCallArguments(obj, 'do', 'openai')).toBe(obj);
  });

  test('valid JSON parses', () => {
    expect(parseToolCallArguments('{"q":"weather"}', 'search', 'gemini')).toEqual({ q: 'weather' });
  });

  test('truncated JSON is repaired', () => {
    // Unterminated string / unclosed object — repairTruncatedJson recovers it.
    expect(parseToolCallArguments('{"q": "weather', 'search', 'deepseek')).toEqual({ q: 'weather' });
  });

  test('unrecoverable JSON throws ClassifiedError(TOOL_CALL_INVALID)', () => {
    let err: unknown;
    try {
      parseToolCallArguments('}}}not json{{{', 'broken', 'grok');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClassifiedError);
    expect((err as ClassifiedError).reason).toBe(FailoverReason.TOOL_CALL_INVALID);
  });
});
