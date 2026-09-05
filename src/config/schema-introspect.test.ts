import { describe, expect, test } from 'vitest';
import { getFieldConstraints, getFieldSchema, validateSettingValue } from './schema-introspect';

describe('schema-introspect — validateSettingValue', () => {
  test('accepts in-range numbers and rejects out-of-range ones', () => {
    expect(validateSettingValue('agent.liteMaxIterations', 25).ok).toBe(true);
    expect(validateSettingValue('agent.liteMaxIterations', 3).ok).toBe(true);

    const tooBig = validateSettingValue('agent.liteMaxIterations', 26);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.message).toMatch(/25/);

    const tooSmall = validateSettingValue('agent.liteMaxIterations', 0);
    expect(tooSmall.ok).toBe(false);
  });

  test('enforces deep-path minimums (the swarm budget that broke boot)', () => {
    expect(validateSettingValue('swarm.levelDefaults.root.tokens', 0).ok).toBe(false);
    expect(validateSettingValue('swarm.levelDefaults.root.tokens', 200000).ok).toBe(true);
  });

  test('enforces enum membership', () => {
    expect(validateSettingValue('agent.promptTier', 'lite').ok).toBe(true);
    expect(validateSettingValue('agent.promptTier', 'bogus').ok).toBe(false);
  });

  test('passes through keys not present in the config schema', () => {
    // Vault-only / unmapped keys can't be schema-validated here — must not throw.
    expect(validateSettingValue('not.a.real.key', 'anything').ok).toBe(true);
  });
});

describe('schema-introspect — getFieldConstraints', () => {
  test('extracts min/max for bounded numbers', () => {
    expect(getFieldConstraints('agent.liteMaxIterations')).toEqual({ min: 1, max: 25 });
  });

  test('extracts minimum-only for one-sided bounds', () => {
    expect(getFieldConstraints('swarm.levelDefaults.root.tokens')).toEqual({ min: 1000 });
  });

  test('extracts enum options', () => {
    expect(getFieldConstraints('agent.promptTier')).toEqual({
      enumValues: ['auto', 'full', 'lite'],
    });
  });

  test('returns null for unconstrained fields', () => {
    expect(getFieldConstraints('litellm.proxyUrl')).toBeNull();
  });
});

describe('schema-introspect — getFieldSchema', () => {
  test('resolves nested fields and returns null for unknown keys', () => {
    expect(getFieldSchema('agent.promptTier')).not.toBeNull();
    expect(getFieldSchema('agent.nope')).toBeNull();
    expect(getFieldSchema('totally.unknown.path')).toBeNull();
  });
});
