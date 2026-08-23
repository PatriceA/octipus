/**
 * Live Artifacts REST API. Workspace-scoped CRUD + sources + refresh +
 * versions + share-links. Hosted page routes (`/a/:slug`, `/a/:slug/embed`)
 * live in `artifact-pages.ts` and mount on the artifacts subdomain.
 */

import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import type { Artifact } from '@/db/schema/artifacts';
import { mintShareLink } from '@/core/artifacts/share-link';
import { refreshSource } from '@/core/artifacts/refresh';
import { renderRssFeed } from '@/core/artifacts/render';
import { buildArtifactAppUrl, buildArtifactEmbedUrl, buildArtifactOuterUrl, getArtifactsHostMode, pickShareableUrl } from '@/core/artifacts/host';
import type { ArtifactVisibility as ArtifactVisibilityType } from '@/db/schema/artifacts';
import { coreLogger } from '@/utils/logger';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function ensureWorkspace(principal: { workspaceId?: string | null }): string {
  const wid = principal.workspaceId;
  if (!wid) throw new Error('workspace not resolved');
  return wid;
}

async function loadArtifactScoped(
  id: string,
  workspaceId: string,
): Promise<Artifact | null> {
  const a = await artifactsRepository.getById(id);
  if (!a) return null;
  if (a.workspaceId !== workspaceId) return null; // 404 not 403 — don't leak existence
  return a;
}

/** Resolve by slug *or* id within a workspace. UUID-shaped ids try id first; otherwise slug. */
async function resolveArtifactScoped(
  slugOrId: string,
  workspaceId: string,
): Promise<Artifact | null> {
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    slugOrId,
  );
  if (looksLikeUuid) {
    const byId = await loadArtifactScoped(slugOrId, workspaceId);
    if (byId) return byId;
  }
  return artifactsRepository.getBySlug(workspaceId, slugOrId);
}

export const artifactRoutes = new Elysia({ prefix: '/artifacts' })
  .use(apiContext)

  // ── host mode (for UI to pick the right embed URL) ───────────
  .get('/_meta', () => {
    const mode = getArtifactsHostMode();
    return { mode };
  })

  // ── list / create ────────────────────────────────────────────
  .get(
    '/',
    async ({ user, principal, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const wid = ensureWorkspace(principal);
      const items = await artifactsRepository.listByWorkspace(wid);
      return {
        artifacts: items.map((a) => ({
          ...a,
          embedUrl: buildArtifactEmbedUrl(a.slug),
          outerUrl: buildArtifactOuterUrl(a.slug),
          appUrl: buildArtifactAppUrl(a.id),
          shareUrl: pickShareableUrl({ visibility: a.visibility as ArtifactVisibilityType, slug: a.slug, id: a.id }),
        })),
      };
    },
    { detail: { tags: ['artifacts'] } },
  )
  .post(
    '/',
    async ({ user, principal, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const wid = ensureWorkspace(principal);
      if (!SLUG_RE.test(body.slug)) {
        set.status = 400;
        return { error: 'invalid slug (lowercase, digits, dashes, 1-64 chars)' };
      }
      try {
        const a = await artifactsRepository.create({
          slug: body.slug,
          workspaceId: wid,
          createdByUserId: user.id,
          createdByAgentId: body.createdByAgentId ?? null,
          title: body.title,
          type: body.type,
          visibility: body.visibility ?? 'workspace',
        });
        if (body.htmlTemplate || body.css) {
          const v = await artifactsRepository.createVersion({
            artifactId: a.id,
            htmlTemplate: body.htmlTemplate ?? '',
            css: body.css ?? '',
            changeSummary: 'initial',
            createdByUserId: user.id,
          });
          await artifactsRepository.setCurrentVersion(a.id, v.id);
        }
        set.status = 201;
        return { artifact: await artifactsRepository.getById(a.id) };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('artifacts_workspace_id_slug_uq')) {
          set.status = 409;
          return { error: 'slug already exists in this workspace' };
        }
        coreLogger.error({ err }, 'artifacts.create.failed');
        set.status = 500;
        return { error: 'create failed' };
      }
    },
    {
      body: t.Object({
        slug: t.String(),
        title: t.String(),
        type: t.Union([
          t.Literal('dashboard'),
          t.Literal('table'),
          t.Literal('rss'),
          t.Literal('news'),
          t.Literal('html'),
        ]),
        visibility: t.Optional(
          t.Union([t.Literal('private'), t.Literal('workspace'), t.Literal('signed'), t.Literal('public')]),
        ),
        htmlTemplate: t.Optional(t.String()),
        css: t.Optional(t.String()),
        createdByAgentId: t.Optional(t.String()),
      }),
    },
  )

  // ── full pipeline spec (by slug or id) ───────────────────────
  // GET /api/artifacts/spec/:slugOrId
  // Returns the full wiring needed to drive `art_toolbox_validate`:
  // { artifact, version, sources, transforms, widgets, exports }.
  // Used by agents (QA Path A) and the MCP server.
  .get('/spec/:slugOrId', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const wid = ensureWorkspace(principal);
    const a = await resolveArtifactScoped(params.slugOrId, wid);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    const [sources, transforms, widgets, exports_, version] = await Promise.all([
      artifactsRepository.listSources(a.id),
      artifactsRepository.listTransforms(a.id),
      artifactsRepository.listWidgets(a.id),
      artifactsRepository.listExports(a.id),
      a.currentVersionId ? artifactsRepository.getVersion(a.currentVersionId) : null,
    ]);
    return {
      artifact: {
        id: a.id,
        slug: a.slug,
        title: a.title,
        type: a.type,
        visibility: a.visibility,
        workspaceId: a.workspaceId,
        currentVersionId: a.currentVersionId,
        embedUrl: buildArtifactEmbedUrl(a.slug),
        outerUrl: buildArtifactOuterUrl(a.slug),
        appUrl: buildArtifactAppUrl(a.id),
        shareUrl: pickShareableUrl({ visibility: a.visibility as ArtifactVisibilityType, slug: a.slug, id: a.id }),
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      },
      version: version
        ? {
            id: version.id,
            html_template: version.htmlTemplate,
            css: version.css,
            change_summary: version.changeSummary,
            created_at: version.createdAt,
          }
        : null,
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        tool_id: s.toolId,
        config: s.configJson,
        refresh_seconds: s.refreshSeconds,
        last_status: s.lastStatus,
        last_error: s.lastError,
        last_run_at: s.lastRunAt,
      })),
      transforms: transforms.map((t) => ({
        id: t.id,
        name: t.name,
        tool_id: t.toolId,
        input_name: t.inputName,
        params: t.paramsJson,
        position: t.position,
      })),
      widgets: widgets.map((w) => ({
        id: w.id,
        slot: w.slot,
        tool_id: w.toolId,
        bind: w.bindJson,
        params: w.paramsJson,
        position: w.position,
      })),
      exports: exports_.map((e) => ({
        id: e.id,
        export_id: e.exportId,
        tool_id: e.toolId,
        bind: e.bindJson,
        params: e.paramsJson,
      })),
    };
  })

  // ── single ───────────────────────────────────────────────────
  .get('/:id', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const wid = ensureWorkspace(principal);
    const a = await loadArtifactScoped(params.id, wid);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    const version = a.currentVersionId ? await artifactsRepository.getVersion(a.currentVersionId) : null;
    return {
      artifact: {
        ...a,
        embedUrl: buildArtifactEmbedUrl(a.slug),
        outerUrl: buildArtifactOuterUrl(a.slug),
        appUrl: buildArtifactAppUrl(a.id),
        shareUrl: pickShareableUrl({ visibility: a.visibility as ArtifactVisibilityType, slug: a.slug, id: a.id }),
      },
      currentVersion: version,
    };
  })

  .put(
    '/:id',
    async ({ params, user, principal, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const wid = ensureWorkspace(principal);
      const a = await loadArtifactScoped(params.id, wid);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      const patch: Partial<Artifact> = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.visibility !== undefined) patch.visibility = body.visibility;
      if (body.allowedEmbedOrigins !== undefined) patch.allowedEmbedOrigins = body.allowedEmbedOrigins;
      if (Object.keys(patch).length > 0) await artifactsRepository.update(a.id, patch);

      // Template/css change → new version
      if (body.htmlTemplate !== undefined || body.css !== undefined) {
        const prev = a.currentVersionId ? await artifactsRepository.getVersion(a.currentVersionId) : null;
        const v = await artifactsRepository.createVersion({
          artifactId: a.id,
          htmlTemplate: body.htmlTemplate ?? prev?.htmlTemplate ?? '',
          css: body.css ?? prev?.css ?? '',
          changeSummary: body.changeSummary ?? '',
          createdByUserId: user.id,
        });
        await artifactsRepository.setCurrentVersion(a.id, v.id);
      }
      return { artifact: await artifactsRepository.getById(a.id) };
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        visibility: t.Optional(
          t.Union([t.Literal('private'), t.Literal('workspace'), t.Literal('signed'), t.Literal('public')]),
        ),
        htmlTemplate: t.Optional(t.String()),
        css: t.Optional(t.String()),
        changeSummary: t.Optional(t.String()),
        allowedEmbedOrigins: t.Optional(t.Array(t.String())),
      }),
    },
  )

  .delete('/:id', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const wid = ensureWorkspace(principal);
    const a = await loadArtifactScoped(params.id, wid);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    await artifactsRepository.softDelete(a.id);
    return { ok: true };
  })

  // ── versions ─────────────────────────────────────────────────
  .get('/:id/versions', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const wid = ensureWorkspace(principal);
    const a = await loadArtifactScoped(params.id, wid);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    return { versions: await artifactsRepository.listVersions(a.id) };
  })

  .post(
    '/:id/versions/:versionId/restore',
    async ({ params, user, principal, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const wid = ensureWorkspace(principal);
      const a = await loadArtifactScoped(params.id, wid);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      const target = await artifactsRepository.getVersion(params.versionId);
      if (!target || target.artifactId !== a.id) {
        set.status = 404;
        return { error: 'version not found' };
      }
      const v = await artifactsRepository.createVersion({
        artifactId: a.id,
        htmlTemplate: target.htmlTemplate,
        css: target.css,
        jsBundleSha256: target.jsBundleSha256,
        schemaJson: target.schemaJson,
        changeSummary: `restore from ${target.id}`,
        createdByUserId: user.id,
      });
      await artifactsRepository.setCurrentVersion(a.id, v.id);
      return { artifact: await artifactsRepository.getById(a.id), versionId: v.id };
    },
  )

  // ── data sources ────────────────────────────────────────────
  .get('/:id/data-sources', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const wid = ensureWorkspace(principal);
    const a = await loadArtifactScoped(params.id, wid);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    return { sources: await artifactsRepository.listSources(a.id) };
  })

  .post(
    '/:id/data-sources',
    async ({ params, user, principal, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const wid = ensureWorkspace(principal);
      const a = await loadArtifactScoped(params.id, wid);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      const s = await artifactsRepository.createSource({
        artifactId: a.id,
        name: body.name,
        kind: body.kind,
        configJson: body.config ?? {},
        refreshSeconds: body.refreshSeconds ?? 300,
        // Source's principal defaults to the creating user — vault ACLs apply
        // under their identity at every refresh, never the viewer's.
        principalId: user.id,
      });
      set.status = 201;
      return { source: s };
    },
    {
      body: t.Object({
        name: t.String(),
        kind: t.Union([
          t.Literal('tool'),
          t.Literal('http'),
          t.Literal('rss'),
          t.Literal('mcp'),
          t.Literal('skill_query'),
        ]),
        config: t.Optional(t.Record(t.String(), t.Unknown())),
        refreshSeconds: t.Optional(t.Number()),
      }),
    },
  )

  .delete(
    '/:id/data-sources/:sourceId',
    async ({ params, user, principal, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const wid = ensureWorkspace(principal);
      const a = await loadArtifactScoped(params.id, wid);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      const s = await artifactsRepository.getSource(params.sourceId);
      if (!s || s.artifactId !== a.id) {
        set.status = 404;
        return { error: 'source not found' };
      }
      await artifactsRepository.deleteSource(s.id);
      return { ok: true };
    },
  )

  // ── refresh + data fetch ─────────────────────────────────────
  .post('/:id/refresh', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const wid = ensureWorkspace(principal);
    const a = await loadArtifactScoped(params.id, wid);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    const sources = await artifactsRepository.listSources(a.id);
    const results = await Promise.all(sources.map((s) => refreshSource(s.id)));
    return { refreshed: sources.length, results };
  })

  .get(
    '/:id/data/:sourceName',
    async ({ params, user, principal, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const wid = ensureWorkspace(principal);
      const a = await loadArtifactScoped(params.id, wid);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      const src = await artifactsRepository.getSourceByName(a.id, params.sourceName);
      if (!src) {
        set.status = 404;
        return { error: 'source not found' };
      }
      const snap = await artifactsRepository.getLatestSnapshot(src.id);
      if (!snap) return { payload: null, capturedAt: null };
      return { payload: snap.payloadJson, capturedAt: snap.capturedAt, snapshotId: snap.id };
    },
  )

  // ── share links ──────────────────────────────────────────────
  .post(
    '/:id/share-links',
    async ({ params, user, principal, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const wid = ensureWorkspace(principal);
      const a = await loadArtifactScoped(params.id, wid);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      const minted = await mintShareLink({
        artifactId: a.id,
        createdByUserId: user.id,
        ttlSeconds: body.ttlSeconds ?? 3600,
        scope: body.scope,
      });
      set.status = 201;
      return minted;
    },
    {
      body: t.Object({
        ttlSeconds: t.Optional(t.Number()),
        scope: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
    },
  )

  .get('/:id/share-links', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const wid = ensureWorkspace(principal);
    const a = await loadArtifactScoped(params.id, wid);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    return { links: await artifactsRepository.listShareLinks(a.id) };
  })

  .delete(
    '/:id/share-links/:linkId',
    async ({ params, user, principal, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const wid = ensureWorkspace(principal);
      const a = await loadArtifactScoped(params.id, wid);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      await artifactsRepository.revokeShareLink(params.linkId);
      return { ok: true };
    },
  )

  // ── RSS export ───────────────────────────────────────────────
  .get('/:id/feed.rss', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const wid = ensureWorkspace(principal);
    const a = await loadArtifactScoped(params.id, wid);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    const sources = await artifactsRepository.listSources(a.id);
    const items: Array<{ title: string; link: string; pubDate?: string | null; summary?: string }> = [];
    const seen = new Set<string>();
    for (const s of sources) {
      if (s.kind !== 'rss') continue;
      const snap = await artifactsRepository.getLatestSnapshot(s.id);
      const payload = snap?.payloadJson as { items?: typeof items } | null;
      for (const it of payload?.items ?? []) {
        if (seen.has(it.link)) continue;
        seen.add(it.link);
        items.push(it);
      }
    }
    const xml = renderRssFeed({ title: a.title, link: `artifact:${a.id}`, items });
    set.headers['content-type'] = 'application/rss+xml; charset=utf-8';
    return xml;
  });
