/**
 * art_transform_group_count — group rows by a dotted key path and count
 * occurrences per key. Returns `[{ key, count }]` sorted desc by count.
 *
 * Path supports an array-fanout segment `[]` so each element contributes
 * one count per occurrence — useful for label / tag rollups:
 *
 *   rows: [{ labels: [{name:'bug'},{name:'p1'}] }, { labels:[{name:'bug'}] }]
 *   by:   "labels[].name"
 *   →     [{ key: 'bug', count: 2 }, { key: 'p1', count: 1 }]
 */

import type { ToolboxTool } from '../types';

interface Params {
  by: string;
  top?: number;
}

interface Bucket { key: string; count: number; }

export const groupCountTransform: ToolboxTool<Params, Bucket[]> = {
  id: 'art_transform_group_count',
  family: 'transform',
  description: 'Group rows by a dotted path and count occurrences; `[]` segment fans out arrays.',
  keywords: ['group', 'count', 'aggregate', 'tally', 'rollup', 'histogram'],
  defaultPermission: 'ALLOW',
  params: {
    by: {
      type: 'string',
      required: true,
      description: 'Dotted path. Insert `[]` to fan out an array segment (e.g. "labels[].name").',
    },
    top: { type: 'number', description: 'Keep at most N highest-count buckets.' },
  },
  returns: 'Array of `{ key, count }` sorted by count desc.',
  examples: [
    {
      summary: 'Top 8 labels across all issues',
      params: { by: 'labels[].name', top: 8 },
    },
  ],
  tips: [
    'Buckets with null/undefined keys are skipped.',
    'Bind a pie/bar widget to this output: `bind: { data: "<transform-name>" }`.',
  ],

  async execute(params, ctx) {
    if (!params.by) throw new Error('art_transform_group_count: `by` is required');
    if (!Array.isArray(ctx.input)) {
      throw new Error('art_transform_group_count: input must be an array');
    }

    const counts = new Map<string, number>();
    for (const row of ctx.input) {
      for (const k of resolveWithFanout(row, params.by)) {
        if (k == null) continue;
        const key = String(k);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    let out: Bucket[] = [...counts.entries()].map(([key, count]) => ({ key, count }));
    out.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    if (typeof params.top === 'number' && params.top > 0) {
      out = out.slice(0, Math.floor(params.top));
    }
    return out;
  },
};

/**
 * Resolve a dotted path that may contain `[]` segments which fan out arrays.
 * Returns the list of values reached.
 */
function resolveWithFanout(root: unknown, path: string): unknown[] {
  const parts = path.split('.');
  let frontier: unknown[] = [root];
  for (const part of parts) {
    const fanout = part.endsWith('[]');
    const key = fanout ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const item of frontier) {
      if (item == null) continue;
      let v: unknown;
      if (key === '') {
        v = item;
      } else if (Array.isArray(item)) {
        v = item[Number(key)];
      } else if (typeof item === 'object') {
        v = (item as Record<string, unknown>)[key];
      }
      if (fanout && Array.isArray(v)) next.push(...v);
      else if (v !== undefined) next.push(v);
    }
    frontier = next;
  }
  return frontier;
}

export default groupCountTransform;
