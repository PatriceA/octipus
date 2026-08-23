import { describe, expect, test } from 'vitest';
import {
  createPlaceholder,
  extractSecretNames,
  hasSecretPlaceholders,
  isValidSecretName,
  redactSecrets,
} from './secret-injector';

describe('hasSecretPlaceholders', () => {
  test('detects placeholder', () => {
    expect(hasSecretPlaceholders('hi {{secret:foo}} bye')).toBe(true);
  });

  test('returns false when none present', () => {
    expect(hasSecretPlaceholders('plain text')).toBe(false);
  });

  test('rejects malformed placeholder (lowercase only allowed chars)', () => {
    expect(hasSecretPlaceholders('{{secret:foo bar}}')).toBe(false);
  });
});

describe('extractSecretNames', () => {
  test('returns unique names in order', () => {
    expect(extractSecretNames('A {{secret:foo}} B {{secret:bar}} C {{secret:foo}}')).toEqual([
      'foo',
      'bar',
    ]);
  });

  test('empty input → empty array', () => {
    expect(extractSecretNames('')).toEqual([]);
  });

  test('no placeholders → empty array', () => {
    expect(extractSecretNames('nothing here')).toEqual([]);
  });
});

describe('redactSecrets', () => {
  test('replaces placeholder with [REDACTED:name]', () => {
    expect(redactSecrets('use {{secret:api_key}} now')).toBe('use [REDACTED:api_key] now');
  });

  test('redacts multiple', () => {
    expect(redactSecrets('{{secret:a}} {{secret:b}}')).toBe('[REDACTED:a] [REDACTED:b]');
  });

  test('no-op without placeholder', () => {
    expect(redactSecrets('clean')).toBe('clean');
  });
});

describe('createPlaceholder', () => {
  test('formats placeholder', () => {
    expect(createPlaceholder('my-key')).toBe('{{secret:my-key}}');
  });
});

describe('isValidSecretName', () => {
  test('accepts alphanumeric, underscore, dash', () => {
    expect(isValidSecretName('api_key-1')).toBe(true);
  });

  test('rejects spaces', () => {
    expect(isValidSecretName('api key')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidSecretName('')).toBe(false);
  });

  test('rejects special chars', () => {
    expect(isValidSecretName('foo$bar')).toBe(false);
  });
});
