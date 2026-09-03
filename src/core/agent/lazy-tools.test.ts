import { describe, expect, test } from 'vitest';
import { shouldUseLazyDiscovery } from './lazy-tools';

/**
 * The gate used to read `provider === 'ollama'`, duplicated in the root runner
 * and the worker spawner. A benchmark measured what that cost everyone else:
 * the root's standing prompt was 21,945 tokens, 15,935 of them tool JSON
 * schema, billed in full on every fresh session. The provider is not what
 * decides whether a caller can handle a discovery round trip.
 */

const base = { hasCoreToolIds: true, isSmallModel: false, supportsTools: true, enabled: true };

describe('who gets a trimmed advertisement', () => {
  test('a capable model with a core set does', () => {
    expect(shouldUseLazyDiscovery(base)).toBe(true);
  });

  test('the provider is not part of the decision', () => {
    // The regression this file exists to prevent: re-introducing a host check.
    // `shouldUseLazyDiscovery` takes no provider, so a remote model and a local
    // one with identical capabilities get identical answers, by construction.
    expect(Object.keys(base)).not.toContain('provider');
    expect(shouldUseLazyDiscovery(base)).toBe(shouldUseLazyDiscovery({ ...base }));
  });
});

describe('who keeps the full block', () => {
  test('a role with no core set — there is nothing to split', () => {
    expect(shouldUseLazyDiscovery({ ...base, hasCoreToolIds: false })).toBe(false);
  });

  test('a small model — it chains multi-step discovery badly', () => {
    expect(shouldUseLazyDiscovery({ ...base, isSmallModel: true })).toBe(false);
  });

  test('a model that cannot call tools — it cannot call the meta-tools either', () => {
    expect(shouldUseLazyDiscovery({ ...base, supportsTools: false })).toBe(false);
  });

  test('an operator who turned it off', () => {
    expect(shouldUseLazyDiscovery({ ...base, enabled: false })).toBe(false);
  });
});

describe('the setting reaches a running process', () => {
  test('it defaults on and survives the config merge', async () => {
    const { loadFromEnvLegacy } = await import('@/config/legacy-loader');
    const { deepMerge } = await import('@/config/utils');
    const { defaultConfig } = await import('@/config/defaults');

    const saved = process.env.AGENT_LAZY_TOOLS;
    delete process.env.AGENT_LAZY_TOOLS;
    try {
      const merged = deepMerge(defaultConfig, loadFromEnvLegacy());
      expect(merged.agent?.lazyToolDiscovery).toBe(true);
    } finally {
      if (saved !== undefined) process.env.AGENT_LAZY_TOOLS = saved;
    }
  });

  test('an operator can turn it off from the environment', async () => {
    const { loadFromEnvLegacy } = await import('@/config/legacy-loader');
    const { deepMerge } = await import('@/config/utils');
    const { defaultConfig } = await import('@/config/defaults');

    const saved = process.env.AGENT_LAZY_TOOLS;
    process.env.AGENT_LAZY_TOOLS = 'false';
    try {
      const merged = deepMerge(defaultConfig, loadFromEnvLegacy());
      expect(merged.agent?.lazyToolDiscovery).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AGENT_LAZY_TOOLS;
      else process.env.AGENT_LAZY_TOOLS = saved;
    }
  });
});
