/**
 * FileIndexer sandbox guard.
 *
 * `indexFile`/`indexDirectory` read whatever path they're handed via
 * `fileAt(path).text()`. When a caller (the knowledge route, the knowledge
 * tool) accepts a path from an untrusted request it passes an `isAllowed`
 * guard so reads stay inside the caller's workspace. For directories the guard
 * is the only thing that catches a symlinked leaf inside an owned tree that
 * points outward — the directory-root check alone misses it.
 *
 * These tests exercise the guard plumbing without the embedding service:
 * `indexFile` rejects a disallowed path before any IO, and empty allowed files
 * return 0 chunks before `getEmbeddingService` is ever called.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileIndexer } from './indexer';
import { fileAt } from '@/utils/fs-file';

let dir: string;
const indexer = new FileIndexer();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'octipus-indexer-guard-'));
  // Empty files so indexFile returns 0 before touching the embedding service.
  writeFileSync(join(dir, 'a.md'), '');
  writeFileSync(join(dir, 'b.md'), '');
});

afterAll(() => { /* tmpdir reaped by OS */ });

describe('indexFile guard', () => {
  test('rejects a disallowed path before reading it', async () => {
    await expect(
      indexer.indexFile('/etc/passwd', 'document', { isAllowed: () => false }),
    ).rejects.toThrow(/outside the allowed workspace/);
  });
});

describe('indexDirectory guard', () => {
  test('skips files the guard rejects, indexes the rest, and records why', async () => {
    const blocked = join(dir, 'b.md');
    const result = await indexer.indexDirectory(dir, ['*.md'], {
      isAllowed: (p) => p !== blocked,
    });

    // a.md passed the guard (empty → 0 chunks, but counted as indexed).
    expect(result.filesIndexed).toBe(1);
    // b.md was skipped with a clear reason, never handed to indexFile.
    expect(result.errors.some((e) => e.includes('b.md') && /outside the allowed workspace/.test(e))).toBe(true);
  });

  test('with no guard, all matching files are processed (back-compat)', async () => {
    const result = await indexer.indexDirectory(dir, ['*.md']);
    expect(result.filesIndexed).toBe(2);
    expect(result.errors).toHaveLength(0);
  });
});
