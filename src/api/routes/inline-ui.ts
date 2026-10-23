/**
 * Interactive answers (docs/plans/inline-ui-spec.md §5.7): the source of a
 * block, for the web client that renders the marker line of a reply. Readable
 * by whoever may read the conversation (`inlineUiReader`); anything else is a
 * 404 with no hint whether the block exists. Never cached: a block outlives
 * neither its session nor the reader's access.
 *
 * `promote` saves a block of the caller's own chat as a live artifact (§7):
 * a static copy that reaches no network, in the workspace the request acts
 * in, private or for the workspace. Not for an answer made after reading
 * untrusted content, and not while an admin acts as the user.
 */
import { Elysia, t } from '@/api/http';
import { buildArtifactAppUrl } from '@/core/artifacts/host';
import { isModuleOn } from '@/core/modules/registry';
import { writeVersion } from '@/core/artifacts/version-writer';
import { inlineUiReader } from '@/core/inline-ui/access';
import { canActInSession } from '@/core/rooms/access';
import { promotedPage, usesOctiBridge } from '@/core/inline-ui/promote';
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import { contentRepos } from '@/db/repositories/content';
import { inlineUiRepository } from '@/db/repositories/inline-ui-repository';
import { uniqueViolation } from '@/db/unique-violation';
import { isAuthenticated } from '@/security/principal';
import { SpaceError } from '@/security/space-access';
import { ARTIFACT_SLUG_RE } from '@/shared/artifacts';
import { coreLogger } from '@/utils/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const inlineUiRoutes = new Elysia({ prefix: '/sessions' })
  .get('/:id/inline-ui/:blockId', async ({ user, principal, params, set }) => {
    set.headers['cache-control'] = 'no-store';
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }
    const notFound = () => { set.status = 404; return { error: 'Interactive answer not found' }; };
    if (!UUID_RE.test(params.id) || !UUID_RE.test(params.blockId)) return notFound();
    const reader = await inlineUiReader(principal, params.id);
    if (!reader) return notFound();
    const block = await inlineUiRepository.getInSession(params.blockId.toLowerCase(), reader.sessionId);
    if (!block) return notFound();
    return {
      block: {
        id: block.id,
        sessionId: block.sessionId,
        title: block.title,
        heightHint: block.heightHint,
        css: block.css,
        html: block.html,
        js: block.js,
        scripts: block.scripts,
        tainted: block.tainted,
        risk: block.risk,
        issues: block.issues,
        shared: reader.shared,
        createdAt: block.createdAt.toISOString(),
      },
    };
  })
  .post(
    '/:id/inline-ui/:blockId/promote',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      if (principal.actorUserId) {
        set.status = 403;
        return { error: 'Saving as an artifact is off while acting as another user.' };
      }
      // Saving as an artifact needs the `artifacts` module (docs/MODULES.md).
      if (!isModuleOn('artifacts')) { set.status = 404; return { error: 'Not found', code: 'module_off', module: 'artifacts' }; }
      const notFound = () => { set.status = 404; return { error: 'Interactive answer not found' }; };
      if (!UUID_RE.test(params.id) || !UUID_RE.test(params.blockId)) return notFound();
      // The caller's own chat: the scoped read every chat route uses, then
      // `canActInSession(…, 'chat')` — the owner only (an admin may read
      // another user's chat, not save from it), never a room.
      const session = await contentRepos(principal).sessions.findById(params.id);
      if (!session || !(await canActInSession(session, principal.userId, 'chat'))) return notFound();
      const block = await inlineUiRepository.getInSession(params.blockId.toLowerCase(), session.id);
      if (!block) return notFound();
      if (block.tainted) {
        set.status = 409;
        return { error: 'This answer was made after reading content from outside, so it cannot be saved as an artifact.' };
      }
      const title = body.title.trim();
      if (!title || title.length > 200) {
        set.status = 400;
        return { error: 'A title of 1–200 characters is required.' };
      }
      if (!ARTIFACT_SLUG_RE.test(body.slug)) {
        set.status = 400;
        return { error: 'invalid slug (lowercase, digits, dashes, 1-64 chars)' };
      }
      if (!principal.workspaceId) {
        set.status = 400;
        return { error: 'No workspace to save into.' };
      }

      const page = promotedPage(block);
      try {
        const artifact = await contentRepos(principal).artifacts.create({
          slug: body.slug,
          createdByAgentId: null,
          title,
          type: 'html',
          visibility: body.visibility ?? 'private',
          network: 'none',
          metadata: { savedFrom: { kind: 'inline-ui', sessionId: session.id, blockId: block.id } },
        });
        const written = await writeVersion({
          artifactId: artifact.id,
          template: page.template,
          css: page.css,
          script: page.script || undefined,
          changeSummary: 'saved from a chat answer',
          userId: principal.userId,
          templateProvided: true,
        });
        set.status = 201;
        return {
          artifact: await artifactsRepository.getById(artifact.id),
          appUrl: buildArtifactAppUrl(artifact.id),
          warnings: written.warnings,
          removed: page.removed,
          bridge: block.scripts && usesOctiBridge(block.js),
        };
      } catch (err) {
        if (err instanceof SpaceError) throw err;
        if (uniqueViolation(err) === 'artifacts_workspace_id_slug_uq') {
          set.status = 409;
          return { error: 'slug already exists in this workspace' };
        }
        coreLogger.error({ err }, 'inline-ui.promote.failed');
        set.status = 500;
        return { error: 'Saving failed' };
      }
    },
    {
      body: t.Object({
        title: t.String(),
        slug: t.String(),
        visibility: t.Optional(t.Union([t.Literal('private'), t.Literal('workspace')])),
      }),
    },
  );
