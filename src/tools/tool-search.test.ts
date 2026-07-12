import { beforeEach, describe, expect, test } from 'bun:test';
import {
  _clearToolEmbeddingCache,
  cosineSimilarity,
  type Embedder,
  rankToolsByQuery,
  type ToolSummary,
} from './tool-search';

beforeEach(() => _clearToolEmbeddingCache());

describe('cosineSimilarity', () => {
  test('identical vectors → 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  test('orthogonal vectors → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  test('opposite vectors → -1', () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 6);
  });
  test('degenerate input → 0 (no NaN)', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0); // length mismatch
  });
});

// Toy embedder: 3 dims = [pdf, slack, filler]. Similar text → similar vector.
const fakeEmbed: Embedder = (text) => {
  const t = text.toLowerCase();
  return Promise.resolve([t.includes('pdf') ? 1 : 0, t.includes('slack') ? 1 : 0, 0.1]);
};

const TOOLS: ToolSummary[] = [
  { name: 'read_pdf', description: 'Extract text from a PDF document' },
  { name: 'send_slack', description: 'Send a message to a Slack channel' },
  { name: 'run_shell', description: 'Run a shell command' },
];

describe('rankToolsByQuery', () => {
  test('ranks the semantically relevant tool first', async () => {
    const ranked = await rankToolsByQuery(TOOLS, 'I need to read a pdf file', 3, fakeEmbed);
    expect(ranked).not.toBeNull();
    expect(ranked?.[0].name).toBe('read_pdf');
  });

  test('a different query surfaces a different tool', async () => {
    const ranked = await rankToolsByQuery(TOOLS, 'post to slack', 3, fakeEmbed);
    expect(ranked?.[0].name).toBe('send_slack');
  });

  test('honors the limit', async () => {
    const ranked = await rankToolsByQuery(TOOLS, 'pdf', 1, fakeEmbed);
    expect(ranked?.length).toBe(1);
  });

  test('empty query → null (caller falls back to full list)', async () => {
    expect(await rankToolsByQuery(TOOLS, '   ', 3, fakeEmbed)).toBeNull();
    expect(await rankToolsByQuery(TOOLS, '', 3, fakeEmbed)).toBeNull();
  });

  test('empty tool list → null', async () => {
    expect(await rankToolsByQuery([], 'pdf', 3, fakeEmbed)).toBeNull();
  });

  test('embedder failure → null (graceful fallback, no throw)', async () => {
    const boom: Embedder = () => Promise.reject(new Error('no provider'));
    expect(await rankToolsByQuery(TOOLS, 'pdf', 3, boom)).toBeNull();
  });

  test('caches tool embeddings (each tool embedded once across calls)', async () => {
    let calls = 0;
    const counting: Embedder = (t) => {
      calls++;
      return fakeEmbed(t);
    };
    await rankToolsByQuery(TOOLS, 'pdf', 3, counting); // 1 query + 3 tools = 4
    const afterFirst = calls;
    expect(afterFirst).toBe(4);
    await rankToolsByQuery(TOOLS, 'slack', 3, counting); // 1 query only; tools cached
    expect(calls).toBe(afterFirst + 1);
  });
});
