/**
 * Built-in tool discovery meta-tools (`list_tools` / `describe_tool`).
 *
 * The lazy counterpart to advertising every built-in tool's full JSON schema on
 * every request. A worker on the lazy path advertises only its core tools plus
 * these two entry points; the long-tail handlers stay registered (callable by
 * name) but their schemas are fetched on demand. Mirrors the MCP meta-tools in
 * `src/mcp/bridge.ts` and the `art_toolbox_describe` precedent.
 *
 * Unlike MCP's `mcp_call_tool`, there is no `call_tool` indirection here: the
 * long-tail handlers are registered in the executor, so the model calls them
 * *directly by name* once `describe_tool` has given it the schema.
 *
 * See docs/plans/lazy-tool-discovery.md.
 */

import type { ToolHandler } from '@/core/agent-base';

const TOOL_DISCOVERY_TOOL_ID = 'tool_discovery';

/**
 * Build the `list_tools` / `describe_tool` handlers closed over a worker's
 * long-tail set. Returns an empty array when there's nothing to discover (so we
 * don't advertise dead meta-tools).
 */
export function buildToolDiscoveryHandlers(longTail: ToolHandler[]): ToolHandler[] {
  if (longTail.length === 0) return [];

  const byName = new Map(longTail.map((t) => [t.name, t]));

  return [
    {
      name: 'list_tools',
      description:
        'List additional tools available to you beyond the ones already shown. ' +
        'Returns each tool name and a one-line description (no parameters). ' +
        'Call describe_tool with a name to get its parameter schema before using it, ' +
        'then call the tool directly by its name.',
      parameters: {
        type: 'object',
        properties: {},
      },
      toolId: TOOL_DISCOVERY_TOOL_ID,
      execute: async () =>
        Array.from(byName.values()).map((t) => ({
          name: t.name,
          description: t.description,
        })),
    },
    {
      name: 'describe_tool',
      description:
        'Get the full parameter schema for one of the additional tools returned by list_tools. ' +
        'After describing a tool you can call it directly by its name.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The tool name to describe (from list_tools).',
          },
        },
        required: ['name'],
      },
      toolId: TOOL_DISCOVERY_TOOL_ID,
      execute: async (args) => {
        const name = args.name;
        if (typeof name !== 'string') {
          throw new Error(`describe_tool: 'name' must be a string, got ${typeof name}.`);
        }
        const handler = byName.get(name);
        if (!handler) {
          throw new Error(
            `Unknown tool '${name}'. Call list_tools to see the available tool names.`,
          );
        }
        return {
          name: handler.name,
          description: handler.description,
          parameters: handler.parameters,
        };
      },
    },
  ];
}
