/**
 * art_transform_diff — compare the current input array against the previous
 * snapshot of the same source and emit `{ added, removed, changed,
 * unchanged }` row lists. Identification uses a dotted-path key (default
 * "id"); change detection compares JSON.stringify of all other fields.
 *
 * Only works when `inputName` points at a SOURCE (not another transform)
 * since only sources have a persisted previous snapshot. Wire a
 * `art_transform_columns`-style normalisation upstream if you need to
 * compare a projected view.
 */

import { applyJsonPath } from '../../refresh';
import type { ToolboxTool } from '../types';

interface Params {
  key?: string;
  /** When true, omit `unchanged` for compactness. */
  omitUnchanged?: boolean;
}

interface DiffResult {
  added: unknown[];
  removed: unknown[];
  changed: { before: unknown; after: unknown }[];
  unchanged?: unknown[];
  hasPrevious: boolean;
}

export const diffTransform: ToolboxTool<Params, DiffResult> = {
  id: 'art_transform_diff',
  family: 'transform',
  description: 'Compare current rows against the previous source snapshot — returns added / removed / changed lists.',
  keywords: ['diff', 'delta', 'changed', 'added', 'removed', 'since'],
  defaultPermission: 'ALLOW',
  params: {
    key: {
      type: 'string',
      default: 'id',
      description: 'Dotted path used to identify rows across snapshots.',
    },
    omitUnchanged: {
      type: 'boolean',
      default: false,
      description: 'When true, omit `unchanged` from the output for a leaner payload.',
    },
  },
  returns:
    '`{ added, removed, changed: [{before, after}], unchanged?, hasPrevious }`. `hasPrevious: false` on first refresh (everything will be in `added`).',
  examples: [
    {
      summary: 'Show new + closed issues since last refresh',
      params: { key: 'id' },
    },
  ],
  tips: [
    'Requires inputName to be a SOURCE — transform-fed inputs return everything in `added` with `hasPrevious: false`.',
    'Bind a list/table widget to `<transform-name>.added` / `.removed` for a "what changed" panel.',
  ],

  async execute(params, ctx) {
    if (!Array.isArray(ctx.input)) {
      throw new Error('art_transform_diff: input must be an array');
    }
    const keyPath = params.key ?? 'id';
    const current = ctx.input;
    const previous = Array.isArray(ctx.previousInput) ? ctx.previousInput : null;

    if (!previous) {
      return {
        added: current,
        removed: [],
        changed: [],
        unchanged: params.omitUnchanged ? undefined : [],
        hasPrevious: false,
      };
    }

    const prevByKey = new Map<string, unknown>();
    for (const row of previous) {
      const k = idOf(row, keyPath);
      if (k != null) prevByKey.set(k, row);
    }
    const curByKey = new Map<string, unknown>();
    for (const row of current) {
      const k = idOf(row, keyPath);
      if (k != null) curByKey.set(k, row);
    }

    const added: unknown[] = [];
    const changed: { before: unknown; after: unknown }[] = [];
    const unchanged: unknown[] = [];

    for (const [k, after] of curByKey) {
      const before = prevByKey.get(k);
      if (before === undefined) {
        added.push(after);
      } else if (!sameShape(before, after, keyPath)) {
        changed.push({ before, after });
      } else {
        unchanged.push(after);
      }
    }
    const removed: unknown[] = [];
    for (const [k, before] of prevByKey) {
      if (!curByKey.has(k)) removed.push(before);
    }

    return {
      added,
      removed,
      changed,
      unchanged: params.omitUnchanged ? undefined : unchanged,
      hasPrevious: true,
    };
  },
};

function idOf(row: unknown, keyPath: string): string | null {
  const v = applyJsonPath(row, keyPath);
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function sameShape(a: unknown, b: unknown, keyPath: string): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  const ao = withoutKey(a as Record<string, unknown>, keyPath);
  const bo = withoutKey(b as Record<string, unknown>, keyPath);
  return JSON.stringify(ao) === JSON.stringify(bo);
}

function withoutKey(row: Record<string, unknown>, keyPath: string): Record<string, unknown> {
  // Only strip the top-level key segment — full path-stripping is more
  // surgery than worth here; agents using nested keys are rare and they can
  // always include the key in the diff if they want it.
  const top = keyPath.split('.')[0];
  if (!(top in row)) return row;
  const { [top]: _omit, ...rest } = row;
  return rest;
}

export default diffTransform;
