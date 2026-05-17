/**
 * art_collect_octipus_tool — invoke any registered Octipus agent tool as a
 * data source. The wrapper runs under the source's principal so vault ACLs
 * and per-user secrets apply identically to a chat invocation.
 *
 * Use this when an existing tool already returns the data you want (e.g.
 * `websearch__search`, `documents__list`) — don't re-implement the fetch.
 */

import { buildSyntheticContext } from '../../refresh';
import type { ToolboxTool } from '../types';

interface Params {
  /** Full handler name, e.g. `websearch__search` or `documents__list`. */
  tool: string;
  /** Arguments forwarded to the underlying handler. */
  params?: Record<string, unknown>;
}

export const octipusToolCollector: ToolboxTool<Params, unknown> = {
  id: 'art_collect_octipus_tool',
  family: 'collect',
  description:
    'Invoke any registered Octipus agent tool by handler name; the return value becomes the snapshot.',
  keywords: ['tool', 'invoke', 'handler', 'agent', 'reuse'],
  defaultPermission: 'ASK',
  params: {
    tool: {
      type: 'string',
      required: true,
      description: 'Handler name in `<toolId>__<toolName>` form, e.g. `websearch__search`.',
    },
    params: {
      type: 'object',
      description: 'Arguments forwarded to the handler verbatim.',
    },
  },
  returns: 'Whatever the underlying tool returns — pipe through a transform if you need a specific shape.',
  examples: [
    {
      summary: 'Run a websearch and store the results',
      params: { tool: 'websearch__search', params: { query: 'octipus releases' } },
    },
  ],
  tips: [
    'Find available handlers via `getToolRegistry().getAllToolHandlers()` or the `/tools/all` endpoint.',
    'Tools that need OAuth / vault entries will fail at refresh time if the principal lacks them.',
  ],

  async execute(params, ctx) {
    if (!params.tool) throw new Error('art_collect_octipus_tool: missing `tool`');
    const { getToolRegistry } = await import('@/tools/registry');
    const registry = getToolRegistry();
    const handler = registry.getAllToolHandlers().find((h) => h.name === params.tool);
    if (!handler) throw new Error(`tool not registered: ${params.tool}`);
    return handler.execute(params.params ?? {}, buildSyntheticContext(ctx.principalId));
  },
};

export default octipusToolCollector;
