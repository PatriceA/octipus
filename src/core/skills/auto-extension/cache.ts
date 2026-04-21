/**
 * Two-layer cache for skill auto-extension fingerprints.
 *   L1: LRU in-memory, cap 500 entries.
 *   L2: disk JSON at `${workspace.rootPath}/skills-cache/<fingerprint>.json`.
 *
 * Writes are write-through. Reads check L1 first, fall back to L2,
 * promote to L1 on hit.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { getConfig } from '@/config';

export interface CacheEntry {
  fingerprint: string;
  userId: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  exemplarSessionIds: string[];
  triggered: boolean;
}

const MAX_ENTRIES = 500;

class SkillCache {
  private lru = new Map<string, CacheEntry>();
  private diskRoot: string;

  constructor(diskRootOverride?: string) {
    this.diskRoot = resolve(
      diskRootOverride ?? (() => {
        try { return getConfig().workspace.rootPath; }
        catch { return process.env.WORKSPACE_ROOT ?? process.cwd(); }
      })(),
      'skills-cache',
    );
    mkdirSync(this.diskRoot, { recursive: true });
  }

  async get(key: string): Promise<CacheEntry | null> {
    const mem = this.lru.get(key);
    if (mem) {
      this.lru.delete(key);
      this.lru.set(key, mem);
      return mem;
    }
    const path = this.diskPath(key);
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      const entry: CacheEntry = {
        ...raw,
        firstSeen: new Date(raw.firstSeen),
        lastSeen: new Date(raw.lastSeen),
      };
      this.promote(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    this.promote(key, entry);
    const path = this.diskPath(key);
    writeFileSync(path, JSON.stringify(entry), 'utf-8');
  }

  private promote(key: string, entry: CacheEntry): void {
    if (this.lru.has(key)) this.lru.delete(key);
    this.lru.set(key, entry);
    if (this.lru.size > MAX_ENTRIES) {
      const first = this.lru.keys().next().value;
      if (first) this.lru.delete(first);
    }
  }

  private diskPath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_:-]/g, '_');
    return resolve(this.diskRoot, `${safe}.json`);
  }

  /** Test helper — clears both layers. */
  clear(): void {
    this.lru.clear();
  }
}

let instance: SkillCache | null = null;

export function getCache(): SkillCache {
  if (!instance) instance = new SkillCache();
  return instance;
}

/** Test-only — swap the singleton with an isolated-root instance. */
export function setCacheForTesting(c: SkillCache | null): void {
  instance = c;
}

export { SkillCache };
