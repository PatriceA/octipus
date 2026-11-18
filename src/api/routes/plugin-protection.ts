import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { pluginAdminDenied, pluginUserDenied } from '@/api/plugin-route-guard';
import { pluginProtectionRepository } from '@/db/repositories/plugin-protection-repository';
import { findRow, audit, syncPluginServers } from '@/plugins/packages/service';
import { packageProtectionLevel, protectionView } from '@/plugins/packages/protection-policy';
import { resetReadLevels } from '@/plugins/packages/read-level';
import { packageRunProblem } from '@/plugins/packages/run-check';
import { revokePluginTokens } from '@/plugins/packages/host-api';
import { readAvailableConnectionProfiles } from '@/security/credential-connections';
import { getMCPBridge, PLUGIN_SERVER_PREFIX } from '@/mcp/bridge';
import { buildAgentContext, fundingFor } from '@/core/agent/context';
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { ApprovalBlockedError, withDispatchAuthorization } from '@/security/dispatch-authorization';
import { apiLogger } from '@/utils/logger';
import type { PluginProtectionApproval, ProtectedPluginTool } from '@/shared/plugin-protection';
const name = t.String({ pattern: '^[a-z][a-z0-9-]{1,49}$' });
const hash = t.String({ pattern: '^sha256:[a-f0-9]{64}$' });
export const pluginProtectionRoutes = new Elysia({ prefix: '/plugin-packages' })
  .use(apiContext)
  .get(
    '/:name/protection',
    async (ctx) => {
      const denied = pluginAdminDenied(ctx, 'read');
      if (denied) return denied;
      const row = await findRow(ctx.params.name);
      if (!row) {
        ctx.set.status = 404;
        return { error: 'Package not installed' };
      }
      return protectionView(row);
    },
    { params: t.Object({ name }) },
  )
  .put(
    '/:name/protection',
    async (ctx) => {
      const denied = pluginAdminDenied(ctx, 'admin');
      if (denied) return denied;
      const row = await findRow(ctx.params.name);
      if (!row || row.contentHash !== ctx.body.contentHash || (await packageRunProblem(row.name)) !== null) {
        ctx.set.status = 409;
        return {
          error: 'The package changed or is not approved to run. Review its content before changing data access.',
        };
      }
      const view = await protectionView(row);
      if (ctx.body.level > view.configurableMaximum) {
        ctx.set.status = 409;
        return { error: view.explanation };
      }
      const available = await readAvailableConnectionProfiles({
        userId: ctx.principal.userId,
        workspaceId: ctx.principal.workspaceId,
      });
      const connections: PluginProtectionApproval['connections'] = [];
      for (const id of [...new Set(ctx.body.connections as string[])]) {
        const connection = available.find((c) => c.id === id);
        if (!connection?.http) {
          ctx.set.status = 409;
          return {
            error: 'A selected connection is unavailable. Refresh the available connections.',
          };
        }
        connections.push({
          id,
          origin: connection.http.origin,
          pathPrefix: connection.http.pathPrefix,
        });
      }
      const bounded = row.manifest.host?.some((s) => s === 'repos:collect' || s === 'connections:read');
      if (ctx.body.level > 1 && bounded && !connections.length) {
        ctx.set.status = 409;
        return {
          error: 'Select the connections trusted for Internal data. Other destinations remain denied.',
        };
      }
      const approval: PluginProtectionApproval = {
        contentHash: row.contentHash!,
        level: ctx.body.level,
        connections,
        approvedBy: ctx.principal.userId,
        approvedAt: new Date().toISOString(),
      };
      const settings = { ...row.settings };
      for (const resource of row.manifest.setup?.resources ?? [])
        if (resource.kind === 'protection') {
          const field = row.manifest.settings?.find((f) => f.key === resource.setting);
          if (field && (!field.options || field.options.includes(String(approval.level))))
            settings[resource.setting] = String(approval.level);
        }
      if (
        row.manifest.host?.includes('repos:collect') &&
        row.manifest.settings?.some(
          (f) => f.key === 'collector_protection_level' && (!f.options || f.options.includes(String(approval.level))),
        )
      )
        settings.collector_protection_level = String(approval.level);
      await pluginProtectionRepository.put(row.name, approval, settings);
      revokePluginTokens(row.name);
      await audit(ctx.principal.userId, 'data_access_approved', row.name, {
        level: approval.level,
        contentHash: approval.contentHash,
        connections: connections.map((c) => ({
          id: c.id,
          origin: c.origin,
          pathPrefix: c.pathPrefix,
        })),
      });
      await syncPluginServers();
      await resetReadLevels(row.name);
      return protectionView(row);
    },
    {
      params: t.Object({ name }),
      body: t.Object({
        contentHash: hash,
        level: t.Union([t.Literal(1), t.Literal(2), t.Literal(3), t.Literal(4)]),
        connections: t.Array(t.String({ maxLength: 100 }), { maxItems: 100 }),
      }),
    },
  );

/** Host-rendered tools: plugin code never executes in this browser surface. */
export const protectedPluginRoutes = new Elysia({ prefix: '/plugins' })
  .use(apiContext)
  .get(
    '/:name/protected',
    async (ctx) => {
      const denied = pluginUserDenied(ctx, 'read');
      if (denied) return denied;
      if (ctx.principal.workspaceKind === 'shared') {
        ctx.set.status = 409;
        return {
          error: 'Protected plugin tools currently require a personal workspace.',
        };
      }
      const row = await findRow(ctx.params.name);
      if (!row?.enabled || (await packageRunProblem(row.name)) !== null) {
        ctx.set.status = 404;
        return { error: 'This plugin is not enabled or needs content review.' };
      }
      const policy = await protectionView(row);
      if (policy.needsReview) {
        ctx.set.status = 409;
        return {
          error:
            'This package was updated. An admin must renew its Data access approval; saved protected records are retained.',
          code: 'data_approval_stale',
        };
      }
      const bridge = getMCPBridge(),
        id = PLUGIN_SERVER_PREFIX + row.name;
      await bridge.ensureConnected(id);
      const tools: ProtectedPluginTool[] = bridge
        .getAllTools()
        .filter((tool) => tool.serverId === id && Object.hasOwn(row.manifest.tools ?? {}, tool.name))
        .map((tool) => ({
          name: tool.name,
          description: row.manifest.tools![tool.name].description ?? tool.name,
          effect: row.manifest.tools![tool.name].effect,
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        }));
      if (JSON.stringify(tools).length > 2_000_000) {
        ctx.set.status = 413;
        return {
          error:
            'This plugin’s tool schemas are too large for the protected view. Use the existing chat for its tools.',
        };
      }
      return {
        name: row.name,
        title: row.manifest.title,
        level: await packageProtectionLevel(row),
        tools,
      };
    },
    { params: t.Object({ name }) },
  )
  .post(
    '/:name/protected/call/:tool',
    async (ctx) => {
      const row = await findRow(ctx.params.name);
      const effect = row?.manifest.tools?.[ctx.params.tool]?.effect;
      const denied = pluginUserDenied(ctx, effect === 'read' ? 'read' : 'write');
      if (denied) return denied;
      if (ctx.principal.workspaceKind === 'shared') {
        ctx.set.status = 409;
        return {
          error: 'Protected plugin tools currently require a personal workspace.',
        };
      }
      if (
        !row?.enabled ||
        !effect ||
        !Object.hasOwn(row.manifest.tools ?? {}, ctx.params.tool) ||
        (await packageRunProblem(row.name)) !== null
      ) {
        ctx.set.status = 404;
        return { error: 'This plugin tool is unavailable.' };
      }
      const policy = await protectionView(row);
      if (policy.needsReview) {
        ctx.set.status = 409;
        return {
          error: 'Renew this package’s Data access approval before running protected tools.',
          code: 'data_approval_stale',
        };
      }
      if (JSON.stringify(ctx.body.args ?? {}).length > 100000) {
        ctx.set.status = 413;
        return { error: 'The tool arguments are too large.' };
      }
      const limit = checkRateLimit(`protected-plugin:${ctx.principal.userId}:${row.name}`, {
        capacity: 20,
        refillPerSecond: 2,
      });
      if (!limit.allowed) {
        ctx.set.status = 429;
        return { error: 'Wait a moment before running another tool.' };
      }
      const server = PLUGIN_SERVER_PREFIX + row.name,
        args = ctx.body.args ?? {};
      const context = buildAgentContext({
        id: `protected-plugin-${crypto.randomUUID()}`,
        sessionId: '',
        userId: ctx.principal.userId,
        scope: {
          workspaceId: ctx.principal.workspaceId ?? null,
          space: null,
          trigger: 'user',
          funding: fundingFor('user', null),
        },
        topic: 'plugin-native',
        model: 'plugin-native',
        role: 'general',
        attended: false,
        status: 'running',
        metadata: { source: 'plugin-native', plugin: row.name },
      });
      const authorization = {
        server_id: server,
        tool_name: ctx.params.tool,
        arguments: args,
      };
      const run = () => getMCPBridge().callTool(server, ctx.params.tool, args, context, authorization);
      try {
        const result = ctx.body.confirm
          ? await withDispatchAuthorization(
              context,
              'mcp',
              `${server}.${ctx.params.tool}`,
              authorization,
              `approval:protected-plugin:${ctx.principal.userId}`,
              run,
            )
          : await run();
        if (ctx.body.confirm)
          await audit(ctx.principal.userId, 'protected_call_confirmed', row.name, { tool: ctx.params.tool, effect });
        return { result };
      } catch (error) {
        if (error instanceof ApprovalBlockedError) {
          ctx.set.status = 409;
          return {
            error: 'Confirm this action to continue.',
            code: 'approval_required',
            effect,
          };
        }
        apiLogger.warn(
          {
            plugin: row.name,
            tool: ctx.params.tool,
            errorClass: error instanceof Error ? error.name : 'unknown',
          },
          'Protected plugin call failed',
        );
        ctx.set.status = 502;
        return {
          error: error instanceof Error ? error.message : 'Plugin call failed',
        };
      }
    },
    {
      params: t.Object({
        name,
        tool: t.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' }),
      }),
      body: t.Object({
        args: t.Optional(t.Record(t.String(), t.Unknown())),
        confirm: t.Optional(t.Boolean()),
      }),
    },
  );
