/**
 * Interactive answers (docs/plans/inline-ui-spec.md §5.7): the source of a
 * block, for the web client that renders the marker line of a reply. Readable
 * by whoever may read the conversation (`inlineUiReader`); anything else is a
 * 404 with no hint whether the block exists. Never cached: a block outlives
 * neither its session nor the reader's access.
 */
import { Elysia } from '@/api/http';
import { inlineUiReader } from '@/core/inline-ui/access';
import { inlineUiRepository } from '@/db/repositories/inline-ui-repository';
import { isAuthenticated } from '@/security/principal';

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
  });
