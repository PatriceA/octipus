import type { GatewayEventBus } from '@/core/gateway/event-bus';
import { coreLogger } from '@/utils/logger';
import { discoverExtensions, type ExtensionDiscoveryOptions, loadExtension } from './loader';
import type { LoadedExtension } from './types';

/**
 * Tracks every loaded user-authored extension. Single source of truth for
 * `/reload` and graceful shutdown.
 */
export class ExtensionRegistry {
  private loaded: Map<string, LoadedExtension> = new Map();
  private eventBus: GatewayEventBus;

  constructor(eventBus: GatewayEventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Discover and load all extensions. Idempotent — calling twice without
   * an intervening `disposeAll()` is a no-op for already-loaded names.
   */
  async loadAll(opts: ExtensionDiscoveryOptions = {}): Promise<void> {
    const entries = discoverExtensions(opts);
    if (entries.length === 0) {
      coreLogger.debug('no user extensions discovered');
      return;
    }

    let count = 0;
    for (const entry of entries) {
      if (this.loaded.has(entry.name)) continue;
      const loaded = await loadExtension(entry, this.eventBus);
      if (loaded) {
        this.loaded.set(loaded.name, loaded);
        count++;
      }
    }

    coreLogger.info({ count }, 'extensions loaded');
  }

  /**
   * Dispose all extensions in reverse load order. Used by `/reload` and
   * `gateway.stop()`.
   */
  async disposeAll(): Promise<void> {
    const names = [...this.loaded.keys()].reverse();
    for (const name of names) {
      const ext = this.loaded.get(name);
      if (!ext) continue;
      try {
        await ext.dispose();
      } catch (err) {
        coreLogger.warn({ err, name }, 'extension dispose threw');
      }
      this.loaded.delete(name);
    }
  }

  /** Reload everything: dispose-all, then re-discover and load. */
  async reload(opts: ExtensionDiscoveryOptions = {}): Promise<{ count: number }> {
    await this.disposeAll();
    await this.loadAll(opts);
    return { count: this.loaded.size };
  }

  list(): LoadedExtension[] {
    return [...this.loaded.values()];
  }

  get(name: string): LoadedExtension | undefined {
    return this.loaded.get(name);
  }
}

let instance: ExtensionRegistry | null = null;

export function getExtensionRegistry(eventBus?: GatewayEventBus): ExtensionRegistry {
  if (!instance) {
    if (!eventBus) throw new Error('getExtensionRegistry requires eventBus on first call');
    instance = new ExtensionRegistry(eventBus);
  }
  return instance;
}

/** Reset singleton — used by tests. */
export function resetExtensionRegistry(): void {
  instance = null;
}
