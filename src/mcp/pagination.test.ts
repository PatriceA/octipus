import { describe, expect, it } from 'vitest';
import { drainPages } from './bridge';
import type { MCPProtocol } from './protocol';

/**
 * A 55-tool server showed up as 26 tools because only the first page of
 * `tools/list` was read and `nextCursor` was dropped.
 */
describe('drainPages', () => {
  const protocolWith = (pages: Array<{ tools: unknown[]; nextCursor?: string }>) => {
    const seen: Array<unknown> = [];
    let i = 0;
    return {
      seen,
      protocol: {
        sendRequest: async (_send: unknown, _method: string, params?: unknown) => {
          seen.push(params);
          return pages[i++];
        },
      } as unknown as MCPProtocol,
    };
  };

  it('follows nextCursor until the server stops handing one back', async () => {
    const { protocol, seen } = protocolWith([
      { tools: [1, 2], nextCursor: 'c1' },
      { tools: [3, 4], nextCursor: 'c2' },
      { tools: [5] },
    ]);
    const tools = await drainPages<number>(() => {}, protocol, 'tools/list', 'tools');
    expect(tools).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toEqual([undefined, { cursor: 'c1' }, { cursor: 'c2' }]);
  });

  it('returns a single page unchanged', async () => {
    const { protocol } = protocolWith([{ tools: [1] }]);
    expect(await drainPages<number>(() => {}, protocol, 'tools/list', 'tools')).toEqual([1]);
  });
});
