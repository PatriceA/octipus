/**
 * Drift guard: the wizard catalog, the settings registry and the runtime
 * providers each carried their own idea of "which providers exist and under
 * which vault name the key lives". grok existed in the runtime and the web UI
 * but not in the wizard or the registry; nothing failed, it was just
 * unreachable from setup. Pin the three to each other.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SETTINGS_REGISTRY } from '@/config/settings-registry';
import { PROVIDERS } from './providers';

const PROVIDERS_DIR = join(import.meta.dirname, '..', 'models', 'providers');

describe('setup provider catalog ↔ settings registry ↔ runtime', () => {
  const keyed = PROVIDERS.filter((p) => p.vaultKey);
  const registryProviderKeys = SETTINGS_REGISTRY.filter((s) => s.category === 'providers');

  test('every wizard provider with a key has a registry entry with the same vault name', () => {
    for (const p of keyed) {
      const entry = SETTINGS_REGISTRY.find((s) => s.key === `${p.id}.apiKey`);
      expect(entry, `${p.id}.apiKey missing from SETTINGS_REGISTRY`).toBeDefined();
      expect(entry?.isSecret, `${p.id}.apiKey must be a secret`).toBe(true);
      expect(entry?.vaultName, `${p.id}.apiKey vaultName`).toBe(p.vaultKey);
    }
  });

  test('every direct-provider registry key is offered by the wizard', () => {
    for (const s of registryProviderKeys) {
      const id = s.key.split('.')[0];
      expect(PROVIDERS.some((p) => p.id === id), `${s.key} has no wizard entry`).toBe(true);
    }
  });

  test('each vault name is the one the runtime provider actually reads', () => {
    // Providers resolve keys via vault.getByName('system', '<name>'); the name
    // is a literal in the provider file, so a rename on either side fails here.
    const sources = readdirSync(PROVIDERS_DIR)
      .filter((f) => f.endsWith('-provider.ts'))
      .map((f) => readFileSync(join(PROVIDERS_DIR, f), 'utf8'))
      .join('\n');
    // litellm is the exception: its key is hydrated into config.litellm.apiKey
    // by src/config/runtime-loader.ts from the registry's vaultName, so the
    // registry test above already covers it.
    for (const p of keyed.filter((p) => p.id !== 'litellm')) {
      expect(sources, `no runtime provider reads vault name ${p.vaultKey} (wizard id ${p.id})`)
        .toContain(`'${p.vaultKey}'`);
    }
  });
});
