/**
 * mcp-admin — lets you hand the assistant an MCP endpoint in chat ("add the
 * Notion MCP at https://…") instead of filling in the MCP page yourself.
 *
 * Two hard gates, because an MCP server is process-wide (every user's agents
 * can call its tools) and a `stdio` server is a command this host will run:
 *   1. the caller must be an admin — same bar as `POST /api/mcp/servers`;
 *   2. every call raises a permission prompt showing the exact command or URL.
 * Nothing here is auto-approvable: `requiresPermission: true` with no
 * ALLOW default in the manifest.
 */
import type { MCPServer, ToolManifest } from '@/core/types';
import { userRepository } from '@/db/repositories/user-repository';
import { getMCPBridge } from '@/mcp/bridge';
import { toolLogger } from '@/utils/logger';
import { BaseTool, createParameterSchema } from '../base-tool';

type Transport = 'stdio' | 'sse' | 'streamable-http';

/** Slug used when the caller doesn't supply an id. Mirrors the REST route. */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Validate + shape the arguments into an MCPServer, or explain what's missing. */
export function buildServerConfig(args: Record<string, unknown>): { server: MCPServer } | { error: string } {
  const name = String(args.name ?? '').trim();
  if (!name) return { error: 'A `name` is required.' };

  const transport = String(args.transport ?? 'stdio') as Transport;
  if (transport !== 'stdio' && transport !== 'sse' && transport !== 'streamable-http') {
    return { error: `Unknown transport "${transport}". Use stdio, sse, or streamable-http.` };
  }

  const command = String(args.command ?? '').trim();
  const url = String(args.url ?? '').trim();

  if (transport === 'stdio' && !command) {
    return { error: "transport='stdio' needs a `command` to run." };
  }
  if (transport !== 'stdio') {
    if (!url) return { error: `transport='${transport}' needs a \`url\`.` };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: `\`url\` is not a valid URL: ${url}` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: `\`url\` must be http(s), got ${parsed.protocol}` };
    }
  }

  return {
    server: {
      id: String(args.id ?? '').trim() || slugify(name),
      name,
      command: transport === 'stdio' ? command : '',
      args: Array.isArray(args.args) ? args.args.map(String) : undefined,
      env: isStringRecord(args.env) ? args.env : undefined,
      headers: isStringRecord(args.headers) ? args.headers : undefined,
      transport,
      sseUrl: transport === 'sse' ? url : undefined,
      postUrl: transport === 'streamable-http' ? url : undefined,
      isEnabled: true,
    },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

/**
 * Register + connect a server. Split out of the tool handler so the admin gate
 * and the duplicate-id check are testable without standing up the permission
 * manager (the prompt itself is BaseTool's, and is exercised by its own tests).
 */
export async function addMcpServer(
  args: Record<string, unknown>,
  userId: string,
): Promise<Record<string, unknown>> {
  // Admin gate first: a non-admin must not even get a prompt they could talk
  // the owner into approving.
  const user = await userRepository.findById(userId).catch(() => null);
  if (!user?.isAdmin) {
    return { error: 'Only an admin can register an MCP server. Ask the owner to add it on the MCP page.' };
  }

  const built = buildServerConfig(args);
  if ('error' in built) return { error: built.error };
  const { server } = built;

  const bridge = getMCPBridge();
  if (bridge.getServerConfigs().some((s) => s.id === server.id)) {
    return {
      error: `An MCP server with id "${server.id}" already exists. Pick another name, or remove it on the MCP page.`,
    };
  }

  await bridge.addServer(server);
  toolLogger.info({ serverId: server.id, transport: server.transport }, 'MCP server registered by agent');

  try {
    const connection = await bridge.connect(server);
    return {
      added: true,
      serverId: server.id,
      connected: true,
      toolCount: connection.tools.length,
      tools: connection.tools.map((t) => t.name),
    };
  } catch (err) {
    // The config is saved either way — a server that is merely down can be
    // retried with /mcp reconnect rather than re-added.
    return {
      added: true,
      serverId: server.id,
      connected: false,
      error: `Saved, but the connection failed: ${(err as Error).message}`,
    };
  }
}

export class McpAdminTool extends BaseTool {
  readonly id = 'mcp_admin';
  readonly name = 'MCP Admin';
  readonly version = '1.0.0';
  readonly description = 'Register an MCP server so its tools become available to agents.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        // ASK, and marked dangerous: a stdio server is a command this host runs.
        {
          action: 'configure',
          description: 'Register and connect an MCP server',
          defaultLevel: 'ASK',
          dangerous: true,
        },
      ],
      tools: [
        {
          name: 'mcp_add_server',
          description: 'Register an MCP server (asks the user for approval first).',
          parameters: {
            name: { type: 'string', description: 'Display name', required: true },
            transport: { type: 'string', description: "'stdio' (default), 'sse', or 'streamable-http'" },
            command: { type: 'string', description: "Command to run for transport='stdio'" },
            args: { type: 'array', description: 'Command arguments' },
            url: { type: 'string', description: 'Endpoint URL for the http transports' },
            env: { type: 'object', description: 'Environment variables for a stdio server' },
            headers: { type: 'object', description: 'HTTP headers for an http transport' },
          },
          returns: 'The registered server and how many tools it exposed on connect',
        },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'mcp_add_server',
      'Register an MCP server so its tools become callable through mcp_call_tool. ' +
        'Requires the user to approve, and only an admin may do it. Use transport=stdio with a ' +
        '`command`, or transport=sse / streamable-http with a `url`.',
      createParameterSchema({
        name: { type: 'string', description: 'Display name for the server', required: true },
        transport: { type: 'string', description: "'stdio' (default), 'sse', or 'streamable-http'" },
        command: { type: 'string', description: "The command to run when transport='stdio'" },
        args: { type: 'array', description: 'Arguments for the command', items: { type: 'string' } },
        url: { type: 'string', description: "Endpoint URL when transport is 'sse' or 'streamable-http'" },
        env: { type: 'object', description: 'Environment variables for a stdio server' },
        headers: { type: 'object', description: 'HTTP headers for an http transport' },
      }),
      async (args, context) => addMcpServer(args, context.userId),
      {
        requiresPermission: true,
        permissionAction: 'configure',
      },
    );
  }
}

/** Auto-discovered singleton (see src/tools/discovery.ts). */
export const mcpAdminTool = new McpAdminTool();
