import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getMCPBridge } from '@/mcp/bridge';
import type { MCPServer } from '@/core/types';

export const mcpRoutes = new Elysia({ prefix: '/mcp' })
  .use(apiContext)

  // List all MCP servers (configs + connection status)
  .get(
    '/servers',
    async ({ user }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const bridge = getMCPBridge();
      const configs = bridge.getServerConfigs();
      const connections = bridge.getAllConnections();

      const servers = configs.map((cfg) => {
        const conn = connections.find((c) => c.id === cfg.id);
        return {
          id: cfg.id,
          name: cfg.name,
          command: cfg.command,
          args: cfg.args,
          transport: cfg.transport || 'stdio',
          sseUrl: cfg.sseUrl,
          isEnabled: cfg.isEnabled,
          status: conn?.status || 'disconnected',
          error: conn?.error,
          toolCount: conn?.tools.length || 0,
          resourceCount: conn?.resources.length || 0,
          promptCount: conn?.prompts.length || 0,
        };
      });

      return { servers };
    },
    { detail: { tags: ['mcp'] } }
  )

  // Add a new MCP server
  .post(
    '/servers',
    async ({ user, body }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const bridge = getMCPBridge();

      const server: MCPServer = {
        id: body.id || body.name.toLowerCase().replace(/\s+/g, '-'),
        name: body.name,
        command: body.command || '',
        args: body.args,
        env: body.env,
        isEnabled: body.isEnabled ?? true,
        transport: body.transport as 'stdio' | 'sse' | undefined,
        sseUrl: body.sseUrl,
        postUrl: body.postUrl,
        headers: body.headers,
      };

      await bridge.addServer(server);

      // Auto-connect if enabled
      if (server.isEnabled) {
        try {
          await bridge.connect(server);
        } catch {
          // Connection failure is non-fatal
        }
      }

      return { server };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        name: t.String(),
        command: t.Optional(t.String()),
        args: t.Optional(t.Array(t.String())),
        env: t.Optional(t.Record(t.String(), t.String())),
        transport: t.Optional(t.String()),
        sseUrl: t.Optional(t.String()),
        postUrl: t.Optional(t.String()),
        headers: t.Optional(t.Record(t.String(), t.String())),
        isEnabled: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['mcp'] },
    }
  )

  // Toggle server enabled/disabled
  .post(
    '/servers/:id/toggle',
    async ({ user, params, body }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const bridge = getMCPBridge();
      const success = await bridge.toggleServer(params.id, body.enabled);

      if (!success) {
        return { error: 'Server not found' };
      }

      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ enabled: t.Boolean() }),
      detail: { tags: ['mcp'] },
    }
  )

  // Connect to a server
  .post(
    '/servers/:id/connect',
    async ({ user, params }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const bridge = getMCPBridge();
      const configs = bridge.getServerConfigs();
      const server = configs.find((s) => s.id === params.id);

      if (!server) {
        return { error: 'Server not found' };
      }

      try {
        await bridge.connect(server);
        return { success: true };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['mcp'] },
    }
  )

  // Disconnect from a server
  .post(
    '/servers/:id/disconnect',
    async ({ user, params }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const bridge = getMCPBridge();
      await bridge.disconnect(params.id);

      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['mcp'] },
    }
  )

  // Delete a server
  .delete(
    '/servers/:id',
    async ({ user, params }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const bridge = getMCPBridge();
      const deleted = await bridge.removeServer(params.id);

      return { deleted };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['mcp'] },
    }
  )

  // List all tools from all connected servers
  .get(
    '/tools',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const bridge = getMCPBridge();
      const tools = bridge.getAllTools();

      return {
        tools: tools.map((tool) => ({
          serverId: tool.serverId,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    },
    { detail: { tags: ['mcp'] } }
  )

  // Get tools for a specific server
  .get(
    '/servers/:id/tools',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const bridge = getMCPBridge();
      const connection = bridge.getConnection(params.id);

      if (!connection) {
        return { error: 'Server not connected' };
      }

      return {
        tools: connection.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        resources: connection.resources,
        prompts: connection.prompts,
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['mcp'] },
    }
  );
