import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getSkillRegistry } from '@/skills/registry';
import { getMCPBridge } from '@/mcp/bridge';
import { getPermissionManager } from '@/security/permissions';

export const skillRoutes = new Elysia({ prefix: '/skills' })
  .use(apiContext)

  // List all registered skills with their tools
  .get(
    '/',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const registry = getSkillRegistry();
      const manifests = registry.getManifests();

      const skills = manifests.map((m) => ({
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

      return { skills };
    },
    { detail: { tags: ['skills'] } }
  )

  // Get a specific skill's details
  .get(
    '/:id',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const registry = getSkillRegistry();
      const skill = registry.get(params.id);

      if (!skill) {
        return { error: 'Skill not found' };
      }

      const manifest = skill.getManifest();

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
      detail: { tags: ['skills'] },
    }
  )

  // Get all available tools (skills + MCP combined)
  .get(
    '/tools/all',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const registry = getSkillRegistry();
      const handlers = registry.getAllToolHandlers();

      const skillTools = handlers.map((h) => ({
        name: h.name,
        description: h.description,
        parameters: h.parameters,
        source: 'skill' as const,
        skillId: h.skillId,
      }));

      // MCP tools
      const bridge = getMCPBridge();
      const mcpTools = bridge.getAllTools().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        source: 'mcp' as const,
        skillId: `mcp:${t.serverId}`,
      }));

      return { tools: [...skillTools, ...mcpTools] };
    },
    { detail: { tags: ['skills'] } }
  )

  // Get user's permission overrides
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
          skillId: p.skillId,
          action: p.action,
          level: p.level,
          reason: p.reason,
          expiresAt: p.expiresAt,
        })),
      };
    },
    { detail: { tags: ['skills'] } }
  )

  // Set a permission level for a skill action
  .put(
    '/permissions',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const pm = getPermissionManager();
      const result = await pm.setPermission(
        user.id,
        body.skillId,
        body.action,
        body.level as 'ALLOW' | 'ASK' | 'DENY',
        { grantedBy: user.id, reason: body.reason }
      );

      return {
        permission: {
          skillId: result.skillId,
          action: result.action,
          level: result.level,
        },
      };
    },
    {
      body: t.Object({
        skillId: t.String(),
        action: t.String(),
        level: t.Union([t.Literal('ALLOW'), t.Literal('ASK'), t.Literal('DENY')]),
        reason: t.Optional(t.String()),
      }),
      detail: { tags: ['skills'] },
    }
  )

  // Reset a permission to default (delete override)
  .delete(
    '/permissions/:skillId/:action',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const pm = getPermissionManager();
      const deleted = await pm.deletePermission(user.id, params.skillId, params.action);

      return { deleted };
    },
    {
      params: t.Object({ skillId: t.String(), action: t.String() }),
      detail: { tags: ['skills'] },
    }
  );
