import { describe, expect, test } from 'vitest';
import { exposureConfigError, ownToolExposure, resolveToolExposure } from './mcp-exposure';

describe('resolveToolExposure', () => {
  test('a server without settings keeps the pre-exposure behaviour (deferred)', () => {
    expect(resolveToolExposure({}, 'search')).toBe('deferred');
  });

  test('the server setting applies to every tool without an override', () => {
    expect(resolveToolExposure({ exposure: 'codemode' }, 'search')).toBe('codemode');
  });

  test('an exact name wins over a pattern listed before it', () => {
    const server = { exposure: 'deferred' as const, toolExposure: { 'get_*': 'codemode' as const, get_issue: 'direct' as const } };
    expect(resolveToolExposure(server, 'get_issue')).toBe('direct');
    expect(resolveToolExposure(server, 'get_pr')).toBe('codemode');
  });

  test('among patterns the first match wins; * matches any run of characters', () => {
    const server = { exposure: 'hidden' as const, toolExposure: { '*_issue*': 'direct' as const, 'delete_*': 'deferred' as const } };
    expect(resolveToolExposure(server, 'delete_issue')).toBe('direct');
    expect(resolveToolExposure(server, 'delete_repo')).toBe('deferred');
    expect(resolveToolExposure(server, 'search')).toBe('hidden');
  });

  test('a tool named after an Object.prototype member gets the server exposure, not the prototype member', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(resolveToolExposure({ exposure: 'hidden' }, name)).toBe('hidden');
      expect(ownToolExposure({}, name)).toBeUndefined();
    }
    expect(ownToolExposure({ constructor: 'direct' as const }, 'constructor')).toBe('direct');
  });

  test('regex characters in a pattern are literal', () => {
    const server = { toolExposure: { 'a.b*': 'hidden' as const } };
    expect(resolveToolExposure(server, 'a.bc')).toBe('hidden');
    expect(resolveToolExposure(server, 'axbc')).toBe('deferred');
  });
});

describe('exposureConfigError', () => {
  test('accepts valid settings and absent ones', () => {
    expect(exposureConfigError({})).toBeNull();
    expect(exposureConfigError({ exposure: 'direct', toolExposure: { 'x*': 'hidden' } })).toBeNull();
  });

  test('names the bad value', () => {
    expect(exposureConfigError({ exposure: 'visible' })).toMatch(/exposure must be one of direct, deferred, codemode, hidden; got "visible"/);
    expect(exposureConfigError({ toolExposure: { search: 'on' } })).toMatch(/toolExposure\["search"\]/);
    expect(exposureConfigError({ toolExposure: ['search'] })).toMatch(/must be an object/);
    expect(exposureConfigError({ toolExposure: { ' ': 'direct' } })).toMatch(/non-empty/);
  });
});
