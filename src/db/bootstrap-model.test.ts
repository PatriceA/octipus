import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { bootstrapDefaultModel } from './bootstrap-model';

/**
 * Note: bootstrap-model talks to the real DB + vault, so unit tests
 * here are limited to the *argument-validation* paths that early-out
 * BEFORE any DB call:
 *   - empty BOOTSTRAP_PROVIDER  → no-op
 *   - empty BOOTSTRAP_MODEL     → no-op + warn
 *
 * The full happy-path is covered by the integration suite under
 * scripts/test-integration.ts.
 */

const SAVED = {
  BOOTSTRAP_PROVIDER: process.env.BOOTSTRAP_PROVIDER,
  BOOTSTRAP_MODEL: process.env.BOOTSTRAP_MODEL,
  BOOTSTRAP_API_KEY: process.env.BOOTSTRAP_API_KEY,
  BOOTSTRAP_BASE_URL: process.env.BOOTSTRAP_BASE_URL,
};

function clearEnv() {
  delete process.env.BOOTSTRAP_PROVIDER;
  delete process.env.BOOTSTRAP_MODEL;
  delete process.env.BOOTSTRAP_API_KEY;
  delete process.env.BOOTSTRAP_BASE_URL;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('bootstrapDefaultModel — argument validation', () => {
  beforeEach(clearEnv);
  afterEach(restoreEnv);

  test('no-op when BOOTSTRAP_PROVIDER is empty', async () => {
    // Should return immediately without touching the DB.
    await expect(bootstrapDefaultModel()).resolves.toBeUndefined();
  });

  test('no-op when BOOTSTRAP_PROVIDER is whitespace', async () => {
    process.env.BOOTSTRAP_PROVIDER = '   ';
    await expect(bootstrapDefaultModel()).resolves.toBeUndefined();
  });
});
