/**
 * art_collect_mcp — call a tool on an external MCP server through the
 * MCP bridge. Server connection lifetimes / auth are owned by the bridge;
 * we just dispatch.
 */

import type { ToolboxTool } from '../types';

interface Params {
  server: string;
  tool: string;
  params?: Record<string, unknown>;
}

export const mcpCollector: ToolboxTool<Params, unknown> = {
  id: 'art_collect_mcp',
  family: 'collect',
  description: 'Call a tool on an external MCP server through the MCP bridge.',
  keywords: ['mcp', 'external', 'bridge', 'tool', 'server'],
  defaultPermission: 'ASK',
  params: {
    server: { type: 'string', required: true, description: 'Configured MCP server id.' },
    tool: { type: 'string', required: true, description: 'Tool name on that server.' },
    params: {
      type: 'object',
      description: 'Arguments forwarded to the MCP tool call.',
    },
  },
  returns: 'Whatever the MCP tool returns (typically `{ content: [...] }`).',
  examples: [
    {
      summary: 'List GitHub PRs via the configured github MCP server',
      params: {
        server: 'github',
        tool: 'list_pull_requests',
        params: { owner: 'PatriceA', repo: 'octipus', state: 'open' },
      },
    },
  ],
  tips: [
    'MCP server ids are workspace-configured — list them via the MCP settings panel.',
    'The bridge handles reconnects; transient failures surface as `art_collect_mcp` errors.',
  ],

  async execute(params) {
    if (!params.server || !params.tool) {
      throw new Error('art_collect_mcp: missing `server` or `tool`');
    }
    const { getMCPBridge } = await import('@/mcp');
    const bridge = getMCPBridge();
    return bridge.callTool(params.server, params.tool, (params.params ?? {}) as Record<string, unknown>);
  },
};

export default mcpCollector;
