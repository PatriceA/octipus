/**
 * art_transform_top_n — take the first `n` elements of an array input.
 * Useful after a sort to surface "top 5 …".
 */

import type { ToolboxTool } from '../types';

interface Params {
  n: number;
}

export const topNTransform: ToolboxTool<Params, unknown[]> = {
  id: 'art_transform_top_n',
  family: 'transform',
  description: 'Take the first `n` rows of an array input — pair with `art_transform_sort`.',
  keywords: ['top', 'limit', 'head', 'first', 'slice'],
  defaultPermission: 'ALLOW',
  params: {
    n: { type: 'number', required: true, description: 'Number of rows to keep (must be ≥ 1).' },
  },
  returns: 'Array with at most `n` elements (input order preserved).',
  examples: [
    { summary: 'Top 5 most recent', params: { n: 5 } },
  ],

  async execute(params, ctx) {
    if (typeof params.n !== 'number' || params.n < 1) {
      throw new Error('art_transform_top_n: `n` must be a positive number');
    }
    if (!Array.isArray(ctx.input)) throw new Error('art_transform_top_n: input must be an array');
    return ctx.input.slice(0, Math.floor(params.n));
  },
};

export default topNTransform;
