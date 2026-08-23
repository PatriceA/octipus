import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { ROLE_CONFIGS } from '@/core/orchestrator/roles';
import { getExtensionRegistry } from '@/extensions/registry';
import { getMCPBridge } from '@/mcp/bridge';
import { getPermissionManager } from '@/security/permissions';
import { getToolRegistry } from '@/tools/registry';
import { apiLogger } from '@/utils/logger';

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
      const availability = await registry.checkAllAvailability();

      const tools = manifests.map((m) => {
        const avail = availability.get(m.id);
        const status = !avail?.available ? 'inactive' : avail.degraded ? 'degraded' : 'active';
        return {
          id: m.id,
          name: m.name,
          version: m.version,
          description: m.description,
          author: m.author,
          isInitialized: registry.isInitialized(m.id),
          status,
          statusReason: status !== 'active' ? avail?.reason : undefined,
          permissions: m.permissions,
          tools: m.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            returns: t.returns,
          })),
        };
      });

      return { tools };
    },
    { detail: { tags: ['tools'] } }
  )

  // Reload user extensions from disk. Equivalent to the TUI's `/reload`
  // command but reachable from the WebUI Tools page. Only reloads extensions
  // (commands in .octipus/extensions/); built-in tools remain frozen at
  // startup and plugins reload via /plugins/:name/reload.
  .post(
    '/reload',
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      try {
        const result = await getExtensionRegistry().reload();
        apiLogger.info({ userId: user.id, count: result.count }, 'Extensions reloaded via WebUI');
        return { reloaded: true, extensionCount: result.count };
      } catch (err) {
        apiLogger.error({ err, userId: user.id }, 'Extension reload failed');
        set.status = 500;
        return { error: `Reload failed: ${(err as Error).message}` };
      }
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

  // Role ↔ tool mapping. The authorization boundary is the role: an agent of
  // role R may call tool T iff T ∈ ROLE_CONFIGS[R].toolIds. The Tools page uses
  // this to show, per tool, which roles/topics can actually use it (the QA ask:
  // "I see the tool but not which topics can use them"). MUST be before /:id.
  .get(
    '/role-map',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      // toolId -> roles that grant it (reverse index for the per-tool view).
      const byTool: Record<string, string[]> = {};
      const roles = Object.values(ROLE_CONFIGS).map((cfg) => {
        for (const toolId of cfg.toolIds) {
          (byTool[toolId] ??= []).push(cfg.role);
        }
        return { role: cfg.role, defaultTopic: cfg.defaultTopic, toolIds: cfg.toolIds };
      });
      for (const roleList of Object.values(byTool)) roleList.sort();

      return { roles, byTool };
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
      const avail = await registry.checkAvailability(manifest.id);
      const status = !avail.available ? 'inactive' : avail.degraded ? 'degraded' : 'active';

      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        isInitialized: registry.isInitialized(manifest.id),
        status,
        statusReason: status !== 'active' ? avail.reason : undefined,
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
      // Keep system user ID as-is so vault lookups (OAuth tokens) work correctly
      const userId = user.id;
      const context: import('@/core/types').AgentContext = {
        id: `api-${Date.now().toString(36)}`,
        sessionId: '',
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
