import { describe, expect, test } from 'bun:test';
import {
  API_SCOPES,
  isKnownScope,
  KNOWN_API_SCOPES,
  scopesSatisfy,
  validateRequestedScopes,
} from './scopes';

describe('scopesSatisfy — backwards-compat (empty = full access)', () => {
  test('empty / null / undefined granted set satisfies anything', () => {
    expect(scopesSatisfy([], API_SCOPES.CHAT)).toBe(true);
    expect(scopesSatisfy(null, API_SCOPES.CHAT)).toBe(true);
    expect(scopesSatisfy(undefined, API_SCOPES.WRITE)).toBe(true);
  });

  test('a scoped token is restricted to exactly its scopes', () => {
    expect(scopesSatisfy([API_SCOPES.READ], API_SCOPES.CHAT)).toBe(false);
    expect(scopesSatisfy([API_SCOPES.CHAT], API_SCOPES.CHAT)).toBe(true);
    expect(scopesSatisfy([API_SCOPES.READ, API_SCOPES.CHAT], API_SCOPES.CHAT)).toBe(true);
  });

  test('api:admin implies every scope', () => {
    expect(scopesSatisfy([API_SCOPES.ADMIN], API_SCOPES.CHAT)).toBe(true);
    expect(scopesSatisfy([API_SCOPES.ADMIN], API_SCOPES.WRITE)).toBe(true);
    expect(scopesSatisfy([API_SCOPES.ADMIN], 'api:read')).toBe(true);
  });
});

describe('isKnownScope', () => {
  test('recognizes every declared scope and nothing else', () => {
    for (const s of KNOWN_API_SCOPES) expect(isKnownScope(s)).toBe(true);
    expect(isKnownScope('api:cht')).toBe(false); // typo
    expect(isKnownScope('')).toBe(false);
    expect(isKnownScope('admin')).toBe(false);
  });
});

describe('validateRequestedScopes', () => {
  test('empty/undefined is valid and yields an empty list (unscoped)', () => {
    expect(validateRequestedScopes(undefined)).toEqual({ ok: true, scopes: [] });
    expect(validateRequestedScopes([])).toEqual({ ok: true, scopes: [] });
  });

  test('dedupes known scopes', () => {
    const r = validateRequestedScopes([API_SCOPES.CHAT, API_SCOPES.CHAT, API_SCOPES.READ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scopes.sort()).toEqual([API_SCOPES.CHAT, API_SCOPES.READ].sort());
  });

  test('rejects the first unknown scope with a helpful message', () => {
    const r = validateRequestedScopes([API_SCOPES.CHAT, 'api:cht']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('api:cht');
  });
});
