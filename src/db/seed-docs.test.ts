import { describe, expect, mock, test } from 'bun:test';
import { type EmbeddingPurpose, sha256Hex } from '@/core/rag/embeddings';
import { type IndexProductDocsDeps, indexProductDocs } from './seed-docs';

/**
 * Unit tests for the product-docs auto-indexer. All infra (DB, embedding
 * provider, filesystem) is injected via `IndexProductDocsDeps`, so these run
 * in the plain unit suite without a database or a running model.
 */

interface IndexCall {
  purpose: EmbeddingPurpose;
  sourceId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** A fake EmbeddingService that records what it was asked to index. */
function makeFakeService(opts: { alreadyIndexed?: Set<string> } = {}) {
  const indexCalls: IndexCall[] = [];
  const deleteCalls: string[] = [];
  // Map of sourceId → fileSha currently "stored", to model idempotency.
  const stored = new Map<string, string>();
  const seeded = opts.alreadyIndexed;

  const service = {
    // Mirror the real EmbeddingService.isFileIndexed: a row is "indexed" only
    // when the stored fileSha matches the current file content's sha. A
    // content change therefore returns false (must re-index).
    async isFileIndexed(_purpose: EmbeddingPurpose, sourceId: string, fileContent: string): Promise<boolean> {
      if (seeded?.has(sourceId)) return true;
      const have = stored.get(sourceId);
      return have !== undefined && have === sha256Hex(fileContent);
    },
    async deleteBySource(_purpose: EmbeddingPurpose, sourceId: string): Promise<number> {
      deleteCalls.push(sourceId);
      return stored.delete(sourceId) ? 1 : 0;
    },
    async indexText(
      purpose: EmbeddingPurpose,
      sourceId: string,
      content: string,
      metadata?: Record<string, unknown>,
    ): Promise<number> {
      indexCalls.push({ purpose, sourceId, content, metadata });
      stored.set(sourceId, (metadata?.fileSha as string) ?? sha256Hex(content));
      return 3; // pretend 3 chunks
    },
  };
  return { service, indexCalls, deleteCalls };
}

const DOCS_DIR = '/fake/docs';

/** Files the fake glob/readFile will surface, keyed by path relative to docs dir. */
const FILES: Record<string, string> = {
  'CHANNELS.md': '# Channels\n\nHow to set up Telegram and Slack.',
  'CONFIGURATION.md': '# Configuration\n\nModel providers and settings.',
  'architecture/gateway.md': '# Gateway\n\nWS entry.',
  'guides/tui.md': '# TUI\n\nTerminal client.',
  // Excluded — must never be indexed:
  'CHANGELOG.md': '# Changelog\n\nlots of churn',
  'WEEKLY-CHANGELOG-2026-06.md': '# Weekly\n\nchurn',
  'QA.md': '# QA\n\nhuge noisy file',
};

function makeDeps(over: Partial<IndexProductDocsDeps> = {}): IndexProductDocsDeps {
  return {
    docsDir: DOCS_DIR,
    isReady: () => true,
    listFiles: mock(async () => Object.keys(FILES)),
    readFile: mock(async (abs: string) => {
      const rel = abs.slice(DOCS_DIR.length + 1);
      const content = FILES[rel];
      if (content == null) throw new Error(`unexpected read: ${abs}`);
      return content;
    }),
    ...over,
  };
}

describe('indexProductDocs', () => {
  test('indexes the included docs as global document rows tagged octipus-docs', async () => {
    const { service, indexCalls } = makeFakeService();
    const res = await indexProductDocs(makeDeps({ service }));

    expect(res.ran).toBe(true);
    // 4 included files (CHANNELS, CONFIGURATION, architecture/gateway, guides/tui)
    expect(res.filesIndexed).toBe(4);
    expect(res.chunksStored).toBe(12); // 4 * 3

    const sourceIds = indexCalls.map((c) => c.sourceId).sort();
    expect(sourceIds).toEqual([
      `${DOCS_DIR}/CHANNELS.md`,
      `${DOCS_DIR}/CONFIGURATION.md`,
      `${DOCS_DIR}/architecture/gateway.md`,
      `${DOCS_DIR}/guides/tui.md`,
    ]);

    for (const call of indexCalls) {
      expect(call.purpose).toBe('document');
      expect(call.metadata?.source).toBe('octipus-docs');
      expect(call.metadata?.language).toBe('markdown');
      expect(typeof call.metadata?.fileSha).toBe('string');
      expect((call.metadata?.fileSha as string).length).toBeGreaterThan(0);
      // filePath is the absolute path
      expect(call.metadata?.filePath).toBe(call.sourceId);
    }
  });

  test('excludes CHANGELOG, WEEKLY-CHANGELOG, and QA.md', async () => {
    const { service, indexCalls } = makeFakeService();
    await indexProductDocs(makeDeps({ service }));

    const indexed = indexCalls.map((c) => c.sourceId);
    expect(indexed.some((s) => s.toLowerCase().includes('changelog'))).toBe(false);
    expect(indexed.some((s) => s.toLowerCase().endsWith('/qa.md'))).toBe(false);
  });

  test('is idempotent on a second run — unchanged files are not re-embedded', async () => {
    const { service, indexCalls } = makeFakeService();

    const first = await indexProductDocs(makeDeps({ service }));
    expect(first.filesIndexed).toBe(4);
    expect(indexCalls.length).toBe(4);
    const firstIndexCount = indexCalls.length;

    // Second run over the SAME content: every file is already indexed (same
    // fileSha), so nothing is re-embedded — indexText is not called again.
    const second = await indexProductDocs(makeDeps({ service }));
    expect(second.filesIndexed).toBe(0);
    expect(second.filesSkipped).toBe(4);
    expect(indexCalls.length).toBe(firstIndexCount); // no new indexing work
  });

  test('a changed file is deleted-by-source then re-indexed; unchanged files left alone', async () => {
    const { service, indexCalls, deleteCalls } = makeFakeService();
    await indexProductDocs(makeDeps({ service }));
    expect(indexCalls.length).toBe(4);
    // Delete-before-index runs on the first index too (a harmless 0-row purge),
    // so reset the recorder to isolate the second run's deletes.
    deleteCalls.length = 0;

    // Mutate one file's content and run again.
    const changed: Record<string, string> = { ...FILES, 'CHANNELS.md': '# Channels\n\nUPDATED setup steps.' };
    const deps = makeDeps({
      service,
      readFile: async (abs: string) => {
        const rel = abs.slice(DOCS_DIR.length + 1);
        return changed[rel] ?? FILES[rel];
      },
    });
    const res = await indexProductDocs(deps);

    expect(res.filesIndexed).toBe(1);
    expect(res.filesSkipped).toBe(3);
    // Only the changed file is purged + re-indexed; the other three are skipped.
    expect(deleteCalls).toEqual([`${DOCS_DIR}/CHANNELS.md`]);
    expect(indexCalls.length).toBe(5); // 4 + 1 re-index
    expect(indexCalls[4].sourceId).toBe(`${DOCS_DIR}/CHANNELS.md`);
  });

  test('skips when the KB is not ready (no embedding model) and does not index', async () => {
    const { service, indexCalls } = makeFakeService();
    const res = await indexProductDocs(makeDeps({ service, isReady: () => false }));

    expect(res.ran).toBe(false);
    expect(res.reason).toBe('kb-not-ready');
    expect(indexCalls.length).toBe(0);
  });

  test('returns docs-dir-missing when no files are found', async () => {
    const { service, indexCalls } = makeFakeService();
    const res = await indexProductDocs(makeDeps({ service, listFiles: async () => [] }));

    expect(res.ran).toBe(false);
    expect(res.reason).toBe('docs-dir-missing');
    expect(indexCalls.length).toBe(0);
  });

  test('skips empty files without indexing them', async () => {
    const { service, indexCalls } = makeFakeService();
    const deps = makeDeps({
      service,
      listFiles: async () => ['EMPTY.md', 'CHANNELS.md'],
      readFile: async (abs: string) => (abs.endsWith('EMPTY.md') ? '   \n  ' : FILES['CHANNELS.md']),
    });
    const res = await indexProductDocs(deps);

    expect(res.filesIndexed).toBe(1);
    expect(res.filesSkipped).toBe(1);
    expect(indexCalls.map((c) => c.sourceId)).toEqual([`${DOCS_DIR}/CHANNELS.md`]);
  });

  test('never throws — a failing dependency yields a non-fatal error result', async () => {
    const res = await indexProductDocs({
      docsDir: DOCS_DIR,
      isReady: () => true,
      listFiles: async () => ['CHANNELS.md'],
      readFile: async () => { throw new Error('disk exploded'); },
      service: makeFakeService().service,
    });
    // The per-file read error is caught; the file is just skipped.
    expect(res.ran).toBe(true);
    expect(res.filesIndexed).toBe(0);
  });
});
