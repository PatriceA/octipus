/**
 * Live-artifacts agent-authoring tools. Each handler resolves the user's
 * default workspace; explicit cross-workspace creation is rejected. Permission
 * tier is ASK by default (write actions); read-only ops are ALLOW.
 */

import type { ToolManifest } from '@/core/types';
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import type { ArtifactSourceKind } from '@/db/schema/artifact-data-sources';
import type { ArtifactType, ArtifactVisibility } from '@/db/schema/artifacts';
import { buildArtifactEmbedUrl } from '@/core/artifacts/host';
import { refreshSource } from '@/core/artifacts/refresh';
import { scheduleArtifactRefresh } from '@/core/artifacts/scheduler';
import { publishArtifactVersionUpdated } from '@/core/artifacts/events';
import { artifactLifecycleBus } from '@/core/artifacts/lifecycle-bus';
import { BaseTool, createParameterSchema } from '../base-tool';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

async function resolveDefaultWorkspaceId(userId: string): Promise<string> {
  const { getOrgWorkspaceManager } = await import('@/services/org-membership').catch(
    () => ({ getOrgWorkspaceManager: null as never }),
  ) as { getOrgWorkspaceManager: ((() => unknown)) | null };
  if (getOrgWorkspaceManager) {
    const mgr = (getOrgWorkspaceManager as () => { ensureDefaultWorkspace: (uid: string) => Promise<{ id: string }> })();
    const ws = await mgr.ensureDefaultWorkspace(userId);
    return ws.id;
  }
  // Fallback: direct DB lookup of any workspace owned by the user.
  const { getDb } = await import('@/db/postgres');
  const { workspaces } = await import('@/db/schema/organizations');
  const { eq } = await import('drizzle-orm');
  const rows = await getDb().select().from(workspaces).where(eq(workspaces.userId, userId)).limit(1);
  if (rows.length === 0) throw new Error('no workspace found for user — create one first');
  return rows[0].id;
}

export class ArtifactsTool extends BaseTool {
  readonly id = 'artifacts';
  readonly name = 'Live Artifacts';
  readonly version = '1.0.0';
  readonly description =
    'Create and update persistent hosted dashboards, news feeds, RSS streams, and tables tied to a workspace.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'List + inspect artifacts', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Create / update artifacts and sources', defaultLevel: 'ASK' },
      ],
      tools: [
        { name: 'create_live_artifact', description: 'Create a hosted artifact', parameters: {}, returns: 'artifact metadata' },
        { name: 'update_live_artifact', description: 'Update an artifact (creates new version)', parameters: {}, returns: 'artifact metadata' },
        { name: 'delete_live_artifact', description: 'Soft-delete (or hard-purge) an artifact', parameters: {}, returns: 'ok' },
        { name: 'list_live_artifacts', description: 'List artifacts in the current workspace', parameters: {}, returns: 'artifact list' },
        { name: 'add_artifact_data_source', description: 'Attach a data source', parameters: {}, returns: 'source metadata' },
        { name: 'remove_artifact_data_source', description: 'Detach a data source', parameters: {}, returns: 'ok' },
        { name: 'refresh_live_artifact', description: 'Force-refresh all sources', parameters: {}, returns: 'snapshot results' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'create_live_artifact',
      'Create a persistent hosted artifact (dashboard, news, RSS, table). Returns the public URL.',
      createParameterSchema({
        slug: { type: 'string', description: 'URL slug (lowercase, digits, dashes, 1-64 chars)', required: true },
        title: { type: 'string', description: 'Display title', required: true },
        type: { type: 'string', description: 'Artifact type: dashboard, table, rss, news, html', required: true },
        visibility: { type: 'string', description: 'private | workspace | signed | public (default workspace)' },
        html_template: { type: 'string', description: 'Optional template body (with {{data.<source>.<path>}} expressions)' },
        css: { type: 'string', description: 'Optional CSS' },
        sources: {
          type: 'array',
          description: 'Optional initial sources: [{name, kind, config, refresh_seconds}]',
        },
      }),
      async (args, context) => {
        if (!SLUG_RE.test(args.slug as string)) {
          return { error: 'invalid slug (lowercase/digits/dashes, 1-64 chars)' };
        }
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        const a = await artifactsRepository.create({
          slug: args.slug as string,
          workspaceId,
          createdByUserId: context.userId,
          createdByAgentId: context.id,
          title: args.title as string,
          type: args.type as ArtifactType,
          visibility: ((args.visibility as ArtifactVisibility | undefined) ?? 'workspace'),
        });
        if (args.html_template || args.css) {
          const v = await artifactsRepository.createVersion({
            artifactId: a.id,
            htmlTemplate: (args.html_template as string) ?? '',
            css: (args.css as string) ?? '',
            changeSummary: 'initial',
            createdByUserId: context.userId,
          });
          await artifactsRepository.setCurrentVersion(a.id, v.id);
        }

        const sources = (args.sources as Array<{ name: string; kind: ArtifactSourceKind; config?: Record<string, unknown>; refresh_seconds?: number }> | undefined) ?? [];
        const sourceIds: string[] = [];
        for (const s of sources) {
          const created = await artifactsRepository.createSource({
            artifactId: a.id,
            name: s.name,
            kind: s.kind,
            configJson: s.config ?? {},
            refreshSeconds: s.refresh_seconds ?? 300,
            principalId: context.userId,
          });
          sourceIds.push(created.id);
          scheduleArtifactRefresh(created.id).catch(() => {});
        }

        artifactLifecycleBus.emitEvent({
          type: 'artifact:created',
          artifactId: a.id,
          workspaceId: a.workspaceId,
          createdByUserId: context.userId,
          createdByAgentId: context.id,
        });
        return {
          id: a.id,
          slug: a.slug,
          url: buildArtifactEmbedUrl(a.slug),
          sourceIds,
          message: `Artifact "${a.title}" created`,
        };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'update_live_artifact',
      'Update an artifact. Body changes (template/css) create a new version.',
      createParameterSchema({
        id: { type: 'string', description: 'Artifact id', required: true },
        title: { type: 'string', description: 'New title' },
        visibility: { type: 'string', description: 'private | workspace | signed | public' },
        html_template: { type: 'string', description: 'New template body' },
        css: { type: 'string', description: 'New CSS' },
        change_summary: { type: 'string', description: 'Short description of the change' },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };

        if (args.title || args.visibility) {
          await artifactsRepository.update(a.id, {
            title: (args.title as string) ?? a.title,
            visibility: ((args.visibility as ArtifactVisibility | undefined) ?? a.visibility),
          });
        }
        if (args.html_template !== undefined || args.css !== undefined) {
          const prev = a.currentVersionId ? await artifactsRepository.getVersion(a.currentVersionId) : null;
          const v = await artifactsRepository.createVersion({
            artifactId: a.id,
            htmlTemplate: (args.html_template as string) ?? prev?.htmlTemplate ?? '',
            css: (args.css as string) ?? prev?.css ?? '',
            changeSummary: (args.change_summary as string) ?? '',
            createdByUserId: context.userId,
          });
          await artifactsRepository.setCurrentVersion(a.id, v.id);
          publishArtifactVersionUpdated(a.id, v.id);
          artifactLifecycleBus.emitEvent({ type: 'artifact:updated', artifactId: a.id, versionId: v.id });
        }
        return { id: a.id, message: 'Artifact updated' };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'add_artifact_data_source',
      'Attach a data source to an artifact.',
      createParameterSchema({
        artifact_id: { type: 'string', description: 'Artifact id', required: true },
        name: { type: 'string', description: 'Source name (unique per artifact)', required: true },
        kind: { type: 'string', description: 'tool | http | rss | mcp | skill_query', required: true },
        config: { type: 'object', description: 'Source config (kind-specific)' },
        refresh_seconds: { type: 'number', description: 'Refresh interval (default 300)' },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.artifact_id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };

        const created = await artifactsRepository.createSource({
          artifactId: a.id,
          name: args.name as string,
          kind: args.kind as ArtifactSourceKind,
          configJson: (args.config as Record<string, unknown>) ?? {},
          refreshSeconds: (args.refresh_seconds as number) ?? 300,
          principalId: context.userId,
        });
        scheduleArtifactRefresh(created.id).catch(() => {});
        return { id: created.id, name: created.name, message: 'Data source attached' };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'remove_artifact_data_source',
      'Detach a data source.',
      createParameterSchema({
        artifact_id: { type: 'string', description: 'Artifact id', required: true },
        source_id: { type: 'string', description: 'Source id', required: true },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.artifact_id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };
        const s = await artifactsRepository.getSource(args.source_id as string);
        if (!s || s.artifactId !== a.id) return { error: 'source not found' };
        await artifactsRepository.deleteSource(s.id);
        return { ok: true, message: 'Data source removed' };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'delete_live_artifact',
      'Soft-delete an artifact (cleanup task purges after 30d). Pass purge_now=true to drop it immediately.',
      createParameterSchema({
        id: { type: 'string', description: 'Artifact id', required: true },
        purge_now: { type: 'boolean', description: 'Skip soft-delete and remove immediately' },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };
        if (args.purge_now) {
          const { getDb } = await import('@/db/postgres');
          const { artifacts: artifactsTable } = await import('@/db/schema/artifacts');
          const { eq } = await import('drizzle-orm');
          await getDb().delete(artifactsTable).where(eq(artifactsTable.id, a.id));
          return { id: a.id, purged: true, message: `Artifact "${a.title}" purged` };
        }
        await artifactsRepository.softDelete(a.id);
        return { id: a.id, message: `Artifact "${a.title}" deleted (purged in 30 days)` };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'list_live_artifacts',
      'List all live artifacts in the current workspace.',
      createParameterSchema({}),
      async (_args, context) => {
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        const items = await artifactsRepository.listByWorkspace(workspaceId);
        return {
          artifacts: items.map((a) => ({
            id: a.id,
            slug: a.slug,
            title: a.title,
            type: a.type,
            visibility: a.visibility,
            url: buildArtifactEmbedUrl(a.slug),
            updatedAt: a.updatedAt,
          })),
        };
      },
      { permissionAction: 'read' },
    );

    this.registerTool(
      'refresh_live_artifact',
      'Force-refresh all sources of an artifact.',
      createParameterSchema({
        id: { type: 'string', description: 'Artifact id', required: true },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };
        const sources = await artifactsRepository.listSources(a.id);
        const results = await Promise.all(sources.map((s) => refreshSource(s.id)));
        return { refreshed: sources.length, results };
      },
      { permissionAction: 'write' },
    );
  }
}

export const artifactsTool = new ArtifactsTool();
