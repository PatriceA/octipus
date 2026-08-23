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
    setSessionModel('s1', 'gpt-4o');
    expect(getSessionModel('s1')).toBe('gpt-4o');
  });

  test('overrides are session-scoped', () => {
    setSessionModel('s1', 'gpt-4o');
    setSessionModel('s2', 'claude-3-7');
    expect(getSessionModel('s1')).toBe('gpt-4o');
    expect(getSessionModel('s2')).toBe('claude-3-7');
  });

  test('setting on the same session replaces', () => {
    setSessionModel('s1', 'first');
    setSessionModel('s1', 'second');
    expect(getSessionModel('s1')).toBe('second');
  });

  test('clear returns true when an override was set', () => {
    setSessionModel('s1', 'x');
    expect(clearSessionModel('s1')).toBe(true);
    expect(getSessionModel('s1')).toBeUndefined();
  });

  test('clear returns false when no override exists', () => {
    expect(clearSessionModel('nonexistent')).toBe(false);
  });

  test('empty session id is ignored', () => {
    setSessionModel('', 'noop');
    expect(getSessionModel('')).toBeUndefined();
  });
});
