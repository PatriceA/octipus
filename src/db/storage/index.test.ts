import { afterEach, describe, expect, test } from 'vitest';
import {
  initializeStorage,
  getStorageProvider,
  closeStorage,
  checkStorageHealth,
} from './index';

// ── Helpers ───────────────────────────────────────────────────

afterEach(async () => {
  await closeStorage();
});

// ── initializeStorage ─────────────────────────────────────────

describe('initializeStorage', () => {
  test('embedded mode returns a MemoryStorageProvider', () => {
    const provider = initializeStorage({ mode: 'embedded' });
    expect(provider.mode).toBe('embedded');
  });

  test('returns the same singleton on repeated calls (no re-init)', () => {
    const first = initializeStorage({ mode: 'embedded' });
    const second = initializeStorage({ mode: 'embedded' });
    expect(second).toBe(first);
  });

  test('external mode without redis config throws', async () => {
    // Make sure we start fresh
    await closeStorage();
    expect(() => initializeStorage({ mode: 'external' })).toThrow(
      /Redis config required/,
    );
  });
});

// ── getStorageProvider ────────────────────────────────────────

describe('getStorageProvider', () => {
  test('throws if called before initializeStorage', async () => {
    await closeStorage();
    expect(() => getStorageProvider()).toThrow(/not initialized/);
  });

  test('returns the initialized provider', () => {
    const initialized = initializeStorage({ mode: 'embedded' });
    expect(getStorageProvider()).toBe(initialized);
  });
});

// ── checkStorageHealth ────────────────────────────────────────

describe('checkStorageHealth', () => {
  test('returns unhealthy + "Not initialized" when no provider', async () => {
    await closeStorage();
    const result = await checkStorageHealth();
    expect(result.healthy).toBe(false);
    expect(result.error).toBe('Not initialized');
  });

  test('returns healthy + latency for a live embedded provider', async () => {
    initializeStorage({ mode: 'embedded' });
    const result = await checkStorageHealth();
    expect(result.healthy).toBe(true);
    expect(result.mode).toBe('embedded');
    expect(typeof result.latency).toBe('number');
    expect(result.latency!).toBeGreaterThanOrEqual(0);
  });

  test('reports unhealthy when ping throws', async () => {
    const provider = initializeStorage({ mode: 'embedded' });
    // Monkey-patch ping to simulate a failure
    (provider as any).ping = async () => {
      throw new Error('boom');
    };
    const result = await checkStorageHealth();
    expect(result.healthy).toBe(false);
    expect(result.error).toBe('boom');
  });
});

// ── closeStorage ──────────────────────────────────────────────

describe('closeStorage', () => {
  test('is idempotent when no provider is set', async () => {
    await closeStorage();
    // Should not throw on second call
    await closeStorage();
    expect(true).toBe(true);
  });

  test('closes the active provider and allows re-initialization', async () => {
    const first = initializeStorage({ mode: 'embedded' });
    await closeStorage();
    const second = initializeStorage({ mode: 'embedded' });
    expect(second).not.toBe(first);
  });
});
