import { describe, expect, test } from 'bun:test';
import type { ToolboxContext } from '../types';
import { diffTransform } from './diff';

const ctx = (input: unknown, previousInput?: unknown): ToolboxContext => ({
  principalId: '', workspaceId: '', input, previousInput,
});

describe('art_transform_diff', () => {
  test('first refresh — no previous, everything in added', async () => {
    const out = await diffTransform.execute(
      { key: 'id' },
      ctx([{ id: 1 }, { id: 2 }], undefined),
    );
    expect(out.hasPrevious).toBe(false);
    expect(out.added).toHaveLength(2);
    expect(out.removed).toEqual([]);
    expect(out.changed).toEqual([]);
  });

  test('detects added / removed / changed / unchanged', async () => {
    const previous = [
      { id: 1, title: 'a' },
      { id: 2, title: 'b' },
      { id: 3, title: 'c' },
    ];
    const current = [
      { id: 1, title: 'a' },           // unchanged
      { id: 2, title: 'b-updated' },   // changed
      { id: 4, title: 'd' },           // added
      // id 3 removed
    ];
    const out = await diffTransform.execute({ key: 'id' }, ctx(current, previous));
    expect(out.hasPrevious).toBe(true);
    expect(out.added.map((r) => (r as { id: number }).id)).toEqual([4]);
    expect(out.removed.map((r) => (r as { id: number }).id)).toEqual([3]);
    expect(out.changed).toHaveLength(1);
    expect((out.changed[0].after as { id: number }).id).toBe(2);
    expect((out.changed[0].before as { title: string }).title).toBe('b');
    expect(out.unchanged?.map((r) => (r as { id: number }).id)).toEqual([1]);
  });

  test('omitUnchanged drops the unchanged list', async () => {
    const out = await diffTransform.execute(
      { key: 'id', omitUnchanged: true },
      ctx([{ id: 1 }], [{ id: 1 }]),
    );
    expect(out.unchanged).toBeUndefined();
  });

  test('rows without the key are skipped (not counted as added/removed)', async () => {
    const out = await diffTransform.execute(
      { key: 'id' },
      ctx([{ id: 1 }, { noid: true }], [{ id: 1 }]),
    );
    expect(out.added).toEqual([]);
  });

  test('throws on non-array input', async () => {
    await expect(diffTransform.execute({}, ctx({} as never))).rejects.toThrow(/array/);
  });
});
