import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { isAuthenticated, type Principal } from '@/security/principal';

/**
 * Spaces this install's users joined on other installs
 * (docs/plans/federation-spec.md §6.2, §6.3, §8.2, §9).
 *
 *   POST   /api/remote-spaces/join                          — { link, confirm? }: without `confirm`, the
 *                                                             host fingerprint to compare; with it, the join
 *   GET    /api/remote-spaces                               — my pointer rows, link state, pending leaves
 *   GET    /api/remote-spaces/:id                           — one row, refreshed from the host (space.info)
 *   PATCH  /api/remote-spaces/:id                           — { agentAnswersWhenAddressed }
 *   DELETE /api/remote-spaces/:id                           — leave: a tombstone, `space.leave` until acknowledged
 *   GET    /api/remote-spaces/:id/rooms | members | notes | notes/:noteId | tasks | tasks/:taskId
 *          | files (?path=) | files/<path> | rooms/:roomId/messages (?before, after, limit)
 *   POST   /api/remote-spaces/:id/rooms/:roomId/messages    — { content, addressed?, clientId? }
 *   POST   /api/remote-spaces/:id/rooms/:roomId/agent       — my agent's session for the room ("ask my agent")
 *   POST   /api/remote-spaces/:id/notes/:noteId/proposals   — { baseSha256, body, title? }
 *   POST   /api/remote-spaces/:id/tasks                     — { title, notes?, priority? }
 *   POST   /api/remote-spaces/:id/tasks/:taskId/:op         — checkout | release | comment { body }
 *
 * Every route but `join` and the list reads the caller's own live pointer
 * row: another user's row, a left one or an unknown id is the same 404. The
 * host's answer is forwarded as it is; nothing of it is stored here. Needs
 * `federation.mode` visit or both (403 `federation_off` otherwise); an
 * unreachable host is 502.
 */

type Ctx = {
  set: { status?: number | string };
  principal: Principal;
  user: { id: string; username: string } | null;
};

async function handle<T>(ctx: Ctx, run: (user: { id: string; username: string }) => Promise<T>): Promise<T | { error: string; code?: string }> {
  if (!ctx.user || !isAuthenticated(ctx.principal)) {
    ctx.set.status = 401;
    return { error: 'Authentication required' };
  }
  const { RemoteSpaceError } = await import('@/core/federation/visitor-ops');
  try {
    return await run({ id: ctx.principal.userId, username: ctx.user.username });
  } catch (err) {
    if (err instanceof RemoteSpaceError) {
      ctx.set.status = err.status;
      return { error: err.message, code: err.code };
    }
    throw err;
  }
}

async function ops() {
  return import('@/core/federation/visitor-ops');
}

/** Forward `type` for the caller's row `id`. */
async function forwardFor(userId: string, id: string, type: import('@/core/federation/protocol').FederationRequestType, body: Record<string, unknown> = {}) {
  const { forward, ownRemoteSpace } = await ops();
  return forward(await ownRemoteSpace(userId, id), type, body);
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const uuid = () => t.String({ pattern: UUID_PATTERN });
const idParams = t.Object({ id: t.String() });
const tag = { detail: { tags: ['spaces'] } };

export const remoteSpaceRoutes = new Elysia({ prefix: '/remote-spaces' })
  .use(apiContext)

  .post('/join', (ctx) => handle(ctx, async (user) => {
    const { joinPreview, joinRemoteSpace } = await ops();
    // The fingerprint first: nothing is dialled until the user confirmed it.
    if (ctx.body.confirm !== true) {
      const { federationVisits } = await import('@/core/federation/mode');
      return { preview: joinPreview(ctx.body.link), visiting: federationVisits() };
    }
    ctx.set.status = 201;
    return { remoteSpace: await joinRemoteSpace(user, ctx.body.link) };
  }), {
    body: t.Object({ link: t.String({ minLength: 1, maxLength: 2048 }), confirm: t.Optional(t.Boolean()) }),
    ...tag,
  })

  .get('/', (ctx) => handle(ctx, async (user) => (await ops()).listRemoteSpaces(user.id)), tag)

  .get('/:id', (ctx) => handle(ctx, async (user) => {
    const { ownRemoteSpace, refreshRemoteSpace, remoteSpaceView } = await ops();
    try {
      return await refreshRemoteSpace(user.id, ctx.params.id);
    } catch (err) {
      // The host is out of reach: the stored row, marked as not refreshed.
      if ((err as { code?: string }).code !== 'host_unreachable') throw err;
      return { remoteSpace: remoteSpaceView(await ownRemoteSpace(user.id, ctx.params.id)), info: null, refreshError: (err as Error).message };
    }
  }), { params: idParams, ...tag })

  .patch('/:id', (ctx) => handle(ctx, async (user) => {
    const { setAgentAnswersWhenAddressed } = await ops();
    return { remoteSpace: await setAgentAnswersWhenAddressed(user.id, ctx.params.id, ctx.body.agentAnswersWhenAddressed) };
  }), {
    params: idParams,
    body: t.Object({ agentAnswersWhenAddressed: t.Boolean() }),
    ...tag,
  })

  .delete('/:id', (ctx) => handle(ctx, async (user) => (await ops()).leaveRemoteSpace(user.id, ctx.params.id)), { params: idParams, ...tag })

  .get('/:id/rooms', (ctx) => handle(ctx, (user) => forwardFor(user.id, ctx.params.id, 'space.rooms')), { params: idParams, ...tag })

  .get('/:id/members', (ctx) => handle(ctx, (user) => forwardFor(user.id, ctx.params.id, 'space.members')), { params: idParams, ...tag })

  .get('/:id/notes', (ctx) => handle(ctx, (user) => forwardFor(user.id, ctx.params.id, 'note.list')), { params: idParams, ...tag })

  .get('/:id/notes/:noteId', (ctx) => handle(ctx, (user) => forwardFor(user.id, ctx.params.id, 'note.read', { noteId: ctx.params.noteId })), {
    params: t.Object({ id: t.String(), noteId: uuid() }),
    ...tag,
  })

  .post('/:id/notes/:noteId/proposals', (ctx) => handle(ctx, (user) => forwardFor(user.id, ctx.params.id, 'note.propose', {
    noteId: ctx.params.noteId, baseSha256: ctx.body.baseSha256, body: ctx.body.body, ...(ctx.body.title ? { title: ctx.body.title } : {}),
  })), {
    params: t.Object({ id: t.String(), noteId: uuid() }),
    body: t.Object({ baseSha256: t.String({ pattern: '^[0-9a-f]{64}$' }), body: t.String({ maxLength: 1_000_000 }), title: t.Optional(t.String({ minLength: 1, maxLength: 500 })) }),
    ...tag,
  })

  .get('/:id/tasks', (ctx) => handle(ctx, (user) => forwardFor(user.id, ctx.params.id, 'task.list', ctx.query.status ? { status: ctx.query.status } : {})), {
    params: idParams,
    query: t.Object({ status: t.Optional(t.Union([t.Literal('open'), t.Literal('in_progress'), t.Literal('done'), t.Literal('archived')])) }),
    ...tag,
  })

  .get('/:id/tasks/:taskId', (ctx) => handle(ctx, (user) => forwardFor(user.id, ctx.params.id, 'task.read', { taskId: ctx.params.taskId })), {
    params: t.Object({ id: t.String(), taskId: uuid() }),
    ...tag,
  })

  .post('/:id/tasks', (ctx) => handle(ctx, (user) => forwardFor(user.id, ctx.params.id, 'task.create', {
    title: ctx.body.title,
    ...(ctx.body.notes !== undefined ? { notes: ctx.body.notes } : {}),
    ...(ctx.body.priority !== undefined ? { priority: ctx.body.priority } : {}),
  })), {
    params: idParams,
    body: t.Object({ title: t.String({ minLength: 1, maxLength: 500 }), notes: t.Optional(t.String({ maxLength: 10_000 })), priority: t.Optional(t.Number({ minimum: 0, maximum: 3 })) }),
    ...tag,
  })

  .post('/:id/tasks/:taskId/:op', (ctx) => handle(ctx, async (user) => {
    const { op, taskId } = ctx.params;
    if (op === 'comment') {
      if (!ctx.body?.body) {
        ctx.set.status = 400;
        return { error: 'A comment needs a body' };
      }
      return forwardFor(user.id, ctx.params.id, 'task.comment', { taskId, body: ctx.body.body });
    }
    return forwardFor(user.id, ctx.params.id, op === 'checkout' ? 'task.checkout' : 'task.release', { taskId });
  }), {
    params: t.Object({ id: t.String(), taskId: uuid(), op: t.Union([t.Literal('checkout'), t.Literal('release'), t.Literal('comment')]) }),
    body: t.Optional(t.Object({ body: t.Optional(t.String({ minLength: 1, maxLength: 10_000 })) })),
    ...tag,
  })

  .get('/:id/files', (ctx) => handle(ctx, (user) => forwardFor(user.id, ctx.params.id, 'file.list', ctx.query.path ? { path: ctx.query.path } : {})), {
    params: idParams,
    query: t.Object({ path: t.Optional(t.String({ maxLength: 4096 })) }),
    ...tag,
  })

  // `files/<path>`: the rest of the URL, decoded, is the file's path in the space.
  .get('/:id/files/*', (ctx) => handle(ctx, async (user) => {
    const marker = `/remote-spaces/${ctx.params.id}/files/`;
    const pathname = new URL(ctx.request.url).pathname;
    const at = pathname.indexOf(marker);
    const path = at >= 0 ? decodeURIComponent(pathname.slice(at + marker.length)) : '';
    if (!path) {
      ctx.set.status = 400;
      return { error: 'A file path is required' };
    }
    return forwardFor(user.id, ctx.params.id, 'file.read', { path });
  }), { ...tag })

  .get('/:id/rooms/:roomId/messages', (ctx) => handle(ctx, (user) => forwardFor(user.id, ctx.params.id, 'room.page', {
    roomId: ctx.params.roomId,
    ...(ctx.query.before ? { before: ctx.query.before } : {}),
    ...(ctx.query.after ? { after: ctx.query.after } : {}),
    ...(ctx.query.limit ? { limit: ctx.query.limit } : {}),
  })), {
    params: t.Object({ id: t.String(), roomId: uuid() }),
    query: t.Object({
      before: t.Optional(uuid()),
      after: t.Optional(uuid()),
      limit: t.Optional(t.Number({ minimum: 1, maximum: 200 })),
    }),
    ...tag,
  })

  .post('/:id/rooms/:roomId/messages', (ctx) => handle(ctx, async (user) => {
    const { closeHostConn, ownRemoteSpace, postThroughConn } = await ops();
    const row = await ownRemoteSpace(user.id, ctx.params.id);
    // One host-side connection per user for REST posts, closed after each.
    const conn = `rest:${user.id}`;
    try {
      return await postThroughConn(row, conn, ctx.params.roomId, {
        content: ctx.body.content,
        ...(ctx.body.addressed !== undefined ? { addressed: ctx.body.addressed } : {}),
        ...(ctx.body.clientId ? { clientId: ctx.body.clientId } : {}),
      });
    } finally {
      closeHostConn(row, conn);
    }
  }), {
    params: t.Object({ id: t.String(), roomId: uuid() }),
    body: t.Object({ content: t.String({ minLength: 1, maxLength: 20_000 }), addressed: t.Optional(t.Boolean()), clientId: t.Optional(t.String({ minLength: 1, maxLength: 64 })) }),
    ...tag,
  })

  .post('/:id/rooms/:roomId/agent', (ctx) => handle(ctx, async (user) => {
    const { openAgentSession } = await import('@/core/federation/visitor-agent');
    const session = await openAgentSession(user.id, ctx.params.id, ctx.params.roomId);
    return { session: { id: session.id, title: session.title, context: session.context } };
  }), {
    params: t.Object({ id: t.String(), roomId: uuid() }),
    ...tag,
  });
