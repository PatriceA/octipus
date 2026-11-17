/**
 * Compact toolset — the search-and-execute pattern (Cloudflare's code-mode
 * MCP server, Anthropic's progressive disclosure) for clients that load every
 * tool schema up front.
 *
 * The full server registers its ~90 tools on an inner McpServer that no client
 * connects to directly. The client sees three tools instead:
 *
 * - `octipus_search_tools(query)` → names and one-line descriptions,
 * - `octipus_describe_tool(name)` → one tool's input schema,
 * - `octipus_call_tool(name, arguments)` → the tool's own result, unchanged.
 *
 * The inner server is reached over an in-process MCP connection, so a call
 * takes exactly the path a direct call would: the SDK's argument validation,
 * the per-tool deadline, and the module/capability gating (a disabled tool is
 * neither found nor callable).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const TOOLSETS = ['full', 'compact'] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** The toolset named by `--toolset` / `OCTIPUS_MCP_TOOLSET`; an unknown name is an error, not a silent full set. */
export function parseToolset(value: string | undefined): Toolset {
  if (value === undefined || value === '') return 'full';
  if ((TOOLSETS as readonly string[]).includes(value)) return value as Toolset;
  throw new Error(`Unknown toolset "${value}". Use ${TOOLSETS.map(t => `"${t}"`).join(' or ')}.`);
}

const COMPACT_TOOLS = new Set(['octipus_search_tools', 'octipus_describe_tool', 'octipus_call_tool']);
const SEARCH_LIMIT = 10;

function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n', 1)[0].trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** Tools whose name or description holds the most query words; ties keep name order. */
export function rankTools(tools: Pick<Tool, 'name' | 'description'>[], query: string, limit: number): Pick<Tool, 'name' | 'description'>[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
  return tools
    .map(tool => {
      const hay = `${tool.name.replace(/_/g, ' ')} ${tool.description ?? ''}`.toLowerCase();
      return { tool, score: words.filter(w => hay.includes(w)).length };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(s => s.tool);
}

const text = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Put the three compact tools on `outer`, dispatching to `inner`. Returns the
 * cleanup that closes the in-process connection.
 */
export function registerCompactTools(outer: McpServer, inner: McpServer): () => Promise<void> {
  const client = new Client({ name: 'octipus-compact', version: '1' });
  let connected: Promise<void> | undefined;
  const ready = () => {
    connected ??= (async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await inner.connect(serverSide);
      await client.connect(clientSide);
    })();
    return connected;
  };

  // Read on every call: module gating enables and disables tools at runtime.
  const innerTools = async (): Promise<Tool[]> => {
    await ready();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  };

  outer.tool(
    'octipus_search_tools',
    'Find Octipus tools (agents, chat, sessions, knowledge, notes, tasks, pipelines, skills, settings, media, …) by what you want to do. ' +
      'Returns names and one-line descriptions; read a schema with octipus_describe_tool, then run it with octipus_call_tool.',
    {
      query: z.string().min(1).describe('What you want to do, in a few words, e.g. "spawn an agent" or "search knowledge base"'),
      limit: z.number().int().min(1).max(50).optional().describe(`Maximum results (default ${SEARCH_LIMIT})`),
    },
    async ({ query, limit }) => {
      const tools = await innerTools();
      const hits = rankTools(tools, query, limit ?? SEARCH_LIMIT);
      return text({
        tools: hits.map(t => ({ name: t.name, description: firstLine(t.description) })),
        available: tools.length,
        ...(hits.length ? {} : { hint: 'No tool matched these words. Try other words, or a broader one such as "agent", "session" or "task".' }),
      });
    },
  );

  outer.tool(
    'octipus_describe_tool',
    "An Octipus tool's full description and input schema, by exact name (from octipus_search_tools).",
    { name: z.string().min(1) },
    async ({ name }) => {
      const tool = (await innerTools()).find(t => t.name === name);
      if (!tool) return text(`Unknown or unavailable Octipus tool "${name}". Find tools with octipus_search_tools.`, true);
      return text({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      });
    },
  );

  outer.tool(
    'octipus_call_tool',
    'Run an Octipus tool by exact name with its arguments (schema from octipus_describe_tool). Returns that tool\'s own result.',
    {
      name: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).optional().describe('The tool\'s arguments, as its input schema describes'),
    },
    async ({ name, arguments: args }) => {
      if (COMPACT_TOOLS.has(name)) return text(`"${name}" is called directly, not through octipus_call_tool.`, true);
      await ready();
      try {
        return (await client.callTool({ name, arguments: args ?? {} })) as CallToolResult;
      } catch (error) {
        // Unknown, disabled, or arguments the tool's schema rejects: the SDK
        // answers with a protocol error; the model gets it as a tool error.
        return text(`Octipus tool "${name}" failed: ${(error as Error).message}`, true);
      }
    },
  );

  return async () => {
    if (!connected) return;
    await client.close();
    await inner.close();
  };
}
