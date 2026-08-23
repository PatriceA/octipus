import { describe, expect, test } from 'vitest';
import type { ToolboxContext } from '../types';
import { filterTransform } from './filter';
import { groupCountTransform } from './group_count';
import { jsonpathTransform } from './jsonpath';
import { sortTransform } from './sort';
import { topNTransform } from './top_n';

const ctx = (input: unknown): ToolboxContext => ({
  principalId: 'p',
  workspaceId: 'w',
  input,
});

describe('art_transform_jsonpath', () => {
  test('extracts nested values', async () => {
    const result = await jsonpathTransform.execute({ path: 'a.b.0.c' }, ctx({ a: { b: [{ c: 42 }] } }));
    expect(result).toBe(42);
  });
  test('returns undefined on miss', async () => {
    const result = await jsonpathTransform.execute({ path: 'a.b.c' }, ctx({}));
    expect(result).toBeUndefined();
  });
  test('throws when path is missing', async () => {
    await expect(jsonpathTransform.execute({ path: '' }, ctx({}))).rejects.toThrow(/path/);
  });
});

describe('art_transform_filter', () => {
  const rows = [
    { state: 'open', n: 1 },
    { state: 'closed', n: 2 },
    { state: 'open', n: 3 },
  ];

  test('eq keeps matching rows', async () => {
    const result = await filterTransform.execute(
      { where: { field: 'state', op: 'eq', value: 'open' } },
      ctx(rows),
    );
    expect(result).toHaveLength(2);
  });

  test('gt with numbers', async () => {
    const result = await filterTransform.execute(
      { where: { field: 'n', op: 'gt', value: 1 } },
      ctx(rows),
    );
    expect(result).toHaveLength(2);
  });

  test('contains is substring on strings', async () => {
    const result = await filterTransform.execute(
      { where: { field: 'state', op: 'contains', value: 'lose' } },
      ctx(rows),
    );
    expect(result).toHaveLength(1);
  });

  test('rejects non-array input loudly', async () => {
    await expect(filterTransform.execute(
      { where: { field: 'x', op: 'eq', value: 1 } },
      ctx({} as never),
    )).rejects.toThrow(/array/);
  });

  test('rejects unknown op', async () => {
    await expect(filterTransform.execute(
      { where: { field: 'x', op: 'unknown' as never, value: 1 } },
      ctx(rows),
    )).rejects.toThrow(/unknown op/);
  });
});

describe('art_transform_sort', () => {
  test('numeric asc', async () => {
    const result = await sortTransform.execute(
      { by: 'n' },
      ctx([{ n: 3 }, { n: 1 }, { n: 2 }]),
    );
    expect((result as { n: number }[]).map((r) => r.n)).toEqual([1, 2, 3]);
  });
  test('string desc', async () => {
    const result = await sortTransform.execute(
      { by: 's', dir: 'desc' },
      ctx([{ s: 'b' }, { s: 'a' }, { s: 'c' }]),
    );
    expect((result as { s: string }[]).map((r) => r.s)).toEqual(['c', 'b', 'a']);
  });
  test('does not mutate input', async () => {
    const input = [{ n: 2 }, { n: 1 }];
    await sortTransform.execute({ by: 'n' }, ctx(input));
    expect(input.map((r) => r.n)).toEqual([2, 1]);
  });
});

describe('art_transform_top_n', () => {
  test('slices first n', async () => {
    const result = await topNTransform.execute({ n: 2 }, ctx([1, 2, 3, 4]));
    expect(result).toEqual([1, 2]);
  });
  test('n larger than input', async () => {
    const result = await topNTransform.execute({ n: 10 }, ctx([1, 2]));
    expect(result).toEqual([1, 2]);
  });
  test('rejects n < 1', async () => {
    await expect(topNTransform.execute({ n: 0 }, ctx([1]))).rejects.toThrow(/positive/);
  });
});

describe('art_transform_group_count', () => {
  test('counts by simple key', async () => {
    const result = await groupCountTransform.execute(
      { by: 'state' },
      ctx([{ state: 'a' }, { state: 'b' }, { state: 'a' }]),
    );
    expect(result).toEqual([{ key: 'a', count: 2 }, { key: 'b', count: 1 }]);
  });

  test('fans out array segments', async () => {
    const result = await groupCountTransform.execute(
      { by: 'labels[].name' },
      ctx([
        { labels: [{ name: 'bug' }, { name: 'p1' }] },
        { labels: [{ name: 'bug' }] },
        { labels: [] },
      ]),
    );
    expect(result).toEqual([{ key: 'bug', count: 2 }, { key: 'p1', count: 1 }]);
  });

  test('applies top', async () => {
    const result = await groupCountTransform.execute(
      { by: 'k', top: 2 },
      ctx([{ k: 'a' }, { k: 'b' }, { k: 'c' }, { k: 'a' }, { k: 'b' }, { k: 'a' }]),
    );
    expect(result).toHaveLength(2);
    expect((result as { key: string }[])[0].key).toBe('a');
  });

  test('skips null keys', async () => {
    const result = await groupCountTransform.execute(
      { by: 'k' },
      ctx([{ k: 'a' }, { k: null }, { k: 'a' }]),
    );
    expect(result).toEqual([{ key: 'a', count: 2 }]);
  });
});
