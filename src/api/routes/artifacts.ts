/**
 * Live Artifacts REST API. Workspace-scoped CRUD + sources + refresh +
 * versions + share-links. Hosted page routes (`/a/:slug`, `/a/:slug/embed`)
 * live in `artifact-pages.ts` and mount on the artifacts subdomain.
 */

import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import { contentRepos } from '@/db/repositories/content';
import type { ArtifactStore } from '@/db/repositories/space';
import type { Principal } from '@/security/principal';
import { SpaceError } from '@/security/space-access';
import type { Artifact } from '@/db/schema/artifacts';
import { isEmbedOrigin } from '@/core/artifacts/csp';
import { mintShareLink } from '@/core/artifacts/share-link';
import { publicSlugConflict, slugTakenConflict } from '@/core/artifacts/slug';
import { refreshSource, spaceSourceRefusal } from '@/core/artifacts/refresh';
import { renderRssFeed } from '@/core/artifacts/render';
import { announceVersion, restoreVersion, writeVersion } from '@/core/artifacts/version-writer';
import { buildArtifactAppUrl, buildArtifactEmbedUrl, buildArtifactOuterUrl, getArtifactsHostMode, pickShareableUrl } from '@/core/artifacts/host';
import type { ArtifactVisibility as ArtifactVisibilityType } from '@/db/schema/artifacts';
import { coreLogger } from '@/utils/logger';
import {
  AGENT_REFRESH_MAX_INSTRUCTION_CHARS,
  AGENT_REFRESH_MAX_INTERVAL_MINUTES,
  AGENT_REFRESH_MIN_INTERVAL_MINUTES,
  ARTIFACT_SLUG_RE,
} from '@/shared/artifacts';
import { setAgentRefreshSchedule, startAgentRefresh, toView } from '@/core/artifacts/agent-refresh';
import { artifactRefreshRepository } from '@/db/repositories/artifact-refresh-repository';
import { uniqueViolation } from '@/db/unique-violation';

/**
 * The artifacts of the request's workspace — personal, or the space the
 * member acts in (docs/plans/coworking-spec.md §5.5). `private` artifacts
 * are their creator's only; changes need `write` in a space.
 */
function artifactStore(principal: Principal): ArtifactStore {
  if (!principal.workspaceId) throw new Error('workspace not resolved');
  return contentRepos(principal).artifacts;
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
      const items = await artifactStore(principal).list();
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
      const store = artifactStore(principal);
      if (!ARTIFACT_SLUG_RE.test(body.slug)) {
        set.status = 400;
        return { error: 'invalid slug (lowercase, digits, dashes, 1-64 chars)' };
      }
      const workspaceId = principal.workspaceId as string;
      const visibility = body.visibility ?? 'workspace';
      if (visibility === 'public') {
        const conflict = await publicSlugConflict(workspaceId, body.slug);
        if (conflict) {
          set.status = 409;
          return conflict;
        }
      }
      try {
        const a = await store.create({
          slug: body.slug,
          createdByAgentId: body.createdByAgentId ?? null,
          title: body.title,
          type: body.type,
          visibility,
        });
        const warnings: string[] = [];
        if (body.htmlTemplate || body.css) {
          const written = await writeVersion({
            artifactId: a.id,
            template: body.htmlTemplate ?? '',
            css: body.css ?? '',
            changeSummary: 'initial',
            userId: user.id,
            templateProvided: true,
          });
          warnings.push(...written.warnings);
        }
        set.status = 201;
        return { artifact: await artifactsRepository.getById(a.id), warnings };
      } catch (err) {
        if (err instanceof SpaceError) throw err;
        // The unique index decides, so a create that loses a race to the
        // same slug gets this answer too, not a server error.
        if (uniqueViolation(err) === 'artifacts_workspace_id_slug_uq') {
          set.status = 409;
          return await slugTakenConflict(workspaceId, body.slug, { public: visibility === 'public' });
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
    const a = await artifactStore(principal).resolve(params.slugOrId);
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
    const store = artifactStore(principal);
    const a = await store.findById(params.id);
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
      const store = artifactStore(principal);
      const a = await store.findById(params.id);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      store.assertWrite();
      const badOrigin = body.allowedEmbedOrigins?.find((o: string) => !isEmbedOrigin(o));
      if (badOrigin !== undefined) {
        set.status = 400;
        return { error: `allowedEmbedOrigins: "${badOrigin}" is not an origin (https://host[:port] or https://*.host)` };
      }
      if (body.visibility === 'public' && a.visibility !== 'public') {
        const conflict = await publicSlugConflict(a.workspaceId, a.slug);
        if (conflict) {
          set.status = 409;
          return conflict;
        }
      }
      const patch: Partial<Artifact> = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.visibility !== undefined) patch.visibility = body.visibility;
      if (body.allowedEmbedOrigins !== undefined) patch.allowedEmbedOrigins = body.allowedEmbedOrigins;
      if (Object.keys(patch).length > 0) await artifactsRepository.update(a.id, patch);

      // Template/css change → new version
      const warnings: string[] = [];
      if (body.htmlTemplate !== undefined || body.css !== undefined) {
        const prev = a.currentVersionId ? await artifactsRepository.getVersion(a.currentVersionId) : null;
        const written = await writeVersion({
          artifactId: a.id,
          template: body.htmlTemplate ?? prev?.htmlTemplate ?? '',
          css: body.css ?? prev?.css ?? '',
          changeSummary: body.changeSummary ?? '',
          userId: user.id,
          previousVersionId: prev?.id,
          templateProvided: body.htmlTemplate !== undefined,
        });
        warnings.push(...written.warnings);
        announceVersion(a.id, written.versionId);
      }
      return { artifact: await artifactsRepository.getById(a.id), warnings };
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
    const store = artifactStore(principal);
    const a = await store.findById(params.id);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    store.assertWrite();
    await artifactsRepository.softDelete(a.id);
    return { ok: true };
  })

  // ── versions ─────────────────────────────────────────────────
  .get('/:id/versions', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const store = artifactStore(principal);
    const a = await store.findById(params.id);
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
      const store = artifactStore(principal);
      const a = await store.findById(params.id);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      store.assertWrite();
      const target = await artifactsRepository.getVersion(params.versionId);
      if (!target || target.artifactId !== a.id) {
        set.status = 404;
        return { error: 'version not found' };
      }
      const { versionId } = await restoreVersion({ artifactId: a.id, target, userId: user.id });
      announceVersion(a.id, versionId);
      return { artifact: await artifactsRepository.getById(a.id), versionId };
    },
  )

  // ── data sources ────────────────────────────────────────────
  .get('/:id/data-sources', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const store = artifactStore(principal);
    const a = await store.findById(params.id);
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
      const store = artifactStore(principal);
      const a = await store.findById(params.id);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      store.assertWrite();
      const refusal = spaceSourceRefusal(body.kind, principal.workspaceKind === 'shared');
      if (refusal) {
        set.status = 400;
        return { error: refusal };
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
      const store = artifactStore(principal);
      const a = await store.findById(params.id);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      store.assertWrite();
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
    const store = artifactStore(principal);
    const a = await store.findById(params.id);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    store.assertWrite();
    const sources = await artifactsRepository.listSources(a.id);
    const results = await Promise.all(sources.map((s) => refreshSource(s.id)));
    return { refreshed: sources.length, results };
  })

  // ── agent refresh (docs/ARTIFACTS.md#agent-refresh) ──────────
  // The owner's only: a run spends the owner's budget as the owner, so a
  // workspace member who may view or even edit the artifact gets 403 here.
  .get('/:id/agent-refresh', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const a = await artifactStore(principal).findById(params.id);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    if (a.createdByUserId !== user.id) {
      set.status = 403;
      return { error: 'only the artifact\'s owner can see or change its agent refresh', code: 'not_owner' };
    }
    const row = await artifactRefreshRepository.get(a.id);
    return { refresh: row ? toView(row) : null };
  })

  .put(
    '/:id/agent-refresh',
    async ({ params, user, principal, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const store = artifactStore(principal);
      const a = await store.findById(params.id);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      store.assertWrite();
      if (a.createdByUserId !== user.id) {
        set.status = 403;
        return { error: 'only the artifact\'s owner can see or change its agent refresh', code: 'not_owner' };
      }
      // Nothing is stored for an artifact the refresh could never run on.
      if (principal.workspaceKind === 'shared') {
        set.status = 400;
        return { error: 'agent refresh runs as your personal agent, so it is not available on an artifact in a shared space', code: 'refresh_unavailable' };
      }
      const interval = body.intervalMinutes;
      if (interval !== undefined && interval !== null && (!Number.isInteger(interval) || interval < AGENT_REFRESH_MIN_INTERVAL_MINUTES || interval > AGENT_REFRESH_MAX_INTERVAL_MINUTES)) {
        set.status = 400;
        return { error: `intervalMinutes must be a whole number from ${AGENT_REFRESH_MIN_INTERVAL_MINUTES} to ${AGENT_REFRESH_MAX_INTERVAL_MINUTES}, or null for manual refresh only` };
      }
      if (body.instruction !== undefined) {
        const instruction = body.instruction.trim();
        if (!instruction || instruction.length > AGENT_REFRESH_MAX_INSTRUCTION_CHARS) {
          set.status = 400;
          return { error: `instruction must be 1-${AGENT_REFRESH_MAX_INSTRUCTION_CHARS} characters` };
        }
        // Saved by the owner: no longer the agent's unreviewed suggestion.
        await artifactRefreshRepository.setInstruction(a.id, user.id, instruction, 'owner');
      }
      const existing = await artifactRefreshRepository.get(a.id);
      if (!existing && ((interval !== undefined && interval !== null) || body.knowledgeAccess === true)) {
        set.status = 400;
        return { error: 'set a refresh instruction first' };
      }
      if (existing && body.knowledgeAccess !== undefined) {
        await artifactRefreshRepository.setKnowledgeAccess(a.id, body.knowledgeAccess);
      }
      if (existing && interval !== undefined) await setAgentRefreshSchedule(a.id, interval);
      const row = await artifactRefreshRepository.get(a.id);
      return { refresh: row ? toView(row) : null };
    },
    {
      body: t.Object({
        instruction: t.Optional(t.String()),
        intervalMinutes: t.Optional(t.Union([t.Number(), t.Null()])),
        knowledgeAccess: t.Optional(t.Boolean()),
      }),
    },
  )

  .post('/:id/agent-refresh/run', async ({ params, user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    const store = artifactStore(principal);
    const a = await store.findById(params.id);
    if (!a) {
      set.status = 404;
      return { error: 'not found' };
    }
    store.assertWrite();
    if (a.createdByUserId !== user.id) {
      set.status = 403;
      return { error: 'only the artifact\'s owner can refresh it with an agent', code: 'not_owner' };
    }
    const started = await startAgentRefresh(a.id, 'user');
    if (started.status === 'busy') {
      set.status = 409;
      return { error: 'a refresh of this artifact is already running', code: 'refresh_in_flight' };
    }
    if (started.status === 'capacity') {
      set.status = 429;
      return { error: 'the server is already running its maximum of agent refreshes; try again in a few minutes', code: 'refresh_capacity' };
    }
    if (started.status === 'unavailable') {
      set.status = 400;
      return { error: started.error, code: 'refresh_unavailable' };
    }
    if (started.status === 'refused') {
      set.status = 422;
      return { error: started.error, code: 'refresh_refused' };
    }
    // Not awaited: an agent run takes minutes. The row shows its progress.
    void started.done;
    set.status = 202;
    return { status: 'started' };
  })

  .get(
    '/:id/data/:sourceName',
    async ({ params, user, principal, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const store = artifactStore(principal);
      const a = await store.findById(params.id);
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
      const store = artifactStore(principal);
      const a = await store.findById(params.id);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      store.assertWrite();
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
    const store = artifactStore(principal);
    const a = await store.findById(params.id);
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
      const store = artifactStore(principal);
      const a = await store.findById(params.id);
      if (!a) {
        set.status = 404;
        return { error: 'not found' };
      }
      store.assertWrite();
      // Only a link of this artifact: the id alone would revoke anyone's.
      const links = await artifactsRepository.listShareLinks(a.id);
      if (!links.some((l) => l.id === params.linkId)) {
        set.status = 404;
        return { error: 'share link not found' };
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
    const store = artifactStore(principal);
    const a = await store.findById(params.id);
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
