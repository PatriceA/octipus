/**
 * art_transform_jsonpath — extract a sub-tree of the input using a dotted
 * path with numeric segments for array indexing.
 *
 *   { a: { b: [ {c: 1} ] } } + path "a.b.0.c"  →  1
 */

import { applyJsonPath } from '../../refresh';
import type { ToolboxTool } from '../types';

interface Params {
  path: string;
}

export const jsonpathTransform: ToolboxTool<Params, unknown> = {
  id: 'art_transform_jsonpath',
  family: 'transform',
  description: 'Extract a sub-tree from the input using a dotted path (numeric segments index arrays).',
  keywords: ['jsonpath', 'pluck', 'extract', 'narrow', 'path', 'dot'],
  defaultPermission: 'ALLOW',
  params: {
    path: {
      type: 'string',
      required: true,
      description: 'Dotted path, e.g. "data.items.0.name". Missing segments yield undefined.',
    },
  },
  returns: 'The value at the path, or `undefined` if any segment misses.',
  examples: [
    {
      summary: 'Pluck the first issue title',
      params: { path: 'items.0.title' },
    },
  ],
  tips: ['Use `art_transform_columns` (phase 3) when you need to remap multiple fields at once.'],

  async execute(params, ctx) {
    if (!params.path) throw new Error('art_transform_jsonpath: missing `path`');
    return applyJsonPath(ctx.input, params.path);
  },
};

export default jsonpathTransform;
