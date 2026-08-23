/**
 * Work-stream metadata channel — the diff (and any future UI-only preview data)
 * a tool attaches to its result must reach the renderer but NEVER the model.
 */
import { describe, expect, test } from 'vitest';
import { renderToolActivity } from '@/core/work-stream/renderers';
import { readWorkStreamMeta, stripWorkStreamMeta, WORK_STREAM_META_KEY } from './work-stream';

describe('work-stream meta channel', () => {
  const resultWithDiff = {
    success: true,
    path: '/work/poem.md',
    bytesWritten: 12,
    [WORK_STREAM_META_KEY]: { diff: { patch: '-old\n+new', added: 1, removed: 1 } },
  };

  test('readWorkStreamMeta extracts the attached metadata', () => {
    expect(readWorkStreamMeta(resultWithDiff)?.diff?.added).toBe(1);
  });

  test('readWorkStreamMeta returns null when absent / non-object', () => {
    expect(readWorkStreamMeta({ success: true })).toBeNull();
    expect(readWorkStreamMeta('a string')).toBeNull();
    expect(readWorkStreamMeta([1, 2])).toBeNull();
    expect(readWorkStreamMeta(null)).toBeNull();
  });

  test('stripWorkStreamMeta removes the key but keeps the real payload', () => {
    const safe = stripWorkStreamMeta(resultWithDiff) as Record<string, unknown>;
    expect(safe[WORK_STREAM_META_KEY]).toBeUndefined();
    expect(safe.success).toBe(true);
    expect(safe.path).toBe('/work/poem.md');
    expect(safe.bytesWritten).toBe(12);
  });

  test('stripWorkStreamMeta passes through values without the key', () => {
    expect(stripWorkStreamMeta('text')).toBe('text');
    const plain = { a: 1 };
    expect(stripWorkStreamMeta(plain)).toBe(plain);
  });

  test('does not mutate the original result (renderer still sees the diff after strip)', () => {
    stripWorkStreamMeta(resultWithDiff);
    expect(readWorkStreamMeta(resultWithDiff)?.diff?.removed).toBe(1);
  });

  test('contract: renderer surfaces the diff, the model-safe result does not', () => {
    // Renderer (UI path) gets a diff preview...
    const activity = renderToolActivity('filesystem__write_file', { path: 'poem.md' }, resultWithDiff, true);
    expect(activity.result?.kind).toBe('diff');

    // ...but the model-bound result carries no diff/meta at all.
    const safe = stripWorkStreamMeta(resultWithDiff);
    expect(JSON.stringify(safe)).not.toContain('diff');
    expect(JSON.stringify(safe)).not.toContain('patch');
  });
});
