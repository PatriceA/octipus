import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getToolRegistry } from '@/tools/registry';
import { getMCPBridge } from '@/mcp/bridge';
import { getPermissionManager } from '@/security/permissions';

export const toolRoutes = new Elysia({ prefix: '/tools' })
  .use(apiContext)

  // List all registered tools with their sub-tools
  .get(
    '/',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const registry = getToolRegistry();
      const manifests = registry.getManifests();

      const tools = manifests.map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        author: m.author,
        isInitialized: registry.isInitialized(m.id),
        permissions: m.permissions,
        tools: m.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          returns: t.returns,
        })),
      }));

      return { tools };
    },
    { detail: { tags: ['tools'] } }
  )

  // Get all available tools (registered + MCP combined)
  // MUST be before /:id to avoid matching "all" as an id
  .get(
    '/all',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const registry = getToolRegistry();
      const handlers = registry.getAllToolHandlers();

      const registeredTools = handlers.map((h) => ({
        name: h.name,
        description: h.description,
        parameters: h.parameters,
        source: 'tool' as const,
        toolId: h.toolId,
      }));

      // MCP tools
      const bridge = getMCPBridge();
      const mcpTools = bridge.getAllTools().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        source: 'mcp' as const,
        toolId: `mcp:${t.serverId}`,
      }));

      return { tools: [...registeredTools, ...mcpTools] };
    },
    { detail: { tags: ['tools'] } }
  )

  // Get user's permission overrides
  // MUST be before /:id to avoid matching "permissions" as an id
  .get(
    '/permissions',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const pm = getPermissionManager();
      const permissions = await pm.getUserPermissions(user.id);

      return {
        permissions: permissions.map((p) => ({
          toolId: p.toolId,
          action: p.action,
          level: p.level,
          reason: p.reason,
          expiresAt: p.expiresAt,
        })),
      };
    },
    { detail: { tags: ['tools'] } }
  )

  // Set a permission level for a tool action
  .put(
    '/permissions',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const pm = getPermissionManager();
      const result = await pm.setPermission(
        user.id,
        body.toolId,
        body.action,
        body.level as 'ALLOW' | 'ASK' | 'DENY',
        { grantedBy: user.id, reason: body.reason }
      );

      return {
        permission: {
          toolId: result.toolId,
          action: result.action,
          level: result.level,
        },
      };
    },
    {
      body: t.Object({
        toolId: t.String(),
        action: t.String(),
        level: t.Union([t.Literal('ALLOW'), t.Literal('ASK'), t.Literal('DENY')]),
        reason: t.Optional(t.String()),
      }),
      detail: { tags: ['tools'] },
    }
  )

  // Reset a permission to default (delete override)
  .delete(
    '/permissions/:toolId/:action',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const pm = getPermissionManager();
      const deleted = await pm.deletePermission(user.id, params.toolId, params.action);

      return { deleted };
    },
    {
      params: t.Object({ toolId: t.String(), action: t.String() }),
      detail: { tags: ['tools'] },
    }
  )

  // Get a specific tool's details
  .get(
    '/:id',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const registry = getToolRegistry();
      const tool = registry.get(params.id);

      if (!tool) {
        return { error: 'Tool not found' };
      }

      const manifest = tool.getManifest();

      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        isInitialized: registry.isInitialized(manifest.id),
        permissions: manifest.permissions,
        tools: manifest.tools,
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['tools'] },
    }
  )

  // Execute a tool directly via API (used by MCP server bridge)
  .post(
    '/:toolId/tools/:toolName/execute',
    async ({ user, params, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const registry = getToolRegistry();
      const tool = registry.findTool(`${params.toolId}__${params.toolName}`);

      if (!tool) {
        return { error: `Tool '${params.toolId}__${params.toolName}' not found` };
      }

      // Construct a minimal AgentContext for API-driven execution
      // System user (master key auth) uses nil UUID since permission DB expects UUID format
      const userId = user.id === 'system' ? '00000000-0000-0000-0000-000000000000' : user.id;
      const context: import('@/core/types').AgentContext = {
        id: `api-${Date.now().toString(36)}`,
        sessionId: 'api',
        userId,
        topic: 'api',
        model: 'api',
        role: 'general',
        status: 'running',
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { source: 'mcp-bridge', isSystemUser: user.id === 'system' },
      };

      try {
        const result = await tool.execute(body.args || {}, context);
        return { result };
      } catch (err) {
        return { error: `Tool execution failed: ${(err as Error).message}` };
      }
    },
    {
      params: t.Object({ toolId: t.String(), toolName: t.String() }),
      body: t.Object({
        args: t.Optional(t.Record(t.String(), t.Any())),
      }),
      detail: { tags: ['tools'] },
    }
  );
