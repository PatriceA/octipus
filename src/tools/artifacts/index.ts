/**
 * Live-artifacts agent-authoring tools. Each handler resolves the user's
 * default workspace; explicit cross-workspace creation is rejected. Permission
 * tier is ASK by default (write actions); read-only ops are ALLOW.
 */

import type { ToolManifest } from '@/core/types';
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import type { ArtifactSourceKind } from '@/db/schema/artifact-data-sources';
import type { ArtifactType, ArtifactVisibility } from '@/db/schema/artifacts';
import { buildArtifactEmbedUrl, buildArtifactOuterUrl } from '@/core/artifacts/host';
import { refreshSource } from '@/core/artifacts/refresh';
import { scheduleArtifactRefresh } from '@/core/artifacts/scheduler';
import { publishArtifactVersionUpdated } from '@/core/artifacts/events';
import { artifactLifecycleBus } from '@/core/artifacts/lifecycle-bus';
import { BaseTool, createParameterSchema } from '../base-tool';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Find `{{data.<sourceName>.…}}` references in a template body. Used to
 * cross-check that every `data.X` referenced has a source named `X`. Empty
 * array means no data bindings were declared.
 */
function extractTemplateSourceRefs(template: string): string[] {
  const refs = new Set<string>();
  const re = /\{\{\s*data\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) refs.add(m[1]);
  return [...refs];
}

function diffTemplateAndSources(template: string, sourceNames: string[]): {
  missingSources: string[];
  unusedSources: string[];
} {
  const refs = extractTemplateSourceRefs(template);
  const present = new Set(sourceNames);
  const referenced = new Set(refs);
  return {
    missingSources: refs.filter((r) => !present.has(r)),
    unusedSources: sourceNames.filter((n) => !referenced.has(n)),
  };
}

const SOURCES_PARAM_DESCRIPTION =
  'Initial data sources. PREFERRED: pass `{ name, kind: "toolbox", tool_id: "<art_collect_*>", config: <params>, refresh_seconds? }` — ' +
  'discover ids via `art_toolbox_list({ family: "collect" })` / `art_toolbox_search` / `art_toolbox_describe`. ' +
  'DEPRECATED inline kinds (kept for back-compat, do not author new artifacts with these): ' +
  '`http` / `rss` / `tool` / `mcp` / `skill_query` with config matching the legacy shape — see docs/ARTIFACTS.md. ' +
  'Example: `[{ "name": "feed", "kind": "toolbox", "tool_id": "art_collect_rss", "config": { "url": "https://hnrss.org/frontpage" } }]`. ' +
  'For widgets (table/list/charts/diagrams) and exports (csv/json/markdown), attach AFTER create with `add_artifact_widget` / `add_artifact_export` so you do not have to author HTML by hand.';

const CREATE_DESCRIPTION =
  'Create a persistent hosted artifact (dashboard, news feed, RSS reader, table). ' +
  'Returns `{ embedUrl, outerUrl, visibility, warnings }`. ' +
  'RECOMMENDED FLOW (toolbox-first — no hand-authored HTML): ' +
  '(a) `art_toolbox_search` / `art_toolbox_describe` to pick collector + widget + export tool ids; ' +
  '(b) call this with `sources: [{ name, kind: "toolbox", tool_id, config }]` and leave `html_template` empty; ' +
  '(c) after create, call `add_artifact_transform` / `add_artifact_widget` / `add_artifact_export` to fill in the page — widgets without a template render via the default CSS grid; ' +
  '(d) call `art_toolbox_validate` BEFORE add_* calls to fail fast on bad wiring. ' +
  'IMPORTANT: ' +
  '(1) If you DO pass `html_template` with `{{data.<name>.…}}` placeholders, every `<name>` MUST exist in `sources[]` or in a transform attached later. ' +
  '(2) Default `visibility` is `workspace`, which means the public URL returns 404 to anyone not signed in. Pass `visibility: "public"` for a shareable link or `"signed"` for share-token only. ' +
  '(3) After create, the page only auto-refreshes when at least one viewer has loaded it recently — open the `outerUrl` to confirm the first render.';

const UPDATE_DESCRIPTION =
  'Update an artifact. Body changes (template/css) create a new version. ' +
  'For most edits prefer the granular tools — add/remove sources, transforms, widgets, exports — which preserve the existing version and snapshot history. ' +
  'Use this tool when you genuinely need a new HTML template version. ' +
  'Same template/source coupling applies as `create_live_artifact` — if you reference a new `{{data.<name>.…}}`, attach the source first via `add_artifact_data_source`.';

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
        { name: 'add_artifact_transform', description: 'Attach a toolbox transform', parameters: {}, returns: 'transform metadata' },
        { name: 'remove_artifact_transform', description: 'Detach a transform by name', parameters: {}, returns: 'ok' },
        { name: 'add_artifact_widget', description: 'Attach a toolbox widget instance', parameters: {}, returns: 'widget metadata' },
        { name: 'remove_artifact_widget', description: 'Detach a widget by slot', parameters: {}, returns: 'ok' },
        { name: 'add_artifact_export', description: 'Register a download exporter', parameters: {}, returns: 'export metadata + url' },
        { name: 'remove_artifact_export', description: 'Remove an exporter by id', parameters: {}, returns: 'ok' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'create_live_artifact',
      CREATE_DESCRIPTION,
      createParameterSchema({
        slug: { type: 'string', description: 'URL slug (lowercase, digits, dashes, 1-64 chars)', required: true },
        title: { type: 'string', description: 'Display title', required: true },
        type: { type: 'string', description: 'Artifact type', required: true, enum: ['dashboard', 'table', 'rss', 'news', 'html'] },
        visibility: {
          type: 'string',
          description: '`private` (only creator), `workspace` (default — anonymous URL returns 404), `signed` (requires share token), `public` (anyone with URL).',
          enum: ['private', 'workspace', 'signed', 'public'],
        },
        html_template: { type: 'string', description: 'Template body. Use `{{data.<sourceName>.<path>}}` to bind to a data source — every `<sourceName>` referenced must appear in `sources[]`.' },
        css: { type: 'string', description: 'Optional CSS' },
        sources: { type: 'array', description: SOURCES_PARAM_DESCRIPTION },
      }),
      async (args, context) => {
        if (!SLUG_RE.test(args.slug as string)) {
          return { error: 'invalid slug (lowercase/digits/dashes, 1-64 chars)' };
        }
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        const visibility = ((args.visibility as ArtifactVisibility | undefined) ?? 'workspace');
        const a = await artifactsRepository.create({
          slug: args.slug as string,
          workspaceId,
          createdByUserId: context.userId,
          createdByAgentId: context.id,
          title: args.title as string,
          type: args.type as ArtifactType,
          visibility,
        });
        const template = (args.html_template as string) ?? '';
        if (template || args.css) {
          const v = await artifactsRepository.createVersion({
            artifactId: a.id,
            htmlTemplate: template,
            css: (args.css as string) ?? '',
            changeSummary: 'initial',
            createdByUserId: context.userId,
          });
          await artifactsRepository.setCurrentVersion(a.id, v.id);
        }

        const sources = (args.sources as Array<{ name: string; kind: ArtifactSourceKind; tool_id?: string; config?: Record<string, unknown>; refresh_seconds?: number }> | undefined) ?? [];
        const sourceIds: string[] = [];
        let toolboxLoaded = false;
        const toolboxValidate = async (toolId: string): Promise<string | null> => {
          if (!toolboxLoaded) {
            const { ensureToolboxLoaded } = await import('@/core/artifacts/toolbox');
            await ensureToolboxLoaded();
            toolboxLoaded = true;
          }
          const { getToolboxRegistry } = await import('@/core/artifacts/toolbox');
          const tool = getToolboxRegistry().get(toolId);
          if (!tool) return `unknown toolbox tool "${toolId}" — call art_toolbox_search to discover valid ids`;
          if (tool.family !== 'collect') return `tool "${toolId}" is a ${tool.family} tool, not a collector`;
          return null;
        };
        for (const s of sources) {
          const toolId = typeof s.tool_id === 'string' ? s.tool_id.trim() : '';
          if (s.kind === 'toolbox') {
            if (!toolId) {
              return { error: `source "${s.name}": kind="toolbox" requires tool_id` };
            }
            const validationError = await toolboxValidate(toolId);
            if (validationError) return { error: `source "${s.name}": ${validationError}` };
          } else if (toolId) {
            return { error: `source "${s.name}": tool_id is only valid with kind="toolbox"` };
          }
          const created = await artifactsRepository.createSource({
            artifactId: a.id,
            name: s.name,
            kind: s.kind,
            toolId: s.kind === 'toolbox' ? toolId : null,
            configJson: s.config ?? {},
            refreshSeconds: s.refresh_seconds ?? 300,
            principalId: context.userId,
          });
          sourceIds.push(created.id);
          scheduleArtifactRefresh(created.id).catch(() => {});
        }

        const warnings: string[] = [];
        if (template) {
          const { missingSources, unusedSources } = diffTemplateAndSources(template, sources.map((s) => s.name));
          if (missingSources.length > 0) {
            warnings.push(
              `Template references {{data.${missingSources.join('}}, {{data.')}}} but no source(s) with those names were created — the page will render blank. Call add_artifact_data_source for each missing name, or rewrite the template.`,
            );
          }
          if (unusedSources.length > 0) {
            warnings.push(`Sources [${unusedSources.join(', ')}] are attached but unused by the template.`);
          }
        }
        if (visibility === 'workspace') {
          warnings.push(
            'visibility is `workspace` — the outerUrl returns 404 to anonymous viewers. Pass visibility:"public" if the user wants a shareable link.',
          );
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
          visibility,
          embedUrl: buildArtifactEmbedUrl(a.slug),
          outerUrl: buildArtifactOuterUrl(a.slug),
          sourceIds,
          warnings,
          message: `Artifact "${a.title}" created`,
        };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'update_live_artifact',
      UPDATE_DESCRIPTION,
      createParameterSchema({
        id: { type: 'string', description: 'Artifact id', required: true },
        title: { type: 'string', description: 'New title' },
        visibility: {
          type: 'string',
          description: '`private` | `workspace` (anonymous URL 404s) | `signed` | `public`',
          enum: ['private', 'workspace', 'signed', 'public'],
        },
        html_template: { type: 'string', description: 'New template body. Must reference only `{{data.<name>.…}}` sources that already exist (see list_live_artifacts → sources, or call add_artifact_data_source first).' },
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
        const warnings: string[] = [];
        if (args.html_template !== undefined || args.css !== undefined) {
          const prev = a.currentVersionId ? await artifactsRepository.getVersion(a.currentVersionId) : null;
          const template = (args.html_template as string) ?? prev?.htmlTemplate ?? '';
          const v = await artifactsRepository.createVersion({
            artifactId: a.id,
            htmlTemplate: template,
            css: (args.css as string) ?? prev?.css ?? '',
            changeSummary: (args.change_summary as string) ?? '',
            createdByUserId: context.userId,
          });
          await artifactsRepository.setCurrentVersion(a.id, v.id);
          publishArtifactVersionUpdated(a.id, v.id);
          artifactLifecycleBus.emitEvent({ type: 'artifact:updated', artifactId: a.id, versionId: v.id });

          if (template) {
            const existingSources = await artifactsRepository.listSources(a.id);
            const { missingSources } = diffTemplateAndSources(template, existingSources.map((s) => s.name));
            if (missingSources.length > 0) {
              warnings.push(
                `Template references {{data.${missingSources.join('}}, {{data.')}}} but no source with that name exists on this artifact — the page will render blank until you add it.`,
              );
            }
          }
        }
        const newVisibility = (args.visibility as ArtifactVisibility | undefined) ?? a.visibility;
        return { id: a.id, visibility: newVisibility, warnings, message: 'Artifact updated' };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'add_artifact_data_source',
      'Attach a data source to an artifact. The `name` you pick is what templates and transforms bind to (`{{data.<name>.…}}` / `inputName: "<name>"`). PREFERRED: `kind: "toolbox"` + `tool_id` — discover ids via `art_toolbox_list({ family: "collect" })` / `art_toolbox_search` / `art_toolbox_describe`. Legacy inline kinds (`http`/`rss`/`tool`/`mcp`/`skill_query`) still work for back-compat but should not be used for new sources.',
      createParameterSchema({
        artifact_id: { type: 'string', description: 'Artifact id', required: true },
        name: { type: 'string', description: 'Source name (unique per artifact). Must match the `{{data.<name>.…}}` placeholders in the artifact template, and `inputName` in any transform that feeds off it.', required: true },
        kind: {
          type: 'string',
          description: 'Source kind. Prefer `toolbox` and set `tool_id`.',
          required: true,
          enum: ['toolbox', 'tool', 'http', 'rss', 'mcp', 'skill_query'],
        },
        tool_id: {
          type: 'string',
          description: 'Required when `kind = "toolbox"`. Registered collector id, e.g. `art_collect_http_json`, `art_collect_rss`, `art_collect_html_scrape`. Discover via `art_toolbox_list({ family: "collect" })`.',
        },
        config: {
          type: 'object',
          description:
            'Source params. ' +
            'toolbox: whatever the collector takes — call `art_toolbox_describe({ id: tool_id })` for the parameter schema and a worked example. ' +
            'http: `{ url, method?, headers? }`. ' +
            'rss: `{ url }` (returns `items[]` with title/link/pubDate/summary). ' +
            'tool: `{ tool, params? }`. ' +
            'mcp: `{ server, tool, params? }`. ' +
            'skill_query: `{ skill, prompt }`.',
        },
        refresh_seconds: { type: 'number', description: 'Refresh interval in seconds (default 300, minimum 30). Refresh only runs while the artifact has recent viewers.' },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.artifact_id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };

        const kind = args.kind as ArtifactSourceKind;
        const toolId = typeof args.tool_id === 'string' ? args.tool_id.trim() : '';

        if (kind === 'toolbox') {
          if (!toolId) {
            return { error: 'kind="toolbox" requires tool_id (use art_toolbox_search to find a collector)' };
          }
          const { ensureToolboxLoaded, getToolboxRegistry } = await import('@/core/artifacts/toolbox');
          await ensureToolboxLoaded();
          const tool = getToolboxRegistry().get(toolId);
          if (!tool) {
            return { error: `unknown toolbox tool "${toolId}" — call art_toolbox_search to discover valid ids` };
          }
          if (tool.family !== 'collect') {
            return { error: `tool "${toolId}" is a ${tool.family} tool, not a collector — sources require family="collect"` };
          }
        } else if (toolId) {
          return { error: `tool_id is only valid when kind="toolbox" (got kind="${kind}")` };
        }

        const refreshSeconds = (args.refresh_seconds as number) ?? 300;
        if (typeof refreshSeconds !== 'number' || refreshSeconds < 30) {
          return { error: 'refresh_seconds must be a number ≥ 30' };
        }

        const created = await artifactsRepository.createSource({
          artifactId: a.id,
          name: args.name as string,
          kind,
          toolId: kind === 'toolbox' ? toolId : null,
          configJson: (args.config as Record<string, unknown>) ?? {},
          refreshSeconds,
          principalId: context.userId,
        });
        scheduleArtifactRefresh(created.id).catch(() => {});
        return { id: created.id, name: created.name, kind, toolId: created.toolId ?? null, message: 'Data source attached' };
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

    // ── transforms ──────────────────────────────────────────────
    this.registerTool(
      'add_artifact_transform',
      'Attach a toolbox transform to an artifact. The transform runs at render time over the named upstream source/transform output. Use art_toolbox_search to find a transform id.',
      createParameterSchema({
        artifact_id: { type: 'string', description: 'Artifact id', required: true },
        name: { type: 'string', description: 'Unique transform name (data-bus key). Must be a valid identifier.', required: true },
        tool_id: { type: 'string', description: 'Toolbox transform id, e.g. `art_transform_group_count`.', required: true },
        input_name: { type: 'string', description: 'Upstream source or transform name to feed in.', required: true },
        params: { type: 'object', description: 'Transform-specific parameters.' },
        position: { type: 'number', description: 'Lower runs earlier. Default 0.' },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.artifact_id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };
        const created = await artifactsRepository.createTransform({
          artifactId: a.id,
          name: args.name as string,
          toolId: args.tool_id as string,
          inputName: args.input_name as string,
          paramsJson: (args.params as Record<string, unknown>) ?? {},
          position: (args.position as number) ?? 0,
        });
        return { id: created.id, name: created.name, message: 'Transform attached' };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'remove_artifact_transform',
      'Detach a transform by name.',
      createParameterSchema({
        artifact_id: { type: 'string', description: 'Artifact id', required: true },
        name: { type: 'string', description: 'Transform name to remove', required: true },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.artifact_id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };
        await artifactsRepository.deleteTransformByName(a.id, args.name as string);
        return { ok: true, message: 'Transform removed' };
      },
      { permissionAction: 'write' },
    );

    // ── widgets ────────────────────────────────────────────────
    this.registerTool(
      'add_artifact_widget',
      'Attach a toolbox widget instance. The widget renders into a `<x-widget id="<slot>"/>` placeholder in the template, or into the default CSS-grid layout when no template is set. `bind` maps widget param names to data-bus paths like `"issues.items"`.',
      createParameterSchema({
        artifact_id: { type: 'string', description: 'Artifact id', required: true },
        slot: { type: 'string', description: 'Unique slot id (matches `<x-widget id="..."/>`). Pattern [a-zA-Z0-9_-]+.', required: true },
        tool_id: { type: 'string', description: 'Toolbox widget id, e.g. `art_widget_table`.', required: true },
        bind: { type: 'object', description: 'Map of widget-param-name → data-bus path, e.g. `{ rows: "issues.items" }`.' },
        params: { type: 'object', description: 'Static widget params merged with resolved binds. Set `span` (1-4) to influence the default layout column span.' },
        position: { type: 'number', description: 'Order in the default layout. Default 0.' },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.artifact_id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };
        const created = await artifactsRepository.createWidget({
          artifactId: a.id,
          slot: args.slot as string,
          toolId: args.tool_id as string,
          bindJson: (args.bind as Record<string, string>) ?? {},
          paramsJson: (args.params as Record<string, unknown>) ?? {},
          position: (args.position as number) ?? 0,
        });
        return { id: created.id, slot: created.slot, message: 'Widget attached' };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'remove_artifact_widget',
      'Detach a widget by slot.',
      createParameterSchema({
        artifact_id: { type: 'string', description: 'Artifact id', required: true },
        slot: { type: 'string', description: 'Widget slot to remove', required: true },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.artifact_id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };
        await artifactsRepository.deleteWidgetBySlot(a.id, args.slot as string);
        return { ok: true, message: 'Widget removed' };
      },
      { permissionAction: 'write' },
    );

    // ── exports ────────────────────────────────────────────────
    this.registerTool(
      'add_artifact_export',
      'Register a download exporter on an artifact. Exposes `GET /a/:slug/export/<export_id>`; data is built fresh from sources + transforms on every request. `bind` maps the exporter\'s param names to data-bus paths.',
      createParameterSchema({
        artifact_id: { type: 'string', description: 'Artifact id', required: true },
        export_id: {
          type: 'string',
          description: 'Public id used in the URL. Pattern [a-zA-Z0-9_-]+.',
          required: true,
        },
        tool_id: {
          type: 'string',
          description: 'Toolbox export id, e.g. `art_export_csv`.',
          required: true,
        },
        bind: {
          type: 'object',
          description: 'Map of export-param-name → data-bus path, e.g. `{ rows: "issues.items" }`.',
        },
        params: {
          type: 'object',
          description: 'Static params merged with resolved binds (filename, columns, etc).',
        },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.artifact_id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };
        if (!/^[a-zA-Z0-9_-]+$/.test(args.export_id as string)) {
          return { error: 'export_id must match [a-zA-Z0-9_-]+' };
        }
        const created = await artifactsRepository.createExport({
          artifactId: a.id,
          exportId: args.export_id as string,
          toolId: args.tool_id as string,
          bindJson: (args.bind as Record<string, string>) ?? {},
          paramsJson: (args.params as Record<string, unknown>) ?? {},
        });
        return {
          id: created.id,
          exportId: created.exportId,
          downloadUrl: `${buildArtifactOuterUrl(a.slug)}/export/${created.exportId}`,
          message: 'Export registered',
        };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'remove_artifact_export',
      'Remove a registered export by public id.',
      createParameterSchema({
        artifact_id: { type: 'string', description: 'Artifact id', required: true },
        export_id: { type: 'string', description: 'Public export id', required: true },
      }),
      async (args, context) => {
        const a = await artifactsRepository.getById(args.artifact_id as string);
        if (!a) return { error: 'not found' };
        const workspaceId = await resolveDefaultWorkspaceId(context.userId);
        if (a.workspaceId !== workspaceId) return { error: 'not authorized' };
        await artifactsRepository.deleteExportByPublicId(a.id, args.export_id as string);
        return { ok: true, message: 'Export removed' };
      },
      { permissionAction: 'write' },
    );
  }
}

export const artifactsTool = new ArtifactsTool();
