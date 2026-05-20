import { coreLogger } from '@/utils/logger';
import { loadAllPersonas } from './loader';
import type { Persona } from './types';

/**
 * In-process registry of every persona preset YAML in `personas/`.
 * Loaded lazily on first access. Tests can call `setRegistryForTesting`
 * to inject a fixed set without touching the filesystem.
 */
class PersonaRegistry {
  private byId: Map<string, Persona> = new Map();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  /**
   * Ensure the registry is loaded. Idempotent.
   * Fails loud if the base persona (`octipus`) is missing.
   */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async doLoad(): Promise<void> {
    const presets = await loadAllPersonas();
    this.byId.clear();
    for (const p of presets) {
      if (this.byId.has(p.id)) {
        coreLogger.warn({ id: p.id }, 'duplicate persona id — later file wins');
      }
      this.byId.set(p.id, p);
    }
    if (!this.byId.has('octipus')) {
      throw new Error(
        'Base persona `octipus` not found in personas/. The default persona is required.',
      );
    }
    this.loaded = true;
  }

  /** Look up a preset by id; returns undefined if not loaded. */
  get(id: string): Persona | undefined {
    return this.byId.get(id);
  }

  /** Get the base persona (always `octipus`). Throws if registry not loaded. */
  getDefault(): Persona {
    const base = this.byId.get('octipus');
    if (!base) throw new Error('Persona registry not initialized — call ensureLoaded() first');
    return base;
  }

  /** List every loaded preset (for `/persona personas`). */
  list(): Persona[] {
    return [...this.byId.values()];
  }

  /** Test hook — replace the registry contents without touching disk. */
  _setForTesting(personas: Persona[]): void {
    this.byId.clear();
    for (const p of personas) this.byId.set(p.id, p);
    this.loaded = true;
  }

  /** Test hook — reset to unloaded state. */
  _resetForTesting(): void {
    this.byId.clear();
    this.loaded = false;
    this.loadPromise = null;
  }
}

let instance: PersonaRegistry | null = null;

export function getPersonaRegistry(): PersonaRegistry {
  if (!instance) instance = new PersonaRegistry();
  return instance;
}
