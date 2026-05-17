/**
 * art_transform_filter — keep rows where `where.field` matches `where.value`
 * under operator `where.op`. Input must be an array; non-array input is an
 * error (loud failure).
 */

import { applyJsonPath } from '../../refresh';
import type { ToolboxTool } from '../types';

type Op = 'eq' | 'neq' | 'in' | 'gt' | 'lt' | 'contains';

interface Params {
  where: { field: string; op: Op; value: unknown };
}

const OPS: readonly Op[] = ['eq', 'neq', 'in', 'gt', 'lt', 'contains'];

export const filterTransform: ToolboxTool<Params, unknown[]> = {
  id: 'art_transform_filter',
  family: 'transform',
  description: 'Keep rows whose `field` matches `value` under operator `op` (eq/neq/in/gt/lt/contains).',
  keywords: ['filter', 'where', 'rows', 'match', 'predicate'],
  defaultPermission: 'ALLOW',
  params: {
    where: {
      type: 'object',
      required: true,
      description: '`{ field: <dotted path on each row>, op: eq|neq|in|gt|lt|contains, value }`',
    },
  },
  returns: 'Filtered array (same row shape as input).',
  examples: [
    {
      summary: 'Only open issues',
      params: { where: { field: 'state', op: 'eq', value: 'open' } },
    },
    {
      summary: 'Title contains "bug"',
      params: { where: { field: 'title', op: 'contains', value: 'bug' } },
    },
  ],
  tips: [
    '`in` expects `value` to be an array.',
    '`contains` is case-sensitive substring on strings.',
  ],

  async execute(params, ctx) {
    const w = params.where;
    if (!w || typeof w.field !== 'string') {
      throw new Error('art_transform_filter: `where.field` is required');
    }
    if (!OPS.includes(w.op)) {
      throw new Error(`art_transform_filter: unknown op "${w.op}" (use ${OPS.join('|')})`);
    }
    if (!Array.isArray(ctx.input)) {
      throw new Error('art_transform_filter: input must be an array');
    }
    return ctx.input.filter((row) => match(applyJsonPath(row, w.field), w.op, w.value));
  },
};

function match(actual: unknown, op: Op, expected: unknown): boolean {
  switch (op) {
    case 'eq': return actual === expected;
    case 'neq': return actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
  }
}

export default filterTransform;
