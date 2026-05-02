import { describe, expect, test } from 'bun:test';
import { resourceTypeFromPath } from './audit-shadow';

// Pure-function unit tests. The behavioral tests for `writeApiAudit` and
// the Elysia plugin lifecycle live in `audit-shadow.integration.test.ts`,
// which exercises the full path against an ephemeral PGlite — no global
// `mock.module` calls (those leak across files in the same test run).

describe('audit-shadow: resourceTypeFromPath', () => {
  test('extracts segment after /api/', () => {
    expect(resourceTypeFromPath('/api/sessions')).toBe('sessions');
    expect(resourceTypeFromPath('/api/sessions/123/messages')).toBe('sessions');
    expect(resourceTypeFromPath('/api/agents/abc')).toBe('agents');
  });

  test('returns undefined for non-api paths or root /api', () => {
    expect(resourceTypeFromPath('/health')).toBeUndefined();
    expect(resourceTypeFromPath('/api')).toBeUndefined();
    expect(resourceTypeFromPath('')).toBeUndefined();
  });

  test('handles query strings', () => {
    expect(resourceTypeFromPath('/api/vault?scope=user')).toBe('vault');
  });
});
