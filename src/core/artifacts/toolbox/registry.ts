/**
 * Toolbox registry — central catalog of every collector, transform, widget,
 * and exporter that artifacts can name. Singleton, populated lazily by the
 * discovery scan in `discovery.ts`. Lookup is by stable id; search returns
 * ranked index entries for `art_toolbox_search`.
 *
 * Tools are NOT executed through `getToolRegistry()` (the agent tool
 * registry) — they are executed inside the artifact refresh/render pipeline
 * via `dispatchCollector()` etc. Keeping the registries separate keeps the
 * agent's tool space from ballooning by every widget / transform we add.
 */

import { coreLogger } from '@/utils/logger';
import type {
  ToolboxDescription,
  ToolboxFamily,
  ToolboxIndexEntry,
  ToolboxTool,
} from './types';

class ToolboxRegistry {
  private byId = new Map<string, ToolboxTool>();
  private loaded = false;

  /** Register a tool. Throws on duplicate id (loud failure). */
  register(tool: ToolboxTool): void {
    if (this.byId.has(tool.id)) {
      throw new Error(`toolbox: duplicate tool id "${tool.id}"`);
    }
    if (!tool.id.startsWith(`art_${tool.family}_`)) {
      throw new Error(
        `toolbox: tool id "${tool.id}" must match prefix art_${tool.family}_`,
      );
    }
    this.byId.set(tool.id, tool);
    coreLogger.debug({ id: tool.id, family: tool.family }, 'toolbox.register');
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): ToolboxTool | null {
    return this.byId.get(id) ?? null;
  }

  /** Mark the registry as loaded so `requireLoaded()` checks pass. */
  markLoaded(): void {
    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** Drop everything — for test isolation only. */
  reset(): void {
    this.byId.clear();
    this.loaded = false;
  }

  /** Compact list, optionally filtered. */
  list(opts: { family?: ToolboxFamily } = {}): ToolboxIndexEntry[] {
    const out: ToolboxIndexEntry[] = [];
    for (const tool of this.byId.values()) {
      if (opts.family && tool.family !== opts.family) continue;
      out.push({ id: tool.id, family: tool.family, description: tool.description });
    }
    // Stable ordering: family then id, so list output is diff-friendly.
    out.sort((a, b) => (a.family + a.id).localeCompare(b.family + b.id));
    return out;
  }

  /**
   * Hybrid keyword + token search. Embedding search arrives in phase 2 once
   * we have a backfill cron — for now substring match against description +
   * keywords + id is plenty for the catalog size we'll have.
   */
  search(query: string, k = 8): ToolboxIndexEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list().slice(0, k);
    const tokens = q.split(/\s+/).filter(Boolean);

    type Scored = { entry: ToolboxIndexEntry; score: number };
    const scored: Scored[] = [];

    for (const tool of this.byId.values()) {
      const haystack = (
        tool.id + ' ' + tool.description + ' ' + tool.keywords.join(' ')
      ).toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (!haystack.includes(t)) continue;
        // Boost matches in id and keywords (more intentional than prose).
        if (tool.id.toLowerCase().includes(t)) score += 3;
        if (tool.keywords.some((k) => k.toLowerCase() === t)) score += 2;
        score += 1;
      }
      if (score > 0) {
        scored.push({
          entry: { id: tool.id, family: tool.family, description: tool.description },
          score,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    return scored.slice(0, k).map((s) => s.entry);
  }

  describe(id: string): ToolboxDescription | null {
    const tool = this.byId.get(id);
    if (!tool) return null;
    return {
      id: tool.id,
      family: tool.family,
      description: tool.description,
      keywords: tool.keywords,
      params: tool.params,
      returns: tool.returns,
      examples: tool.examples ?? [],
      defaultPermission: tool.defaultPermission,
      tips: tool.tips ?? [],
    };
  }
}

let _instance: ToolboxRegistry | null = null;

export function getToolboxRegistry(): ToolboxRegistry {
  if (!_instance) _instance = new ToolboxRegistry();
  return _instance;
}

/** Test helper — drop and rebuild a fresh registry. */
export function _resetToolboxRegistryForTests(): void {
  _instance = new ToolboxRegistry();
}

export type { ToolboxRegistry };
