import { describe, expect, test } from 'bun:test';
import { parsePullLine } from './ollama-provider';

describe('parsePullLine', () => {
  test('parses a manifest status line', () => {
    expect(parsePullLine('{"status":"pulling manifest"}')).toEqual({ status: 'pulling manifest' });
  });

  test('derives percent from total + completed', () => {
    const p = parsePullLine('{"status":"downloading sha256:abc","digest":"sha256:abc","total":1000,"completed":250}');
    expect(p).toEqual({ status: 'downloading sha256:abc', total: 1000, completed: 250, percent: 25 });
  });

  test('caps percent at 100', () => {
    const p = parsePullLine('{"status":"downloading","total":100,"completed":150}');
    expect(p && 'percent' in p ? p.percent : null).toBe(100);
  });

  test('no percent when total is missing or zero', () => {
    expect(parsePullLine('{"status":"x","completed":5}')).toEqual({ status: 'x', completed: 5 });
    expect(parsePullLine('{"status":"x","total":0,"completed":5}')).toEqual({ status: 'x', total: 0, completed: 5 });
  });

  test('surfaces an error line', () => {
    expect(parsePullLine('{"error":"file does not exist"}')).toEqual({ error: 'file does not exist' });
  });

  test('returns null for blank or unparsable lines', () => {
    expect(parsePullLine('')).toBeNull();
    expect(parsePullLine('   ')).toBeNull();
    expect(parsePullLine('not json')).toBeNull();
    expect(parsePullLine('{"no_status":true}')).toBeNull();
  });

  test('parses the success terminator', () => {
    expect(parsePullLine('{"status":"success"}')).toEqual({ status: 'success' });
  });
});
