import { Elysia, t } from '@/api/http';
import { adminDenied } from '@/api/admin-guard';
import { apiContext } from '@/api/context';
import type { MCPServer } from '@/core/types';
import { getMCPBridge } from '@/mcp/bridge';
import { getMcpCircuitBreaker } from '@/mcp/circuit-breaker';
import { exposureConfigError, type McpExposure, resolveToolExposure } from '@/shared/mcp-exposure';

/** A sentence, not a manual: the section shows at most 250 characters of it. */
const MAX_DESCRIPTION_CHARS = 500;

export const mcpRoutes = new Elysia({ prefix: '/mcp' })
  .use(apiContext)

  // List all MCP servers (configs + connection status)
  .get(
    '/servers',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

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
          cwd: cfg.cwd,
          requestTimeoutMs: cfg.requestTimeoutMs,
          stderrAsError: cfg.stderrAsError,
          transport: cfg.transport || 'stdio',
          sseUrl: cfg.sseUrl,
          isEnabled: cfg.isEnabled,
          description: cfg.description ?? '',
          exposure: cfg.exposure ?? 'deferred',
          toolExposure: cfg.toolExposure ?? {},
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
    async ({ user, principal, set, body }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

      const invalid = exposureConfigError(body);
      if (invalid) {
        set.status = 400;
        return { error: invalid };
      }

      const bridge = getMCPBridge();

      const server: MCPServer = {
        id: body.id || body.name.toLowerCase().replace(/\s+/g, '-'),
        name: body.name,
        command: body.command || '',
        args: body.args,
        env: body.env,
        cwd: body.cwd,
        requestTimeoutMs: body.requestTimeoutMs,
        stderrAsError: body.stderrAsError,
        isEnabled: body.isEnabled ?? true,
        transport: body.transport as 'stdio' | 'sse' | 'streamable-http' | undefined,
        sseUrl: body.sseUrl,
        postUrl: body.postUrl,
        headers: body.headers,
        exposure: body.exposure as McpExposure | undefined,
        toolExposure: body.toolExposure as Record<string, McpExposure> | undefined,
        description: body.description?.trim() || undefined,
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
        cwd: t.Optional(t.String()),
        requestTimeoutMs: t.Optional(t.Number({ minimum: 1, maximum: 3_600_000 })),
        stderrAsError: t.Optional(t.Boolean()),
        transport: t.Optional(t.String()),
        sseUrl: t.Optional(t.String()),
        postUrl: t.Optional(t.String()),
        headers: t.Optional(t.Record(t.String(), t.String())),
        isEnabled: t.Optional(t.Boolean()),
        exposure: t.Optional(t.String()),
        toolExposure: t.Optional(t.Record(t.String(), t.String())),
        description: t.Optional(t.String({ maxLength: MAX_DESCRIPTION_CHARS })),
      }),
      detail: { tags: ['mcp'] },
    }
  )

  // Toggle server enabled/disabled
  .post(
    '/servers/:id/toggle',
    async ({ user, principal, set, params, body }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

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

  // Change how a server's tools reach the model (src/shared/mcp-exposure.ts).
  // Applies to agents spawned from now on.
  .put(
    '/servers/:id/exposure',
    async ({ user, principal, set, params, body }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

      const invalid = exposureConfigError(body);
      if (invalid) {
        set.status = 400;
        return { error: invalid };
      }

      const updated = await getMCPBridge().setExposure(params.id, {
        exposure: body.exposure as McpExposure | undefined,
        toolExposure: body.toolExposure as Record<string, McpExposure> | undefined,
      });
      if (!updated) {
        set.status = 404;
        return { error: 'Server not found' };
      }
      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        exposure: t.Optional(t.String()),
        toolExposure: t.Optional(t.Record(t.String(), t.String())),
      }),
      detail: { tags: ['mcp'] },
    }
  )

  // What the server offers, in a sentence — shown to agents in the MCP SERVERS
  // system-prompt section. An empty string clears it.
  .put(
    '/servers/:id/description',
    async ({ user, principal, set, params, body }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const updated = await getMCPBridge().setDescription(params.id, body.description);
      if (!updated) {
        set.status = 404;
        return { error: 'Server not found' };
      }
      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ description: t.String({ maxLength: MAX_DESCRIPTION_CHARS }) }),
      detail: { tags: ['mcp'] },
    }
  )

  // Set or (exposure: null) remove one tool's exposure override, server-side so
  // concurrent per-tool changes don't overwrite each other.
  .put(
    '/servers/:id/tools/:tool/exposure',
    async ({ user, principal, set, params, body }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

      const invalid = body.exposure === null ? null : exposureConfigError({ exposure: body.exposure });
      if (invalid) {
        set.status = 400;
        return { error: invalid };
      }

      const updated = await getMCPBridge().setToolExposure(params.id, params.tool, body.exposure as McpExposure | null);
      if (!updated) {
        set.status = 404;
        return { error: 'Server not found' };
      }
      return { success: true };
    },
    {
      params: t.Object({ id: t.String(), tool: t.String() }),
      body: t.Object({ exposure: t.Union([t.String(), t.Null()]) }),
      detail: { tags: ['mcp'] },
    }
  )

  // Connect to a server
  .post(
    '/servers/:id/connect',
    async ({ user, principal, set, params }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

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
    async ({ user, principal, set, params }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

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
    async ({ user, principal, set, params }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

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
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

      const bridge = getMCPBridge();
      const tools = bridge.getAllTools();

      return {
        tools: tools.map((tool) => ({
          serverId: tool.serverId,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          exposure: tool.exposure,
        })),
      };
    },
    { detail: { tags: ['mcp'] } }
  )

  // Get tools for a specific server
  .get(
    '/servers/:id/tools',
    async ({ user, principal, set, params }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

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
          exposure: resolveToolExposure(connection.server, t.name),
        })),
        resources: connection.resources,
        prompts: connection.prompts,
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['mcp'] },
    }
  )

  // Circuit breaker state for all MCP servers
  .get('/circuit', async ({ user, principal, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
    return { circuits: getMcpCircuitBreaker().getAllStates() };
  })

  // Force-close a server's circuit breaker
  .post(
    '/circuit/:serverId/reset',
    async ({ params, user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      getMcpCircuitBreaker().reset(params.serverId);
      return { reset: true, state: getMcpCircuitBreaker().getState(params.serverId) };
    },
    { params: t.Object({ serverId: t.String() }), detail: { tags: ['mcp'] } },
  );
