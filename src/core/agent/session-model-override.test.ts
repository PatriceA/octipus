import { afterEach, describe, expect, test } from 'vitest';
import {
  _resetSessionModelOverridesForTesting,
  clearSessionModel,
  getSessionModel,
  setSessionModel,
} from './session-model-override';

afterEach(() => {
  _resetSessionModelOverridesForTesting();
});

describe('session-model-override', () => {
  test('set + get round-trips', () => {
    setSessionModel('s1', 'u1', 'gpt-4o');
    expect(getSessionModel('s1', 'u1')).toBe('gpt-4o');
  });

  test('overrides are session-scoped', () => {
    setSessionModel('s1', 'u1', 'gpt-4o');
    setSessionModel('s2', 'u1', 'claude-3-7');
    expect(getSessionModel('s1', 'u1')).toBe('gpt-4o');
    expect(getSessionModel('s2', 'u1')).toBe('claude-3-7');
  });

  test('overrides are user-scoped within one session (coworking spec §8.2)', () => {
    setSessionModel('s1', 'u1', 'u/u1/mine');
    expect(getSessionModel('s1', 'u2')).toBeUndefined();
    setSessionModel('s1', 'u2', 'gpt-4o');
    expect(getSessionModel('s1', 'u1')).toBe('u/u1/mine');
    expect(clearSessionModel('s1', 'u2')).toBe(true);
    expect(getSessionModel('s1', 'u1')).toBe('u/u1/mine');
  });

  test('setting on the same session replaces', () => {
    setSessionModel('s1', 'u1', 'first');
    setSessionModel('s1', 'u1', 'second');
    expect(getSessionModel('s1', 'u1')).toBe('second');
  });

  test('clear returns true when an override was set', () => {
    setSessionModel('s1', 'u1', 'x');
    expect(clearSessionModel('s1', 'u1')).toBe(true);
    expect(getSessionModel('s1', 'u1')).toBeUndefined();
  });

  test('clear returns false when no override exists', () => {
    expect(clearSessionModel('nonexistent', 'u1')).toBe(false);
  });

  test('empty session id is ignored', () => {
    setSessionModel('', 'u1', 'noop');
    expect(getSessionModel('', 'u1')).toBeUndefined();
  });
});
