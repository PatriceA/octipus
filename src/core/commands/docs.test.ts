import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { EmbeddingService, type SearchResult } from '@/core/rag/embeddings';
import './docs'; // self-registers the /docs command
import { getCommand } from './registry';

/**
 * Tests for the `/docs` command. We spy on EmbeddingService.prototype rather
 * than mock.module (which is process-wide in bun and would leak into other
 * suites), so no DB or embedding provider is touched.
 */

const hybridSpy = spyOn(EmbeddingService.prototype, 'hybridSearch');

function ctx(args: string) {
  return { sessionId: 'sess-1', userId: 'user-1', args };
}

function hit(over: Partial<SearchResult>): SearchResult {
  return {
    id: 'id',
    content: 'content',
    abstract: null,
    purpose: 'document',
    sourceId: '/app/docs/X.md',
    similarity: 0.5,
    metadata: {},
    ...over,
  };
}

beforeEach(() => hybridSpy.mockReset());
afterEach(() => hybridSpy.mockReset());

describe('/docs command', () => {
  test('is registered and listed', () => {
    const cmd = getCommand('docs');
    expect(cmd).toBeDefined();
    expect(cmd!.description.toLowerCase()).toContain('documentation');
  });

  test('prompts for usage when called with no query (no search)', async () => {
    const cmd = getCommand('docs')!;
    const res = await cmd.execute(ctx('   '));
    expect(res.response).toContain('Usage');
    expect(hybridSpy).not.toHaveBeenCalled();
  });

  test('searches document rows and formats only octipus-docs hits', async () => {
    hybridSpy.mockResolvedValue([
      hit({
        sourceId: '/app/docs/CHANNELS.md',
        abstract: 'Set up Telegram by creating a bot with BotFather.',
        sectionPath: ['Channels', 'Telegram'],
        metadata: { source: 'octipus-docs', filePath: '/app/docs/CHANNELS.md' },
      }),
      // A non-docs document row that must be filtered out:
      hit({
        sourceId: '/uploads/random.md',
        abstract: 'some user upload about telegrams',
        metadata: { source: undefined, filePath: '/uploads/random.md' },
      }),
    ]);

    const cmd = getCommand('docs')!;
    const res = await cmd.execute(ctx('how do I set up telegram'));

    expect(hybridSpy).toHaveBeenCalledTimes(1);
    // purpose filter must be 'document'
    const [, , purpose] = hybridSpy.mock.calls[0];
    expect(purpose).toBe('document');

    expect(res.response).toContain('Channels › Telegram');
    expect(res.response).toContain('BotFather');
    expect(res.response).toContain('CHANNELS.md');
    // The non-octipus-docs hit must not appear.
    expect(res.response).not.toContain('user upload');
  });

  test('reports no-match when no octipus-docs rows are returned', async () => {
    hybridSpy.mockResolvedValue([
      hit({ metadata: { source: 'some-other-corpus', filePath: '/x.md' } }),
    ]);
    const cmd = getCommand('docs')!;
    const res = await cmd.execute(ctx('quantum teleportation'));
    expect(res.response.toLowerCase()).toContain('no product documentation matches');
  });

  test('falls back gracefully when the KB throws', async () => {
    hybridSpy.mockRejectedValue(new Error('KB not ready'));
    const cmd = getCommand('docs')!;
    const res = await cmd.execute(ctx('anything'));
    expect(res.response.toLowerCase()).toContain('unavailable');
  });
});
