/**
 * Storage provider factory — singleton access to the active provider.
 */
import { dbLogger } from '@/utils/logger';
import { MemoryStorageProvider } from './memory-provider';
import { PostgresStorageProvider } from './postgres-provider';
import type { StorageProvider } from './types';

export type { CacheProvider, PubSubProvider, QueueProvider, StorageProvider } from './types';

let provider: StorageProvider | null = null;

export type StorageMode = 'embedded' | 'external';

export interface StorageConfig {
  mode: StorageMode;
}

/**
 * Initialize the storage provider. Must be called once during startup, and —
 * for `external` — AFTER the database, because that provider runs on it.
 */
export function initializeStorage(config: StorageConfig): StorageProvider {
  if (provider) return provider;

  if (config.mode === 'embedded') {
    provider = new MemoryStorageProvider();
    dbLogger.info('Storage initialized: embedded (in-memory)');
  } else {
    provider = new PostgresStorageProvider();
    dbLogger.info('Storage initialized: external (Postgres)');
  }

  return provider;
}

/**
 * Get the active storage provider. Throws if not initialized.
 */
export function getStorageProvider(): StorageProvider {
  if (!provider) throw new Error('Storage provider not initialized — call initializeStorage() first');
  return provider;
}

/**
 * Close storage connections.
 */
export async function closeStorage(): Promise<void> {
  if (provider) {
    await provider.close();
    provider = null;
  }
}

/**
 * Check storage health.
 */
export async function checkStorageHealth(): Promise<{ healthy: boolean; mode: StorageMode; latency?: number; error?: string }> {
  const start = Date.now();
  try {
    if (!provider) return { healthy: false, mode: 'external', error: 'Not initialized' };
    const ok = await provider.ping();
    return { healthy: ok, mode: provider.mode, latency: Date.now() - start };
  } catch (error) {
    return { healthy: false, mode: provider?.mode || 'external', error: (error as Error).message };
  }
}
