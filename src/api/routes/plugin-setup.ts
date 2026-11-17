import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { pluginAdminDenied } from '@/api/plugin-route-guard';
import { pluginSetupRepository } from '@/db/repositories/plugin-setup-repository';
import { setupPreview } from '@/plugins/packages/consent';
import { findRow, PluginPackageError } from '@/plugins/packages/service';
import { setupResources, validateSetupSettings } from '@/plugins/packages/setup';
import { setupRepositories } from '@/plugins/packages/setup-repositories';
import { validateRecordData } from '@/core/records/fields';
import { getMCPBridge, PLUGIN_SERVER_PREFIX } from '@/mcp/bridge';
import { buildAgentContext, fundingFor } from '@/core/agent/context';
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { apiLogger } from '@/utils/logger';
import type { PluginSetupCheck } from '@/shared/plugin-setup';

const nameParam = t.Object({ name: t.String({ pattern: '^[a-z][a-z0-9-]{1,49}$' }) });
const hash = t.String({ pattern: '^sha256:[0-9a-f]{64}$' });
const fail = (error: unknown, set: { status?: number | string }) => {
  set.status = error instanceof PluginPackageError ? 409 : 400;
  return { error: error instanceof Error ? error.message : 'Setup failed. Resume this step.' };
};

export const pluginSetupRoutes = new Elysia({ prefix: '/plugin-packages/setup' }).use(apiContext)
  .get('/resources', async ctx => {
    const denied = pluginAdminDenied(ctx, 'read'); if (denied) return denied;
    return setupResources({ userId: ctx.principal.userId, workspaceId: ctx.principal.workspaceId });
  })
  .get('/repositories', async ctx => {
    const denied = pluginAdminDenied(ctx, 'read'); if (denied) return denied;
    const limited = checkRateLimit(`plugin-setup-repos:${ctx.principal.userId}`, { capacity: 10, refillPerSecond: 0.5 });
    if (!limited.allowed) { ctx.set.status = 429; return { error: 'Wait a moment before browsing repositories again.' }; }
    try { return await setupRepositories({ userId: ctx.principal.userId, workspaceId: ctx.principal.workspaceId }, ctx.query.environmentId, ctx.query.root, ctx.query.repository); }
    catch (error) { return fail(error, ctx.set); }
  }, { query: t.Object({ environmentId: t.String({ maxLength: 100 }), root: t.String({ maxLength: 2000 }), repository: t.Optional(t.String({ maxLength: 2000 })) }) })
  .get('/:name/draft', async ctx => {
    const denied = pluginAdminDenied(ctx, 'read'); if (denied) return denied;
    return { draft: await pluginSetupRepository.get(ctx.principal.userId, ctx.principal.workspaceId ?? null, ctx.params.name) };
  }, { params: nameParam })
  .put('/:name/draft', async ctx => {
    const denied = pluginAdminDenied(ctx, 'admin'); if (denied) return denied;
    try {
      const preview = ctx.body.previewId ? setupPreview(ctx.body.previewId, ctx.principal.userId) : null;
      const row = preview ? null : await findRow(ctx.params.name);
      const manifest = preview?.manifest ?? row?.manifest;
      if (!manifest || manifest.name !== ctx.params.name || (preview?.contentHash ?? row?.contentHash) !== ctx.body.contentHash) throw new PluginPackageError('conflict', 'The package changed or the preview expired. Reload setup before saving.');
      // Incomplete fields can be parked; execution checks required values later.
      const settings = validateRecordData((manifest.settings ?? []).map(f => ({ ...f, required: false })), ctx.body.settings);
      return { draft: await pluginSetupRepository.save(ctx.principal.userId, ctx.principal.workspaceId ?? null, ctx.params.name,
        { settings, contentHash: ctx.body.contentHash, stage: ctx.body.stage }, ctx.body.revision) };
    } catch (error) { return fail(error, ctx.set); }
  }, { params: nameParam, body: t.Object({ previewId: t.Optional(t.String({ maxLength: 36 })), contentHash: hash, settings: t.Record(t.String(), t.Unknown()), revision: t.Integer({ minimum: 0 }), stage: t.Union([t.Literal('configure'), t.Literal('review')]) }) })
  .post('/:name/preflight', async ctx => {
    const denied = pluginAdminDenied(ctx, 'admin'); if (denied) return denied;
    try {
      const preview = ctx.body.previewId ? setupPreview(ctx.body.previewId, ctx.principal.userId) : null;
      const row = preview ? null : await findRow(ctx.params.name);
      const manifest = preview?.manifest ?? row?.manifest;
      if (!manifest || manifest.name !== ctx.params.name || (preview?.contentHash ?? row?.contentHash) !== ctx.body.contentHash) throw new PluginPackageError('conflict', 'The package changed or the preview expired. Reload setup.');
      await validateSetupSettings(manifest, ctx.body.settings, { userId: ctx.principal.userId, workspaceId: ctx.principal.workspaceId });
      return { ok: true, message: 'Configuration and selected resources are compatible. No connection was contacted.' };
    } catch (error) { return fail(error, ctx.set); }
  }, { params: nameParam, body: t.Object({ previewId: t.Optional(t.String({ maxLength: 36 })), contentHash: hash, settings: t.Record(t.String(), t.Unknown()) }) })
  .post('/:name/check', async ctx => {
    const denied = pluginAdminDenied(ctx, 'admin'); if (denied) return denied;
    const limited = checkRateLimit(`plugin-setup-check:${ctx.principal.userId}`, { capacity: 5, refillPerSecond: 0.1 });
    if (!limited.allowed) { ctx.set.status = 429; return { error: 'Wait a moment before checking readiness again.' }; }
    try {
      const row = await findRow(ctx.params.name);
      if (!row?.enabled || row.contentHash !== ctx.body.contentHash) throw new PluginPackageError('conflict', 'Enable the reviewed package before testing its connection.');
      const check = row.manifest.setup?.check;
      if (!check || row.manifest.tools?.[check.tool]?.effect !== 'read') throw new PluginPackageError('invalid', 'This plugin does not declare a read-only connection test.');
      const workspaceId = ctx.principal.workspaceId ?? null;
      const context = buildAgentContext({ id: `plugin-setup-${crypto.randomUUID()}`, sessionId: '', userId: ctx.principal.userId,
        scope: { workspaceId, space: null, trigger: 'user', funding: fundingFor('user', null) }, topic: 'plugin-setup', model: 'plugin-setup', role: 'general', attended: false, status: 'running', metadata: { source: 'plugin-page', plugin: row.name, setup: true } });
      const server = `${PLUGIN_SERVER_PREFIX}${row.name}`;
      const result = await getMCPBridge().callTool(server, check.tool, check.input ?? {}, context, { server_id: server, tool_name: check.tool, arguments: check.input ?? {} });
      const envelope = result as { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
      const text = envelope.content?.find(c => c.type === 'text')?.text;
      let data: unknown = envelope.structuredContent ?? null;
      if (data === null && text && !envelope.isError) { try { data = JSON.parse(text); } catch { /* An unstructured response cannot establish readiness. */ } }
      const view = data as { ok?: unknown; message?: unknown } | null;
      const out: PluginSetupCheck = { ok: !envelope.isError && view?.ok === true, message: typeof view?.message === 'string' ? view.message.slice(0, 1000) : envelope.isError && text ? text.slice(0, 1000) : 'The plugin did not confirm a successful connection.', checkedAt: new Date().toISOString() };
      return out;
    } catch (error) { apiLogger.warn({ plugin: ctx.params.name, errorClass: error instanceof Error ? error.name : 'unknown' }, 'Plugin setup check failed'); return fail(error, ctx.set); }
  }, { params: nameParam, body: t.Object({ contentHash: hash }) });
