/**
 * art_transform_sort — stable sort an array of rows by a dotted field path.
 * Numeric and string comparison; mixed types fall back to lexical compare
 * via String() to avoid surprises.
 */

import { applyJsonPath } from '../../refresh';
import type { ToolboxTool } from '../types';

interface Params {
  by: string;
  dir?: 'asc' | 'desc';
}

export const sortTransform: ToolboxTool<Params, unknown[]> = {
  id: 'art_transform_sort',
  family: 'transform',
  description: 'Stable sort an array of rows by a dotted field path, ascending (default) or descending.',
  keywords: ['sort', 'order', 'asc', 'desc', 'rank'],
  defaultPermission: 'ALLOW',
  params: {
    by: { type: 'string', required: true, description: 'Dotted path into each row, e.g. "updated_at".' },
    dir: { type: 'string', enum: ['asc', 'desc'], default: 'asc', description: 'Sort direction.' },
  },
  returns: 'A new array, sorted; original is not mutated.',
  examples: [
    { summary: 'Newest first', params: { by: 'updated_at', dir: 'desc' } },
  ],

  async execute(params, ctx) {
    if (!params.by) throw new Error('art_transform_sort: `by` is required');
    if (!Array.isArray(ctx.input)) throw new Error('art_transform_sort: input must be an array');
    const dir = params.dir === 'desc' ? -1 : 1;
    const copy = [...ctx.input];
    copy.sort((a, b) => {
      const av = applyJsonPath(a, params.by);
      const bv = applyJsonPath(b, params.by);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
    return copy;
  },
};

export default sortTransform;
