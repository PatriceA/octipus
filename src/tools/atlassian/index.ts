import { ATLASSIAN_CONNECTOR } from '@/connectors/atlassian/definition';
import { getConnectorRegistry } from '@/connectors/registry';
import { ATLASSIAN_CAPABILITIES, CapabilityMappingError, type ConnectorCapability, mapArguments, matchRemoteTool } from '@/core/connectors/capabilities';
import type { AgentContext, ToolManifest } from '@/core/types';
import type { MCPToolDefinition } from '@/mcp/protocol';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * Jira and Confluence as first-class tools.
 *
 * Everything here goes over the same Atlassian Remote MCP connector the
 * generic `connector_call_tool` uses — the difference is that the model does
 * not have to discover a tool list and guess at property names before it can
 * read an issue. See `core/connectors/capabilities.ts` for why the remote tool
 * names are resolved rather than hard-coded.
 */

/** Remote tool lists are stable for a session; re-listing per call is a wasted handshake. */
const TOOL_LIST_TTL_MS = 5 * 60 * 1000;
const toolListCache = new Map<string, { tools: MCPToolDefinition[]; at: number }>();

/** Drop a user's cached tool list — used by tests, and after a connection changes. */
export function _resetConnectorToolCache(): void {
  toolListCache.clear();
}

async function remoteTools(userId: string): Promise<MCPToolDefinition[]> {
  const key = `${ATLASSIAN_CONNECTOR.id}:${userId}`;
  const cached = toolListCache.get(key);
  if (cached && Date.now() - cached.at < TOOL_LIST_TTL_MS) return cached.tools;

  const tools = await getConnectorRegistry().fetchConnectorTools(ATLASSIAN_CONNECTOR, userId);
  toolListCache.set(key, { tools, at: Date.now() });
  return tools;
}

export class AtlassianTool extends BaseTool {
  readonly id = 'atlassian';
  readonly name = 'Atlassian';
  readonly version = '1.0.0';
  readonly description = 'Read and write Jira issues and Confluence pages through the connected Atlassian account.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'Read Jira issues, projects and Confluence pages', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Create and update Jira issues and Confluence pages, and comment on them', defaultLevel: 'ASK' },
      ],
      tools: ATLASSIAN_CAPABILITIES.map((capability) => ({
        name: capability.id,
        description: capability.description,
        parameters: Object.fromEntries(
          Object.entries(capability.params).map(([name, spec]) => [
            name,
            { type: spec.type, description: spec.description, ...(spec.required ? { required: true } : {}) },
          ]),
        ),
        returns: 'The connector\'s response for this call',
      })),
    };
  }

  protected async registerTools(): Promise<void> {
    for (const capability of ATLASSIAN_CAPABILITIES) {
      this.registerTool(
        capability.id,
        capability.description,
        createParameterSchema(
          Object.fromEntries(
            Object.entries(capability.params).map(([name, spec]) => [
              name,
              {
                type: spec.type,
                description: spec.description,
                required: spec.required,
                // Every array parameter must declare `items` or the Gemini
                // envelope sanitizer injects one; these are all lists of names.
                ...(spec.type === 'array' ? { items: { type: 'string' } } : {}),
              },
            ]),
          ),
        ),
        async (args, context) => this.call(capability, args, context),
        { permissionAction: isWrite(capability) ? 'write' : 'read' },
      );
    }
  }

  private async call(
    capability: ConnectorCapability,
    args: Record<string, unknown>,
    context: AgentContext,
  ): Promise<unknown> {
    if (!context.userId || context.userId === 'system' || context.userId === 'local') {
      return { error: 'Atlassian tools need a signed-in user — the connection is per-user.' };
    }

    let tools: MCPToolDefinition[];
    try {
      tools = await remoteTools(context.userId);
    } catch (error) {
      return {
        error: `Could not reach Atlassian: ${(error as Error).message}. Connect the account on the Connectors page first.`,
      };
    }

    if (tools.length === 0) {
      return { error: 'Atlassian is not connected for this user. Connect it on the Connectors page.' };
    }

    const remote = matchRemoteTool(capability, tools);
    if (!remote) {
      // Naming what IS there turns a dead end into a next step: the model can
      // fall back to connector_call_tool with a name that exists.
      return {
        error: `The connected Atlassian server has no tool for ${capability.id}. Available tools: ${tools.map((t) => t.name).join(', ')}. Use connector_call_tool if one of those fits.`,
      };
    }

    let mapped: Record<string, unknown>;
    try {
      mapped = mapArguments(capability, remote, args);
    } catch (error) {
      if (error instanceof CapabilityMappingError) return { error: error.message };
      throw error;
    }

    try {
      const result = await getConnectorRegistry().callConnectorTool(
        ATLASSIAN_CONNECTOR,
        context.userId,
        remote.name,
        mapped,
      );
      return result;
    } catch (error) {
      return { error: `${remote.name} failed: ${(error as Error).message}` };
    }
  }
}

/** Reads are ALLOW; anything that changes an issue or a page asks first. */
function isWrite(capability: ConnectorCapability): boolean {
  return /^(jira|confluence)_(create|update|transition|comment)/.test(capability.id);
}

export const atlassianTool = new AtlassianTool();
